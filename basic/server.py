"""Basic API router and lifecycle hooks; the application lives in satgpt_backend."""
import asyncio
import os
import logging
import time
from io import BytesIO
from typing import Any, Optional
from contextlib import asynccontextmanager

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from starlette.applications import Starlette

# 本地模块
from satgpt_config import load_project_env, required_env, validate_config

load_project_env()
from .gee_service import gee_service, get_flood_images
from .gee_code_generator import generate_flood_gee_code
from harness.app.identity import owner_for
from .business_layer_store import get_business_layer, resolve_business_layers, upsert_business_layers
from .flood_api_services import (
    get_agent_raster_download_file,
    thin_geojson_geometry,
)
logger = logging.getLogger(__name__)
from .preset_layers import get_preset_layer_payload

_HEAVY_OPERATION_LIMIT = max(1, int(required_env("SATGPT_HEAVY_CONCURRENCY")))
_HEAVY_QUEUE_TIMEOUT_SECONDS = max(
    1.0,
    float(required_env("SATGPT_HEAVY_QUEUE_TIMEOUT_SECONDS")),
)
_HEAVY_OPERATION_SEMAPHORE = asyncio.Semaphore(_HEAVY_OPERATION_LIMIT)


async def _run_heavy_operation(function, *args, **kwargs):
    try:
        await asyncio.wait_for(
            _HEAVY_OPERATION_SEMAPHORE.acquire(),
            timeout=_HEAVY_QUEUE_TIMEOUT_SECONDS,
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="The analysis queue is full. Please retry shortly.",
            headers={"Retry-After": "5"},
        ) from exc

    try:
        return await run_in_threadpool(function, *args, **kwargs)
    finally:
        _HEAVY_OPERATION_SEMAPHORE.release()


def _duration_ms(started_at: float) -> float:
    return round((time.perf_counter() - started_at) * 1000, 1)


def _rounded(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return round(float(value), 6)


def _summarize_geojson(geojson: Optional[dict]) -> Optional[dict]:
    if not isinstance(geojson, dict):
        return None

    geometry = geojson.get("geometry") if geojson.get("type") == "Feature" else geojson
    if not isinstance(geometry, dict):
        return {"type": geojson.get("type") or "unknown"}

    summary = {
        "type": geometry.get("type") or "unknown",
    }

    if geometry.get("type") == "FeatureCollection":
        summary["feature_count"] = len(geometry.get("features") or [])
    elif geometry.get("type") == "GeometryCollection":
        summary["geometry_count"] = len(geometry.get("geometries") or [])
    elif geometry.get("type") == "Polygon":
        summary["ring_count"] = len(geometry.get("coordinates") or [])
    elif geometry.get("type") == "MultiPolygon":
        summary["polygon_count"] = len(geometry.get("coordinates") or [])

    return summary


def _summarize_flood_image_request(request: "FloodImageRequest") -> dict:
    return {
        "pre_date": request.pre_date,
        "peek_date": request.peek_date,
        "after_date": request.after_date,
        "imagery_start_date": request.imagery_start_date,
        "imagery_end_date": request.imagery_end_date,
        "longitude": _rounded(request.longitude),
        "latitude": _rounded(request.latitude),
        "has_bounds": bool(request.bounds),
        "bounds": {
            "west": _rounded(request.bounds.west),
            "south": _rounded(request.bounds.south),
            "east": _rounded(request.bounds.east),
            "north": _rounded(request.bounds.north),
        } if request.bounds else None,
        "has_geojson": bool(request.geojson),
        "geojson": _summarize_geojson(request.geojson),
    }


@asynccontextmanager
async def lifespan(app: Starlette):
    """Initialize GEE off the HTTP event loop; configuration is not authentication."""
    validate_config("basic")
    app.state.basic_initialized = False
    global _HEAVY_OPERATION_SEMAPHORE
    _HEAVY_OPERATION_SEMAPHORE = asyncio.Semaphore(_HEAVY_OPERATION_LIMIT)
    await asyncio.to_thread(gee_service._initialize_ee)
    app.state.basic_initialized = True
    try:
        yield
    finally:
        app.state.basic_initialized = False
        gee_service.initialized = False


router = APIRouter()

# ============== 数据模型 ==============

class GeoBounds(BaseModel):
    """地理边界"""
    west: float
    south: float
    east: float
    north: float


class FloodImageRequest(BaseModel):
    """洪水影像请求"""
    pre_date: Optional[str] = None
    peek_date: Optional[str] = None
    after_date: Optional[str] = None
    imagery_start_date: Optional[str] = None
    imagery_end_date: Optional[str] = None
    longitude: float
    latitude: float
    buffer_km: Optional[float] = 50
    bounds: Optional[GeoBounds] = None
    geojson: Optional[dict] = None


class BusinessLayerRecord(BaseModel):
    id: str
    label: Optional[str] = None
    kind: Optional[str] = None
    source: Optional[str] = None
    geometry_type: Optional[str] = None
    bounds: Optional[dict] = None
    center: Optional[dict] = None
    geojson: Optional[dict] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    is_active: Optional[bool] = None
    origin: Optional[str] = None
    layer_role: Optional[str] = None


class BusinessLayerUpsertRequest(BaseModel):
    store_namespace: Optional[str] = "business_layer_store"
    store_key: str
    layers: list[BusinessLayerRecord]


class BusinessLayerResolveRequest(BaseModel):
    store_namespace: Optional[str] = "business_layer_store"
    store_key: str
    layer_ids: list[str]


async def _get_request_payload(request: Request) -> dict:
    if request.method == "POST":
        payload = await request.json()
        return payload if isinstance(payload, dict) else {}
    return dict(request.query_params)


def _ensure_gee_ready() -> None:
    if not gee_service.initialized:
        raise HTTPException(
            status_code=503,
            detail="GEE service is not initialized. Check your Earth Engine credentials.",
        )


# ============== API 端点 ==============

@router.get("/")
async def root():
    """健康检查"""
    return {
        "status": "running",
        "service": "Flood Agent API",
        "gee_initialized": gee_service.initialized
    }


async def health():
    """健康检查端点"""
    return {
        "status": "ok" if gee_service.initialized else "degraded",
        "service": "flood-agent",
        "gee_initialized": gee_service.initialized,
        "model_key_configured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "model_authentication": "not_checked",
        "gee_max_concurrency": _HEAVY_OPERATION_LIMIT,
    }


@router.post("/api/preset-layers")
async def get_preset_layer(request: Request):
    _ensure_gee_ready()
    try:
        payload = await _get_request_payload(request)
        return await _run_heavy_operation(get_preset_layer_payload, payload)
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception:
        logger.warning('Preset layer generation failed', exc_info=False)
        raise HTTPException(status_code=502, detail='Unable to generate this layer. Check the study area and dates, then retry.')


@router.post("/api/agent-raster-download-file")
async def download_agent_raster_file(request: Request):
    _ensure_gee_ready()
    try:
        payload = await _get_request_payload(request)
        content, filename, scale = await _run_heavy_operation(get_agent_raster_download_file, payload)
        safe_filename = filename.replace('"', "")
        return StreamingResponse(
            BytesIO(content),
            media_type="image/tiff",
            headers={
                "Content-Disposition": f'attachment; filename="{safe_filename}"',
                "Content-Length": str(len(content)),
                "X-SatGPT-Raster-Scale": str(scale),
            },
        )
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/flood-images")
async def get_flood_imagery(request: FloodImageRequest):
    request_started_at = time.perf_counter()
    request_summary = _summarize_flood_image_request(request)
    logger.info("[flood-images] request:start summary=%s", request_summary)

    has_imagery_window = bool(request.imagery_start_date and request.imagery_end_date)
    if bool(request.imagery_start_date) != bool(request.imagery_end_date):
        raise HTTPException(status_code=400, detail="Both imagery_start_date and imagery_end_date are required.")
    if has_imagery_window and request.imagery_start_date > request.imagery_end_date:
        raise HTTPException(status_code=400, detail="imagery_start_date must not be after imagery_end_date.")
    if not has_imagery_window and not all((request.pre_date, request.peek_date, request.after_date)):
        raise HTTPException(status_code=400, detail="Flood imagery requires pre_date, peek_date, and after_date.")

    """
    获取洪水事件的卫星影像
    支持三种区域定义方式：
    1. geojson - GeoJSON 边界（最精确）
    2. bounds - 边界框
    3. longitude/latitude + buffer_km - 中心点 + 缓冲区
    """
    if not gee_service.initialized:
        raise HTTPException(
            status_code=503,
            detail="GEE service is not initialized. Check your Earth Engine credentials."
        )

    try:
        # 复杂 AOI（如大型流域边界，数万顶点）会让 GEE 的 filterBounds/clip 显著变慢，
        # 影像展示对边界精度要求低，统一抽稀到 64KB 预算内以加速检索与瓦片渲染。
        if request.geojson:
            request.geojson = thin_geojson_geometry(request.geojson)

        # 优先使用 geojson，其次 bounds，最后使用中心点
        if request.imagery_start_date and request.imagery_end_date and request.geojson:
            result = await _run_heavy_operation(
                gee_service.get_imagery_window_by_geojson,
                start_date=request.imagery_start_date,
                end_date=request.imagery_end_date,
                geojson=request.geojson,
                center=(request.longitude, request.latitude),
            )
        elif request.imagery_start_date and request.imagery_end_date and request.bounds:
            bounds_dict = {
                "west": request.bounds.west,
                "south": request.bounds.south,
                "east": request.bounds.east,
                "north": request.bounds.north,
            }
            result = await _run_heavy_operation(
                gee_service.get_imagery_window_by_bounds,
                start_date=request.imagery_start_date,
                end_date=request.imagery_end_date,
                bounds=bounds_dict,
                center=(request.longitude, request.latitude),
            )
        elif request.imagery_start_date and request.imagery_end_date:
            result = await _run_heavy_operation(
                gee_service.get_imagery_window,
                start_date=request.imagery_start_date,
                end_date=request.imagery_end_date,
                center=(request.longitude, request.latitude),
                buffer_km=request.buffer_km or 50,
            )
        elif request.geojson:
            result = await _run_heavy_operation(
                gee_service.get_flood_imagery_by_geojson,
                pre_date=request.pre_date,
                peek_date=request.peek_date,
                after_date=request.after_date,
                geojson=request.geojson,
                center=(request.longitude, request.latitude)
            )
        elif request.bounds:
            bounds_dict = {
                "west": request.bounds.west,
                "south": request.bounds.south,
                "east": request.bounds.east,
                "north": request.bounds.north
            }
            result = await _run_heavy_operation(
                gee_service.get_flood_imagery_by_bounds,
                pre_date=request.pre_date,
                peek_date=request.peek_date,
                after_date=request.after_date,
                bounds=bounds_dict,
                center=(request.longitude, request.latitude)
            )
        else:
            result = await _run_heavy_operation(
                get_flood_images,
                pre_date=request.pre_date,
                peek_date=request.peek_date,
                after_date=request.after_date,
                longitude=request.longitude,
                latitude=request.latitude
            )
        logger.info(
            "[flood-images] request:success duration_ms=%s summary=%s",
            _duration_ms(request_started_at),
            request_summary,
        )
        return {
            "success": True,
            "data": result
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "[flood-images] request:error duration_ms=%s summary=%s error=%s",
            _duration_ms(request_started_at),
            request_summary,
            str(e),
        )
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/gee-status")
async def gee_status():
    """
    检查 GEE 服务状态
    """
    return {
        "initialized": gee_service.initialized,
        "message": "GEE service is initialized" if gee_service.initialized else "GEE service is not initialized"
    }


class GEECodeRequest(BaseModel):
    """GEE 代码生成请求"""
    event: str
    pre_date: str
    peek_date: str
    location: Optional[str] = None
    coordinates: Optional[list] = None
    bounds: Optional[GeoBounds] = None
    geojson: Optional[dict] = None
    days_range: Optional[int] = 15


@router.post("/api/gee-code")
async def generate_gee_code(request: GEECodeRequest):
    """
    生成可在 GEE Code Editor 中运行的 JavaScript 代码
    """
    try:
        bounds_dict = None
        if request.bounds:
            bounds_dict = {
                "west": request.bounds.west,
                "south": request.bounds.south,
                "east": request.bounds.east,
                "north": request.bounds.north,
            }

        code = await run_in_threadpool(
            generate_flood_gee_code,
            event_name=request.event,
            pre_date=request.pre_date,
            peek_date=request.peek_date,
            location=request.location or "",
            coordinates=request.coordinates,
            bounds=bounds_dict,
            geojson=request.geojson,
            days_range=request.days_range or 15,
        )
        return {"success": True, "code": code}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class FloodImpactRequest(BaseModel):
    """洪水损失评估请求"""
    pre_date: str
    peek_date: str
    bounds: Optional[GeoBounds] = None
    geojson: Optional[dict] = None


@router.post("/api/flood-impact")
async def get_flood_impact(request: FloodImpactRequest):
    """
    获取洪水损失评估
    
    基于开源数据评估洪水影响：
    - WorldPop: 受影响人口
    - ESA WorldCover: 受影响土地覆盖类型
    - GHSL: 受影响城市建成区
    
    支持两种区域定义方式：
    1. geojson - GeoJSON 边界（最精确）
    2. bounds - 边界框
    """
    if not gee_service.initialized:
        raise HTTPException(
            status_code=503,
            detail="GEE service is not initialized. Check your Earth Engine credentials."
        )
    
    try:
        if request.geojson:
            result = await _run_heavy_operation(
                gee_service.get_flood_impact_by_geojson,
                pre_date=request.pre_date,
                peek_date=request.peek_date,
                geojson=request.geojson
            )
        elif request.bounds:
            bounds_dict = {
                "west": request.bounds.west,
                "south": request.bounds.south,
                "east": request.bounds.east,
                "north": request.bounds.north
            }
            result = await _run_heavy_operation(
                gee_service.get_flood_impact_by_bounds,
                pre_date=request.pre_date,
                peek_date=request.peek_date,
                bounds=bounds_dict
            )
        else:
            raise HTTPException(
                status_code=400,
                detail="Provide either bounds or geojson"
            )
        
        if "error" in result:
            raise HTTPException(status_code=500, detail=result["error"])
        
        return {
            "success": True,
            "data": result
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/business-layers/upsert")
async def upsert_business_layer_records(request: BusinessLayerUpsertRequest, http_request: Request):
    saved_layers = upsert_business_layers(
        owner_id=owner_for(http_request),
        store_namespace=request.store_namespace,
        store_key=request.store_key,
        layers=[layer.model_dump() for layer in request.layers],
    )
    return {"success": True, "data": saved_layers}


@router.get("/api/business-layers/{layer_id}")
async def get_business_layer_record(
    http_request: Request,
    layer_id: str,
    store_key: str,
    store_namespace: str = "business_layer_store",
):
    layer = get_business_layer(
        owner_id=owner_for(http_request),
        layer_id=layer_id,
        store_namespace=store_namespace,
        store_key=store_key,
    )
    if not layer:
        raise HTTPException(status_code=404, detail="Business layer not found.")
    return {"success": True, "data": layer}


@router.post("/api/business-layers/batch-resolve")
async def batch_resolve_business_layers(request: BusinessLayerResolveRequest, http_request: Request):
    layers = resolve_business_layers(
        owner_id=owner_for(http_request),
        layer_ids=request.layer_ids,
        store_namespace=request.store_namespace,
        store_key=request.store_key,
    )
    if len(layers) != len(request.layer_ids):
        raise HTTPException(status_code=404, detail="Business layer not found.")
    return {"success": True, "data": layers}

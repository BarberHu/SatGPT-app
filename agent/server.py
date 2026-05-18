"""
FastAPI 后端服务 - 集成 CopilotKit 和 LangGraph
使用 LangGraphAGUIAgent 作为智能体与 CopilotKit 的连接方式
"""
import os
import logging
import time
import warnings
from typing import Any, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from pydantic.warnings import UnsupportedFieldAttributeWarning
import uvicorn

# CopilotKit AG-UI 集成
from copilotkit import LangGraphAGUIAgent
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from ag_ui.core import RunStartedEvent

# 本地模块
from flood_agent import graph
from gee_service import gee_service, get_flood_images
from gee_code_generator import generate_flood_gee_code
from flood_dataset_service import build_confirmation_context, renderer
from flood_aoi import search_location_candidates
from business_layer_store import get_business_layer, resolve_business_layers, upsert_business_layers
from flood_api_services import (
    build_script_pdf,
    get_agent_raster_layers_payload,
    get_chatgpt_response,
    get_code_response,
    get_default_map_payload,
    get_flood_hotspot_map_payload,
    get_historical_map_payload,
    get_latest_script,
    get_unsupervised_map_payload,
    get_water_regime_change_map_payload,
    remember_latest_script,
)
from project_env import load_project_env

logger = logging.getLogger(__name__)


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


# 继承 LangGraphAGUIAgent，只覆写 prepare_stream 一个方法来修 bug
class PatchedLangGraphAGUIAgent(LangGraphAGUIAgent):

    # 覆写 prepare_stream 方法
    # 原始调用链: _handle_stream_events() 调用 prepare_stream() 拿到结果
    #   _handle_stream_events 里会先无条件 yield 一个 RunStartedEvent
    #   然后把 prepare_stream 返回的 events_to_dispatch 列表里的事件逐个 yield
    #   但 prepare_stream 在"有中断且没有resume"时，往 events_to_dispatch 里也塞了一个 RunStartedEvent
    #   结果就是两个 RunStartedEvent 被 yield 出去 → 协议违规 → 崩溃
    async def prepare_stream(self, input, agent_state, config):

        # 第1步: 调用父类的原始 prepare_stream，拿到它的返回结果
        # 返回值是一个 dict，可能包含:
        #   - "stream": 正常对话时的事件流
        #   - "events_to_dispatch": 有中断时的预置事件列表（里面有多余的 RunStartedEvent）
        #   - "state", "config": 其他状态
        result = await super().prepare_stream(input, agent_state, config)

        # 第2步: 取出 events_to_dispatch 列表
        # 只有在"图中有未完成的 interrupt 且用户没发 resume"时，这个列表才存在
        # 此时列表内容是: [RunStartedEvent, CustomEvent(interrupt数据), RunFinishedEvent]
        events_to_dispatch = result.get("events_to_dispatch")

        # 第3步: 如果列表存在，过滤掉里面的 RunStartedEvent
        if events_to_dispatch:
            # 用列表推导式，只保留"不是 RunStartedEvent 类型"的事件
            # 过滤后列表变成: [CustomEvent(interrupt数据), RunFinishedEvent]
            # 这样 _handle_stream_events 那边只有它自己发的那一个 RunStartedEvent，不会重复
            result["events_to_dispatch"] = [
                e for e in events_to_dispatch if not isinstance(e, RunStartedEvent)
            ]

        # 第4步: 把修改后的结果返回给 _handle_stream_events
        # 最终事件流变成: RunStartedEvent(来自148行) → interrupt → RunFinishedEvent ✅
        return result

load_project_env()
warnings.filterwarnings("ignore", category=UnsupportedFieldAttributeWarning)

# 配置代理
http_proxy = os.getenv("HTTP_PROXY")
https_proxy = os.getenv("HTTPS_PROXY")
if http_proxy:
    os.environ["HTTP_PROXY"] = http_proxy
if https_proxy:
    os.environ["HTTPS_PROXY"] = https_proxy


def _get_allowed_cors_origins() -> list[str]:
    frontend_port = os.getenv("FRONTEND_PORT", "3000")
    public_host = os.getenv("SATGPT_PUBLIC_HOST", "localhost").strip() or "localhost"
    origins = {
        f"http://localhost:{frontend_port}",
        f"http://127.0.0.1:{frontend_port}",
    }

    configured = os.getenv("SATGPT_CORS_ORIGINS", "").strip()
    if configured:
        origins.update(origin.strip() for origin in configured.split(",") if origin.strip())

    if public_host not in {"localhost", "127.0.0.1", "0.0.0.0"}:
        origins.add(f"http://{public_host}:{frontend_port}")

    return sorted(origins)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    print("[INFO] Flood agent service starting...")
    yield
    print("[INFO] Flood agent service stopped.")


# 创建 FastAPI 应用
app = FastAPI(
    title="Flood Agent API",
    description="洪水智能体后端服务 - 提供洪水事件分析和遥感影像获取",
    version="1.0.0",
    lifespan=lifespan
)

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=_get_allowed_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============== CopilotKit AG-UI 集成 ==============

# 使用 LangGraphAGUIAgent 添加端点
add_langgraph_fastapi_endpoint(
    app=app,
    agent=PatchedLangGraphAGUIAgent(
        name="flood_agent",
        description="洪水事件分析智能体，可以查询洪水事件信息、提取关键日期、生成洪水报告",
        graph=graph,
    ),
    path="/agent",
)


# ============== 数据模型 ==============

class GeoBounds(BaseModel):
    """地理边界"""
    west: float
    south: float
    east: float
    north: float


class FloodImageRequest(BaseModel):
    """洪水影像请求"""
    pre_date: str
    peek_date: str
    after_date: str
    longitude: float
    latitude: float
    buffer_km: Optional[float] = 50
    bounds: Optional[GeoBounds] = None
    geojson: Optional[dict] = None


class FloodState(BaseModel):
    """洪水状态（用于前端共享）"""
    event: Optional[str] = None
    event_description: Optional[str] = None
    flood_report: Optional[str] = None
    pre_date: Optional[str] = None
    after_date: Optional[str] = None
    peek_date: Optional[str] = None
    location: Optional[str] = None
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    bounds: Optional[GeoBounds] = None
    geojson: Optional[dict] = None
    resolved_aoi: Optional[dict] = None
    aoi_resolution_meta: Optional[dict] = None
    confirmed_aoi: Optional[dict] = None
    recommended_layers: Optional[list[dict]] = None
    selected_layer_ids: Optional[list[str]] = None
    confirmation_version: Optional[int] = None
    mentioned_layer_refs: Optional[list[dict]] = None
    mentioned_aoi: Optional[dict] = None
    mentioned_aoi_source: Optional[str] = None


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


class ChatRequest(BaseModel):
    message: str


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


def _ensure_openai_ready() -> None:
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="OpenAI API key is not configured.",
        )


# ============== API 端点 ==============

@app.get("/")
async def root():
    """健康检查"""
    return {
        "status": "running",
        "service": "Flood Agent API",
        "gee_initialized": gee_service.initialized
    }


@app.get("/health")
async def health():
    """健康检查端点"""
    return {
        "status": "ok",
        "service": "flood-agent",
        "gee_initialized": gee_service.initialized
    }


@app.get("/api/maps/default")
async def get_default_map():
    _ensure_gee_ready()
    try:
        return get_default_map_payload()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/maps/unsupervised")
async def get_unsupervised_map(request: Request):
    _ensure_gee_ready()
    try:
        return get_unsupervised_map_payload(await _get_request_payload(request))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/maps/historical")
async def get_historical_map(request: Request):
    _ensure_gee_ready()
    try:
        return get_historical_map_payload(await _get_request_payload(request))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/maps/flood-hotspot")
async def get_flood_hotspot_map(request: Request):
    _ensure_gee_ready()
    try:
        return get_flood_hotspot_map_payload(await _get_request_payload(request))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/maps/water-regime-change")
async def get_water_regime_change_map(request: Request):
    _ensure_gee_ready()
    try:
        return get_water_regime_change_map_payload(await _get_request_payload(request))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/agent-raster-layers")
async def get_agent_raster_layers(request: Request):
    _ensure_gee_ready()
    try:
        return get_agent_raster_layers_payload(await _get_request_payload(request))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat")
async def chat(request: ChatRequest):
    _ensure_openai_ready()
    chatgpt_response = get_chatgpt_response(request.message)
    if not chatgpt_response:
        raise HTTPException(status_code=500, detail="Error with ChatGPT.")
    return {"message": chatgpt_response}


@app.post("/api/scripts/gee")
async def get_script(request: ChatRequest):
    _ensure_openai_ready()
    code_snippet = get_code_response(request.message)
    if not code_snippet:
        raise HTTPException(status_code=500, detail="Error with ChatGPT.")
    remember_latest_script(code_snippet)
    return {"message": code_snippet}


@app.get("/api/scripts/pdf")
async def get_pdf():
    latest_script = get_latest_script()
    if not latest_script:
        raise HTTPException(status_code=500, detail="No generated script is available.")
    pdf_bytes = build_script_pdf(latest_script)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename=GEE_Script.pdf'},
    )


@app.post("/api/flood-images")
async def get_flood_imagery(request: FloodImageRequest):
    request_started_at = time.perf_counter()
    request_summary = _summarize_flood_image_request(request)
    logger.info("[flood-images] request:start summary=%s", request_summary)

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
            detail="GEE服务未初始化，请检查认证配置"
        )
    
    try:
        # 优先使用 geojson，其次 bounds，最后使用中心点
        if request.geojson:
            result = gee_service.get_flood_imagery_by_geojson(
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
            result = gee_service.get_flood_imagery_by_bounds(
                pre_date=request.pre_date,
                peek_date=request.peek_date,
                after_date=request.after_date,
                bounds=bounds_dict,
                center=(request.longitude, request.latitude)
            )
        else:
            result = get_flood_images(
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
    except Exception as e:
        logger.exception(
            "[flood-images] request:error duration_ms=%s summary=%s error=%s",
            _duration_ms(request_started_at),
            request_summary,
            str(e),
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/gee-status")
async def gee_status():
    """
    检查 GEE 服务状态
    """
    return {
        "initialized": gee_service.initialized,
        "message": "GEE服务正常" if gee_service.initialized else "GEE服务未初始化"
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


@app.post("/api/gee-code")
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

        code = generate_flood_gee_code(
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


class FloodConfirmationRefreshRequest(BaseModel):
    event: Optional[str] = None
    event_description: Optional[str] = None
    location: Optional[str] = None
    pre_date: Optional[str] = None
    peek_date: Optional[str] = None
    after_date: Optional[str] = None
    confirmation_version: Optional[int] = 1


class RecommendedLayerRenderRequest(BaseModel):
    layer_id: str
    recommended_layers: list[dict]
    confirmed_aoi: dict
    pre_date: Optional[str] = None
    peek_date: Optional[str] = None
    after_date: Optional[str] = None


class LocationSearchRequest(BaseModel):
    query: str
    limit: Optional[int] = 5


@app.post("/api/flood-impact")
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
            detail="GEE服务未初始化，请检查认证配置"
        )
    
    try:
        if request.geojson:
            result = gee_service.get_flood_impact_by_geojson(
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
            result = gee_service.get_flood_impact_by_bounds(
                pre_date=request.pre_date,
                peek_date=request.peek_date,
                bounds=bounds_dict
            )
        else:
            raise HTTPException(
                status_code=400,
                detail="需要提供 bounds 或 geojson 参数"
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


@app.post("/api/flood-confirmation/refresh")
async def refresh_flood_confirmation(request: FloodConfirmationRefreshRequest):
    try:
        context = build_confirmation_context(
            event=request.event,
            event_description=request.event_description,
            location=request.location,
            pre_date=request.pre_date,
            peek_date=request.peek_date,
            after_date=request.after_date,
            confirmation_version=request.confirmation_version or 1,
        )
        return {"success": True, "data": context}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/recommended-layer-render")
async def render_recommended_layer(request: RecommendedLayerRenderRequest):
    try:
        rendered = renderer.render_layer(
            layer_id=request.layer_id,
            recommended_layers=request.recommended_layers,
            confirmed_aoi=request.confirmed_aoi,
            pre_date=request.pre_date,
            peek_date=request.peek_date,
            after_date=request.after_date,
        )
        return {"success": True, "data": rendered}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/location-search")
async def search_location(request: LocationSearchRequest):
    try:
        candidates = search_location_candidates(
            location_name=request.query,
            limit=request.limit or 5,
        )
        return {"success": True, "data": candidates}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/business-layers/upsert")
async def upsert_business_layer_records(request: BusinessLayerUpsertRequest):
    saved_layers = upsert_business_layers(
        store_namespace=request.store_namespace,
        store_key=request.store_key,
        layers=[layer.model_dump() for layer in request.layers],
    )
    return {"success": True, "data": saved_layers}


@app.get("/api/business-layers/{layer_id}")
async def get_business_layer_record(
    layer_id: str,
    store_key: str,
    store_namespace: str = "business_layer_store",
):
    layer = get_business_layer(
        layer_id=layer_id,
        store_namespace=store_namespace,
        store_key=store_key,
    )
    if not layer:
        raise HTTPException(status_code=404, detail="Business layer not found.")
    return {"success": True, "data": layer}


@app.post("/api/business-layers/batch-resolve")
async def batch_resolve_business_layers(request: BusinessLayerResolveRequest):
    layers = resolve_business_layers(
        layer_ids=request.layer_ids,
        store_namespace=request.store_namespace,
        store_key=request.store_key,
    )
    return {"success": True, "data": layers}


@app.post("/api/state")
async def update_state(state: FloodState):
    """
    更新/同步洪水状态（供 CopilotKit 共享状态使用）
    """
    # 这里可以添加状态持久化逻辑
    return {
        "success": True,
        "state": state.model_dump()
    }


# ============== 运行服务 ==============

if __name__ == "__main__":
    import uvicorn
    
    host = os.getenv("AGENT_HOST", "0.0.0.0")
    port = int(os.getenv("AGENT_PORT", 8000))
    debug = os.getenv("AGENT_DEBUG", "True").lower() == "true"
    
    print(f"[INFO] Flood agent listening at http://{host}:{port}")
    print(f"[INFO] API docs: http://{host}:{port}/docs")
    print(f"[INFO] Agent endpoint: http://{host}:{port}/agent")
    
    uvicorn.run(
        "server:app",
        host=host,
        port=port,
        reload=debug,
    )

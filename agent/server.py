"""
FastAPI 后端服务 - 集成 CopilotKit 和 LangGraph
使用 LangGraphAGUIAgent 作为智能体与 CopilotKit 的连接方式
"""
import os
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import uvicorn

# CopilotKit AG-UI 集成
from copilotkit import LangGraphAGUIAgent
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from ag_ui.core import RunStartedEvent

# 本地模块
from flood_agent import graph
from gee_service import gee_service, get_flood_images
from gee_code_generator import generate_flood_gee_code


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

load_dotenv()

# 配置代理
http_proxy = os.getenv("HTTP_PROXY")
https_proxy = os.getenv("HTTPS_PROXY")
if http_proxy:
    os.environ["HTTP_PROXY"] = http_proxy
if https_proxy:
    os.environ["HTTPS_PROXY"] = https_proxy


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    print("🚀 洪水智能体服务启动中...")
    yield
    print("👋 洪水智能体服务关闭")


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
    allow_origins=["*"],  # 生产环境应该限制具体域名
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


@app.post("/api/flood-images")
async def get_flood_imagery(request: FloodImageRequest):
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
        return {
            "success": True,
            "data": result
        }
    except Exception as e:
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
    
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", 8000))
    debug = os.getenv("DEBUG", "True").lower() == "true"
    
    print(f"🌊 启动洪水智能体服务: http://{host}:{port}")
    print(f"📚 API文档: http://{host}:{port}/docs")
    print(f"🤖 Agent端点: http://{host}:{port}/agent")
    
    uvicorn.run(
        "server:app",
        host=host,
        port=port,
        reload=debug,
    )

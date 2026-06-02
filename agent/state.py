"""
洪水智能体状态定义
使用 CopilotKitState 实现前后端状态共享
"""
from typing import List, Dict, Any
from copilotkit import CopilotKitState


class FloodAgentState(CopilotKitState, total=False):
    """
    洪水智能体的状态
    继承自 CopilotKitState，自动包含 messages 和 copilotkit 字段
    使用 total=False 允许所有字段可选
    """
    
    # 洪水事件名称
    event: str
    
    # 洪水事件描述
    event_description: str
    
    # 洪水报告（最终生成的完整报告）
    flood_report: str
    
    # 可编辑的报告文档（用于 Predictive State Updates，支持流式更新）
    report_document: str
    
    # 洪水开始前的日期
    pre_date: str
    
    # 洪水结束后的日期
    after_date: str
    
    # 洪峰日期
    peek_date: str
    
    # 是否是有效的洪水事件查询
    is_valid_flood_query: bool
    
    # 工作流阶段: "initial" -> "pending_confirmation" -> "confirmed" -> "completed"
    # initial: 初始状态
    # pending_confirmation: 等待用户确认事件信息
    # confirmed: 用户已确认，可以获取地理数据和生成报告
    # completed: 流程完成
    stage: str
    
    # 用户是否已确认事件信息
    user_confirmed: bool
    
    # 事件地理位置
    location: str
    
    # 地理坐标 [longitude, latitude]
    coordinates: List[float]
    
    # 地理边界 {"west": float, "south": float, "east": float, "north": float}
    bounds: Dict[str, float]

    # GeoJSON 边界 (不传递给 LLM，仅用于 GEE 服务)
    geojson: Dict[str, Any]

    # 预确认阶段解析出的 AOI
    resolved_aoi: Dict[str, Any]

    # AOI 解析元数据
    aoi_resolution_meta: Dict[str, Any]

    # 用户最终确认后的 AOI
    confirmed_aoi: Dict[str, Any]

    # 推荐图层描述符列表
    recommended_layers: List[Dict[str, Any]]

    # 当前选中的推荐图层 id 列表
    selected_layer_ids: List[str]

    recommendation_strategy: str

    recommendation_source: str

    # 用户在消息中显式 @ 的图层引用
    mentioned_layer_refs: List[Dict[str, Any]]

    # mention 优先解析出的 AOI
    mentioned_aoi: Dict[str, Any]

    # mention AOI 来源说明
    mentioned_aoi_source: str

    # 统一确认版本号
    confirmation_version: int

    # 地理编码原始数据 (不传递给 LLM，用于存储 Nominatim 返回的完整数据)
    geo_data: Dict[str, Any]
    
    # 搜索来源列表 [{"title": str, "url": str}]
    search_sources: List[Dict[str, str]]
    
    # GEE JavaScript 代码（生成的可下载代码）
    gee_code: str

    # LLM intent classification result
    intent: Dict[str, Any]

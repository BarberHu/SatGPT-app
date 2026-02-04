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
    
    # 地理编码原始数据 (不传递给 LLM，用于存储 Nominatim 返回的完整数据)
    geo_data: Dict[str, Any]
    
    # 搜索来源列表 [{"title": str, "url": str}]
    search_sources: List[Dict[str, str]]

"""
洪水智能体 - 使用 LangGraph 构建
基于 CopilotKit AG-UI 协议
支持 Human-in-the-Loop (HITL) 通过 interrupt 实现

重构版本：采用清晰的节点分离设计
- entry_node: 入口路由，判断用户意图
- chat_node: 通用聊天，处理工具调用
- extraction_node: 信息提取，从搜索结果提取结构化数据
- confirmation_node: 用户确认 (HITL)
- processing_node: 数据处理，地理编码 + 报告生成
"""
import os
import json
import re
import requests
from typing import Literal, Optional, Dict, Any

from langchain.tools import tool
from langchain_openai import ChatOpenAI
from openai import AsyncOpenAI
from langchain_core.messages import SystemMessage, AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph
from langgraph.prebuilt import ToolNode
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt

from state import FloodAgentState
from prompts import SYSTEM_PROMPT, FLOOD_REPORT_TEMPLATE, REPORT_GENERATION_PROMPT
from gee_code_generator import generate_flood_gee_code
from flood_aoi import aoi_to_geo_fields
from flood_dataset_service import build_confirmation_context
from mention_context import resolve_mention_context
from project_env import load_project_env

load_project_env()

# 配置代理
http_proxy = os.getenv("HTTP_PROXY")
https_proxy = os.getenv("HTTPS_PROXY")
if http_proxy:
    os.environ["HTTP_PROXY"] = http_proxy
if https_proxy:
    os.environ["HTTPS_PROXY"] = https_proxy


# ============== 内部函数 ==============

def _classify_location_type(location_name: str) -> dict:
    """
    使用LLM判断地名类型
    
    返回:
    - type: "administrative" (行政区域) 或 "composite" (组合/自然区域)
    - reason: 判断原因
    """
    try:
        model = _get_model()
        
        prompt = f"""Please determine the type of the following place name:

Place name: {location_name}

Criteria:
1. "administrative" - An independent administrative region, such as: country, province/state, city, county, district, etc., with clearly defined administrative boundaries
   Examples: Beijing, Germany, California, Tokyo, Paris

2. "composite" - A composite place name, geographic location, or natural region, including:
   - Combinations of multiple administrative regions: Jing-Jin-Ji, Yangtze River Delta, Pearl River Delta, EU
   - Geographic location concepts: North China, Southeast Asia, Middle East
   - Natural geographic regions: Yellow River Basin, Amazon Basin, Alpine Region
   - Trans-administrative geographic units: Mississippi River Basin, Danube Plain

Please return strictly in the following JSON format, do not include any other text:
```json
{{"type": "administrative or composite", "reason": "brief explanation"}}
```"""

        response = model.invoke([HumanMessage(content=prompt)])
        content = response.content
        
        # 提取JSON
        if "```json" in content:
            json_str = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            json_str = content.split("```")[1].split("```")[0]
        else:
            json_str = content
        
        data = json.loads(json_str.strip())
        location_type = data.get("type", "administrative")
        reason = data.get("reason", "")
        
        print(f"[DEBUG] Location type: {location_name} -> {location_type} ({reason})")
        return {"type": location_type, "reason": reason}
        
    except Exception as e:
        print(f"[WARN] Failed to classify location type with LLM: {e}; defaulting to administrative area")
        return {"type": "administrative", "reason": "判断失败，使用默认值"}


def _generate_geojson_with_llm(location_name: str) -> Optional[Dict[str, Any]]:
    """
    使用LLM生成组合区域的大致GeoJSON边界
    适用于：组合地名、地理区位、自然区域等非标准行政区域
    """
    try:
        model = _get_model()
        
        prompt = f"""Please generate an approximate GeoJSON boundary for the following geographic region.

Geographic region name: {location_name}

Requirements:
1. Generate a simplified Polygon boundary with 4-8 vertices to represent the approximate extent
2. Coordinates should be in [longitude, latitude] format using WGS84 coordinate system
3. The polygon must be closed (first and last coordinates must be the same)
4. Also provide the center point coordinates and bounding box

Please return strictly in the following JSON format, do not include any other text:

```json
{{
    "center": [longitude, latitude],
    "bounds": {{
        "west": westernmost_longitude,
        "south": southernmost_latitude,
        "east": easternmost_longitude,
        "north": northernmost_latitude
    }},
    "geometry": {{
        "type": "Polygon",
        "coordinates": [[[lon1, lat1], [lon2, lat2], ..., [lon1, lat1]]]
    }}
}}
```"""

        response = model.invoke([HumanMessage(content=prompt)])
        content = response.content
        
        # 提取JSON
        if "```json" in content:
            json_str = content.split("```json")[1].split("```")[0]
        elif "```" in content:
            json_str = content.split("```")[1].split("```")[0]
        else:
            json_str = content
        
        data = json.loads(json_str.strip())
        
        # 验证数据结构
        if not all(k in data for k in ['center', 'bounds', 'geometry']):
            raise ValueError("Missing required fields")
        
        # 构建GeoJSON Feature
        geojson_feature = {
            'type': 'Feature',
            'properties': {
                'name': location_name,
                'type': 'composite_region',
                'source': 'LLM_generated'
            },
            'geometry': data['geometry']
        }
        
        print(f"[INFO] LLM generated geographic data: {location_name}")
        return {
            "location": location_name,
            "coordinates": data['center'],
            "bounds": data['bounds'],
            "geojson": geojson_feature,
            "type": "composite_region",
            "source": "LLM_generated"
        }
        
    except Exception as e:
        print(f"[ERROR] LLM failed to generate GeoJSON: {e}")
        return None


def _get_latest_user_message_content(messages: list[Any]) -> Optional[str]:
    for message in reversed(messages or []):
        if isinstance(message, HumanMessage):
            return str(message.content)
    return None



def _extract_json_object(content: Any) -> Dict[str, Any]:
    text = str(content or "").strip()
    if not text:
        return {}

    if "```json" in text:
        text = text.split("```json", 1)[1].split("```", 1)[0].strip()
    elif "```" in text:
        text = text.split("```", 1)[1].split("```", 1)[0].strip()
    else:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}

    return data if isinstance(data, dict) else {}


_TIME_HINT_PATTERNS = (
    re.compile(r"\b(?:19|20)\d{2}(?:[-/.]\d{1,2}(?:[-/.]\d{1,2})?)?\b"),
    re.compile(r"(?:19|20)\d{2}\s*\u5e74(?:\s*\d{1,2}\s*\u6708(?:\s*\d{1,2}\s*[\u65e5\u53f7])?)?"),
    re.compile(
        r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)"
        r"[a-z]*\s+(?:19|20)\d{2}\b",
        re.IGNORECASE,
    ),
)

_SPECIFIC_TIME_HINT_PATTERNS = (
    re.compile(r"\b(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b"),
    re.compile(r"(?:19|20)\d{2}\s*\u5e74\s*\d{1,2}\s*\u6708(?:\s*\d{1,2}\s*[\u65e5\u53f7])?"),
    re.compile(
        r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)"
        r"[a-z]*\s+(?:19|20)\d{2}\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:19|20)\d{2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)"
        r"[a-z]*\b",
        re.IGNORECASE,
    ),
)


def _has_event_time_hint(content: Optional[str]) -> bool:
    text = str(content or "")
    return any(pattern.search(text) for pattern in _TIME_HINT_PATTERNS)


def _has_specific_event_time_hint(content: Optional[str]) -> bool:
    text = str(content or "")
    return any(pattern.search(text) for pattern in _SPECIFIC_TIME_HINT_PATTERNS)


def _has_explicit_spatial_mention(content: Optional[str]) -> bool:
    return "<<SATGPT_MENTION_CONTEXT>>" in str(content or "")


def _has_spatial_scope_mention(content: Optional[str]) -> bool:
    text = str(content or "")
    return _has_explicit_spatial_mention(text) or bool(re.search(r"@[\w\u4e00-\u9fff-]+", text))


def _default_intent(message_content: Optional[str]) -> Dict[str, Any]:
    has_scope = _has_spatial_scope_mention(message_content)
    return {
        "intent_type": "event_discovery",
        "is_specific_flood_event": False,
        "requests_workflow": False,
        "requests_inundation_extraction": False,
        "has_time": False,
        "has_location": False,
        "has_spatial_scope_mention": has_scope,
        "missing_requirements": ["time", "location"],
        "should_use_search": False,
        "should_append_json": False,
        "should_start_workflow": False,
        "user_guidance": "Please provide the flood event time and location.",
        "confidence": 0.0,
    }


def _normalize_intent(raw_intent: Dict[str, Any], message_content: Optional[str]) -> Dict[str, Any]:
    intent = _default_intent(message_content)
    if isinstance(raw_intent, dict):
        intent.update({key: value for key, value in raw_intent.items() if key in intent})

    has_time_hint = _has_event_time_hint(message_content)
    has_specific_time_hint = _has_specific_event_time_hint(message_content)

    bool_fields = (
        "is_specific_flood_event",
        "requests_workflow",
        "requests_inundation_extraction",
        "has_time",
        "has_location",
        "has_spatial_scope_mention",
        "should_use_search",
        "should_append_json",
        "should_start_workflow",
    )
    for field in bool_fields:
        intent[field] = bool(intent.get(field))

    intent["has_spatial_scope_mention"] = _has_spatial_scope_mention(message_content)
    intent["has_time"] = intent["has_time"] or has_time_hint

    missing = intent.get("missing_requirements")
    if not isinstance(missing, list):
        missing = []
    missing = [str(item) for item in missing if str(item).strip()]
    if intent["has_time"]:
        missing = [item for item in missing if item != "time"]
    if intent["has_location"]:
        missing = [item for item in missing if item != "location"]
    if intent["has_spatial_scope_mention"]:
        missing = [item for item in missing if item != "@spatial scope"]

    has_ambiguous_year_event = (
        intent["has_time"]
        and intent["has_location"]
        and not has_specific_time_hint
        and (
            intent["is_specific_flood_event"]
            or intent["requests_workflow"]
            or intent["should_use_search"]
        )
    )
    if has_ambiguous_year_event:
        intent["is_specific_flood_event"] = False
        if "specific flood event" not in missing:
            missing.append("specific flood event")

    if intent["requests_workflow"]:
        if not intent["has_time"] and "time" not in missing:
            missing.append("time")
        elif not has_specific_time_hint and "specific flood event" not in missing:
            missing.append("specific flood event")
        if not intent["has_spatial_scope_mention"] and "@spatial scope" not in missing:
            missing.append("@spatial scope")
        if missing:
            intent["should_use_search"] = bool(has_ambiguous_year_event)
            intent["should_append_json"] = False
            intent["should_start_workflow"] = False
        else:
            intent["should_use_search"] = True
            intent["should_append_json"] = True
            intent["should_start_workflow"] = True
    elif not intent["is_specific_flood_event"]:
        intent["should_use_search"] = bool(has_ambiguous_year_event)
        intent["should_append_json"] = False
        intent["should_start_workflow"] = False
    else:
        intent["should_append_json"] = False
        intent["should_start_workflow"] = False

    intent["missing_requirements"] = missing
    if intent["requests_inundation_extraction"]:
        intent["intent_type"] = "inundation_extraction_workflow"
    elif intent["requests_workflow"]:
        intent["intent_type"] = "analysis_workflow"
    elif intent["is_specific_flood_event"]:
        intent["intent_type"] = "specific_event_information"
    else:
        intent["intent_type"] = "event_discovery"

    return intent


async def _classify_user_intent(message_content: Optional[str], config: RunnableConfig) -> Dict[str, Any]:
    has_scope = _has_spatial_scope_mention(message_content)
    prompt = f"""Classify the latest user message for a flood-analysis assistant.
Return only JSON, no markdown.

Rules:
- Specific event = flood/disaster subject + location + month/date/time window, or a uniquely named event.
- Year-only + location is ambiguous: set is_specific_flood_event=false, should_use_search=true, missing_requirements=[\"specific flood event\"].
- Workflow = analysis/mapping/imagery/report/impact/raster/flood processing/inundation extraction.
- Workflow can start only with a specific event and explicit @ spatial scope.
- Normal specific-event info may search, but must not append workflow JSON.

UI: has_explicit_at_spatial_scope={str(has_scope).lower()}

Schema:
{{\"intent_type\":\"event_discovery|specific_event_information|analysis_workflow|inundation_extraction_workflow\",\"is_specific_flood_event\":false,\"requests_workflow\":false,\"requests_inundation_extraction\":false,\"has_time\":false,\"has_location\":false,\"has_spatial_scope_mention\":false,\"missing_requirements\":[],\"should_use_search\":false,\"should_append_json\":false,\"should_start_workflow\":false,\"user_guidance\":\"\",\"confidence\":0.0}}

User message:
{message_content or ""}
"""
    try:
        client_kwargs = {"api_key": os.getenv("OPENAI_API_KEY", "")}
        base_url = os.getenv("OPENAI_API_BASE")
        if base_url:
            client_kwargs["base_url"] = base_url

        client = AsyncOpenAI(**client_kwargs)
        response = await client.chat.completions.create(
            model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
            temperature=0,
            messages=[{"role": "user", "content": prompt}],
        )
        content = response.choices[0].message.content if response.choices else ""
        return _normalize_intent(_extract_json_object(content), message_content)
    except Exception as exc:
        print(f"[WARN] Intent classification failed: {exc}")
        return _normalize_intent({}, message_content)


def _get_location_from_nominatim(location_name: str) -> Optional[Dict[str, Any]]:
    """
    从Nominatim API获取行政区域的GeoJSON
    不限制国家范围
    """
    try:
        import time
        time.sleep(1)  # 避免请求过于频繁
        
        nominatim_url = "https://nominatim.openstreetmap.org/search"
        params = {
            'q': location_name,
            'format': 'geojson',
            'polygon_geojson': 1,
            'limit': 1,
            'accept-language': 'en,zh-CN'  # Prefer English, then Chinese
        }
        
        headers = {
            'User-Agent': 'FloodAgent/1.0 (flood monitoring application)'
        }
        
        response = requests.get(nominatim_url, params=params, headers=headers, timeout=15)
        response.raise_for_status()
        
        data = response.json()
        
        if not data.get('features'):
            return None
        
        feature = data['features'][0]
        geometry = feature.get('geometry')
        properties = feature.get('properties', {})
        
        # 计算边界框和中心点
        bounds = None
        center = None
        
        if geometry and geometry.get('coordinates'):
            if geometry['type'] == 'Point':
                lon, lat = geometry['coordinates']
                buffer = 0.5  # 对于点，创建较大的缓冲区
                bounds = {
                    'west': lon - buffer,
                    'south': lat - buffer,
                    'east': lon + buffer,
                    'north': lat + buffer
                }
                center = [lon, lat]
            else:
                def extract_coords(coords, result_coords=None):
                    if result_coords is None:
                        result_coords = []
                    if isinstance(coords[0], (int, float)):
                        result_coords.append(coords)
                    else:
                        for coord in coords:
                            extract_coords(coord, result_coords)
                    return result_coords
                
                all_coords = extract_coords(geometry['coordinates'])
                if all_coords:
                    lons = [coord[0] for coord in all_coords]
                    lats = [coord[1] for coord in all_coords]
                    bounds = {
                        'west': min(lons),
                        'south': min(lats),
                        'east': max(lons),
                        'north': max(lats)
                    }
                    center = [
                        (bounds['west'] + bounds['east']) / 2,
                        (bounds['south'] + bounds['north']) / 2
                    ]
        
        geojson_feature = {
            'type': 'Feature',
            'properties': {
                'name': properties.get('display_name', location_name),
                'type': properties.get('type'),
                'class': properties.get('class')
            },
            'geometry': geometry
        }
        
        return {
            "location": properties.get('display_name', location_name),
            "coordinates": center if center else [0.0, 0.0],
            "bounds": bounds if bounds else {"south": -90, "north": 90, "west": -180, "east": 180},
            "geojson": geojson_feature,
            "type": properties.get('type', 'administrative'),
            "source": "Nominatim/OpenStreetMap"
        }
        
    except Exception as e:
        print(f"[WARN] Nominatim query failed: {e}")
        return None


def _get_location_coordinates_internal(location_name: str) -> Optional[Dict[str, Any]]:
    """
    智能地理编码函数
    
    策略：
    1. 使用LLM判断地名类型（行政区域 vs 组合/自然区域）
    2. 行政区域 → 使用Nominatim API获取精确GeoJSON
    3. 组合/自然区域 → 使用LLM生成大致GeoJSON
    4. 如果Nominatim失败，回退到LLM生成
    """
    print(f"[INFO] Resolving geographic data: {location_name}")
    
    # 使用LLM判断地名类型
    classification = _classify_location_type(location_name)
    is_composite = classification["type"] == "composite"
    
    if is_composite:
        print(f"[DEBUG] Composite region detected, generating GeoJSON with LLM: {location_name}")
        result = _generate_geojson_with_llm(location_name)
        if result:
            return result
        # LLM失败时尝试Nominatim
        print("[WARN] LLM generation failed, falling back to Nominatim...")
    
    # 尝试Nominatim API
    print(f"[INFO] Trying Nominatim lookup: {location_name}")
    result = _get_location_from_nominatim(location_name)
    
    if result:
        print(f"[INFO] Geographic data resolved: {location_name}")
        return result
    
    # Nominatim失败，尝试LLM
    if not is_composite:
        print(f"[WARN] Nominatim returned no result, trying LLM generation: {location_name}")
        result = _generate_geojson_with_llm(location_name)
        if result:
            return result
    
    # 所有方法都失败
    print(f"[ERROR] Failed to resolve geographic data: {location_name}")
    return {
        "location": location_name,
        "coordinates": [0.0, 0.0],
        "bounds": {"south": -90, "north": 90, "west": -180, "east": 180},
        "geojson": None,
        "error": f"Unable to retrieve geographic information for '{location_name}'"
    }


def _get_model() -> ChatOpenAI:
    """获取 LLM 模型实例"""
    return ChatOpenAI(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        api_key=os.getenv("OPENAI_API_KEY", ""),
        base_url=os.getenv("OPENAI_API_BASE"),
        temperature=0.7
    )


def _should_route_to_tool_node(tool_calls, fe_tools) -> bool:
    """判断是否应该路由到工具节点"""
    if not tool_calls:
        return False
    
    fe_tool_names = {tool.get("name") for tool in fe_tools}
    
    for tool_call in tool_calls:
        tool_name = (
            tool_call.get("name")
            if isinstance(tool_call, dict)
            else getattr(tool_call, "name", None)
        )
        if tool_name in fe_tool_names:
            return False
    
    return True


def _extract_flood_info_from_content(content: str) -> dict:
    """从 LLM 响应内容中提取洪水信息"""
    updates = {}
    try:
        if "```json" in content:
            json_str = content.split("```json")[1].split("```")[0]
            data = json.loads(json_str.strip())
            
            field_names = ["event", "event_description", "location", 
                          "pre_date", "peek_date", "after_date", "stage"]
            for field in field_names:
                if data.get(field):
                    updates[field] = data[field]
            
            # 提取坐标和边界
            if data.get("coordinates") and isinstance(data["coordinates"], list) and len(data["coordinates"]) == 2:
                updates["coordinates"] = data["coordinates"]
            if data.get("bounds") and isinstance(data["bounds"], dict):
                required_keys = ["west", "east", "south", "north"]
                if all(k in data["bounds"] for k in required_keys):
                    updates["bounds"] = data["bounds"]
    except (json.JSONDecodeError, IndexError, KeyError):
        pass

    if updates:
        return updates

    field_patterns = {
        "event": r"(?:^|\n)\s*[-*]?\s*\**Event\**\s*:\s*([^\n]+)",
        "event_description": r"(?:^|\n)\s*[-*]?\s*\**Description\**\s*:\s*(.+?)(?=\n\s*[-*]\s*\**(?:Location|Pre[- ]?Date|Peak Date|After Date)\**\s*:|\Z)",
        "location": r"(?:^|\n)\s*[-*]?\s*\**Location\**\s*:\s*([^\n]+)",
        "pre_date": r"(?:^|\n)\s*[-*]?\s*\**Pre[- ]?Date\**\s*:\s*(\d{4}-\d{2}-\d{2})",
        "peek_date": r"(?:^|\n)\s*[-*]?\s*\**Peak Date\**\s*:\s*(\d{4}-\d{2}-\d{2})",
        "after_date": r"(?:^|\n)\s*[-*]?\s*\**After Date\**\s*:\s*(\d{4}-\d{2}-\d{2})",
    }
    for field, pattern in field_patterns.items():
        match = re.search(pattern, content, re.IGNORECASE | re.DOTALL)
        if match:
            value = " ".join(match.group(1).strip().split())
            if value:
                updates[field] = value

    return updates


def _format_sources_text(sources: list) -> str:
    """格式化来源信息为 Markdown 文本"""
    if not sources:
        return "*This report is compiled from publicly available online sources*"
    
    lines = []
    # 显示所有来源
    for i, source in enumerate(sources, 1):
        title = source.get("title", "Unknown source")
        url = source.get("url", "#")
        lines.append(f"{i}. [{title}]({url})")
    
    result = "\n".join(lines) if lines else "*This report is compiled from publicly available online sources*"
    
    # 如果来源不足10条，添加说明
    if len(sources) < 10:
        result = f"**Note**: Due to limited public reporting on this flood event, the number of available sources is relatively small ({len(sources)} in total). The following analysis is based on the currently available authoritative sources.\n\n" + result
    
    return result


def _has_complete_flood_info(state: FloodAgentState) -> bool:
    """检查是否有完整的洪水事件信息"""
    return all([
        state.get("event"),
        state.get("pre_date"),
        state.get("peek_date"),
        state.get("after_date"),
        state.get("location")
    ])


# ============== 工具定义 ==============

# 全局变量用于临时存储搜索来源信息和完整内容
_pending_search_sources: list = []
_pending_search_contents: list = []
MAX_SEARCH_SOURCES = 8
MAX_SEARCH_CONTENT_CHARS = 700


def _compact_search_content(content: str, limit: int = MAX_SEARCH_CONTENT_CHARS) -> str:
    text = " ".join(str(content or "").split())
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "..."

@tool
def search_flood_event(query: str) -> str:
    """
    搜索洪水事件的相关信息。
    
    Args:
        query: 搜索查询，应包含洪水事件名称、地点、时间等关键信息
        
    Returns:
        搜索结果的摘要文本
    """
    global _pending_search_sources, _pending_search_contents
    try:
        from tavily import TavilyClient
        tavily_api_key = os.getenv("TAVILY_API_KEY")
        if not tavily_api_key:
            _pending_search_sources = []
            _pending_search_contents = []
            return (
                "Search tool is unavailable because TAVILY_API_KEY is not configured. "
                "Use built-in knowledge only, and tell the user that online search is disabled."
            )

        tavily_client = TavilyClient(api_key=tavily_api_key)
        
        # 使用多个搜索策略获取更多来源
        all_results = []
        all_sources = []
        seen_urls = set()
        
        # 搜索策略1：基本搜索
        enhanced_query = f"{query} flood disaster timeline date"
        response = tavily_client.search(
            query=enhanced_query,
            search_depth="advanced",
            max_results=8,
            include_answer=True
        )
        
        results = []
        if response.get("answer"):
            results.append(f"Summary: {response['answer']}")
        
        for result in response.get("results", []):
            url = result.get("url", "")
            if url and url not in seen_urls:
                seen_urls.add(url)
                title = result.get("title", "")
                content = _compact_search_content(result.get("content", ""))
                results.append(f"Title: {title}\nContent: {content}\nSource: {url}\n")
                if title and url:
                    all_sources.append({"title": title, "url": url, "content": content})
        
        # Search strategy 2: impact and losses
        impact_query = f"{query} impact damage casualties affected"
        try:
            response2 = tavily_client.search(
                query=impact_query,
                search_depth="advanced",
                max_results=5,
                include_answer=False
            )
            for result in response2.get("results", []):
                url = result.get("url", "")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    title = result.get("title", "")
                    content = _compact_search_content(result.get("content", ""))
                    results.append(f"Title: {title}\nContent: {content}\nSource: {url}\n")
                    if title and url:
                        all_sources.append({"title": title, "url": url, "content": content})
        except:
            pass
        
        # Search strategy 3: emergency response
        rescue_query = f"{query} rescue emergency response evacuation"
        try:
            response3 = tavily_client.search(
                query=rescue_query,
                search_depth="basic",
                max_results=5,
                include_answer=False
            )
            for result in response3.get("results", []):
                url = result.get("url", "")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    title = result.get("title", "")
                    content = _compact_search_content(result.get("content", ""))
                    results.append(f"Title: {title}\nContent: {content}\nSource: {url}\n")
                    if title and url:
                        all_sources.append({"title": title, "url": url, "content": content})
        except:
            pass
        
        all_sources = all_sources[:MAX_SEARCH_SOURCES]
        results = results[: MAX_SEARCH_SOURCES + 1]
        _pending_search_sources = [{"title": s["title"], "url": s["url"]} for s in all_sources]
        _pending_search_contents = all_sources  # Store full content for report generation
        
        print(f"[INFO] Search completed with {len(all_sources)} sources")
        
        return "\n---\n".join(results) if results else "No relevant flood event information found"
        
    except Exception as e:
        _pending_search_sources = []
        _pending_search_contents = []
        return f"Search error: {str(e)}"


# 工具列表
tools = [search_flood_event]


# ============== 节点定义 ==============

# 定义节点路由类型
NodeType = Literal["intent_node", "chat_node", "tool_node", "extraction_node", "pre_confirmation_node", "confirmation_node", "processing_node", "__end__"]


async def entry_node(
    state: FloodAgentState, config: RunnableConfig
) -> Command[NodeType]:
    """
    入口节点 - 分析用户意图并路由
    
    职责：
    1. 判断当前阶段
    2. 如果是已完成阶段且有新消息，重置状态
    3. 路由到 chat_node 进行处理
    """
    current_stage = state.get('stage', 'initial')
    
    # 如果已完成但用户发送新消息，重置为初始状态
    if current_stage == "completed":
        return Command(
            goto="chat_node",
            update={
                "stage": "initial",
                "user_confirmed": False,
                "event": None,
                "event_description": None,
                "flood_report": None,
                "report_document": None,
                "pre_date": None,
                "peek_date": None,
                "after_date": None,
                "is_valid_flood_query": False,
                "coordinates": None,
                "location": None,
                "bounds": None,
                "geojson": None,
                "resolved_aoi": None,
                "aoi_resolution_meta": None,
                "confirmed_aoi": None,
                "recommended_layers": [],
                "selected_layer_ids": [],
                "mentioned_layer_refs": [],
                "mentioned_aoi": None,
                "mentioned_aoi_source": None,
                "confirmation_version": 0,
                "geo_data": None,
                "search_sources": [],
                "gee_code": None,
                "intent": None,
            }
        )
    
    return Command(goto="intent_node")


async def intent_node(
    state: FloodAgentState, config: RunnableConfig
) -> Command[NodeType]:
    latest_user_message = _get_latest_user_message_content(state.get("messages", []))
    intent = await _classify_user_intent(latest_user_message, config)
    print(f"[DEBUG] Classified user intent: {intent}")

    return Command(
        goto="chat_node",
        update={"intent": intent},
    )


async def chat_node(
    state: FloodAgentState, config: RunnableConfig
) -> Command[NodeType]:
    model = _get_model()
    current_stage = state.get('stage', 'initial')
    latest_user_message = _get_latest_user_message_content(state.get("messages", []))
    intent = _normalize_intent(state.get("intent") or {}, latest_user_message)
    intent_type = intent.get("intent_type", "event_discovery")
    missing_requirements = ", ".join(intent.get("missing_requirements") or []) or "none"

    fe_tools = state.get("copilotkit", {}).get("actions", [])
    can_use_search_tools = bool(intent.get("should_use_search"))
    model_with_tools = model.bind_tools([*fe_tools, *tools]) if can_use_search_tools else model

    if intent.get("requests_inundation_extraction") and not intent.get("should_start_workflow"):
        mode = "inundation_missing"
    elif intent.get("requests_workflow") and not intent.get("should_start_workflow"):
        mode = "workflow_missing"
    elif intent.get("should_start_workflow"):
        mode = "workflow_ready"
    elif intent.get("is_specific_flood_event"):
        mode = "specific_event_info"
    else:
        mode = "event_discovery"

    search_rule = "candidate_search" if intent.get("should_use_search") and "specific flood event" in missing_requirements else ("allowed" if intent.get("should_use_search") else "forbidden")
    json_rule = "append_required" if intent.get("should_start_workflow") else "forbidden"
    workflow_instruction = (
        f"Mode={mode}; Missing={missing_requirements}; Search={search_rule}; JSON={json_rule}. "
        "Workflow starts only with a specific event and explicit @ spatial scope. "
        "When JSON=append_required, end the response with one fenced ```json block containing event, event_description, location, pre_date, peek_date, and after_date. "
        "If only a year is provided, explain ambiguity and ask for month/date or a candidate choice. "
        "If @ is missing for workflow, ask for @ spatial scope. Keep the answer concise."
    )

    system_message = SystemMessage(
        content=f"""{SYSTEM_PROMPT}

[Current Stage]: {current_stage}
[Classified Intent]: {intent_type}
{workflow_instruction}
"""
    )

    response = await model_with_tools.ainvoke(
        [system_message, *state["messages"]],
        config,
    )

    tool_calls = response.tool_calls
    if tool_calls and _should_route_to_tool_node(tool_calls, fe_tools):
        return Command(
            goto="tool_node",
            update={"messages": response}
        )

    return Command(
        goto="extraction_node",
        update={"messages": response}
    )


async def extraction_node(
    state: FloodAgentState, config: RunnableConfig
) -> Command[NodeType]:
    """
    信息提取节点 - 从 LLM 响应中提取结构化数据
    
    职责：
    1. 解析 LLM 响应中的 JSON 数据
    2. 提取洪水事件信息
    3. 判断是否有完整信息需要确认
    """
    # 获取最后一条消息的内容
    messages = state.get("messages", [])
    print(f"[DEBUG] Extracting node messages, count={len(messages)}")
    if not messages:
        return Command(goto="__end__")
    
    last_message = messages[-1]
    content = str(last_message.content) if hasattr(last_message, 'content') else str(last_message)
    
    print(f"[DEBUG] Extracted analysis content:\n{content}\n")
    # 提取洪水信息
    extracted_info = _extract_flood_info_from_content(content)
    
    # 合并到当前状态
    event = extracted_info.get("event") or state.get("event")
    event_description = extracted_info.get("event_description") or state.get("event_description")
    location = extracted_info.get("location") or state.get("location")
    pre_date = extracted_info.get("pre_date") or state.get("pre_date")
    peek_date = extracted_info.get("peek_date") or state.get("peek_date")
    after_date = extracted_info.get("after_date") or state.get("after_date")
    
    # 检查是否有完整的新事件信息
    has_complete_info = all([
        extracted_info.get("event"),
        extracted_info.get("pre_date"),
        extracted_info.get("peek_date"),
        extracted_info.get("after_date")
    ])
    
    user_confirmed = state.get('user_confirmed', False)
    current_stage = state.get('stage', 'initial')
    latest_user_message = _get_latest_user_message_content(messages)
    intent = _normalize_intent(state.get("intent") or {}, latest_user_message)
    analysis_workflow_requested = bool(intent.get("should_start_workflow"))
    
    # 如果有完整信息且未确认，进入确认节点
    if has_complete_info and analysis_workflow_requested and not user_confirmed and current_stage != "completed":
        return Command(
            goto="pre_confirmation_node",
            update={
                "event": event,
                "event_description": event_description,
                "location": location,
                "pre_date": pre_date,
                "peek_date": peek_date,
                "after_date": after_date,
                "stage": "pending_confirmation",
            }
        )
    
    # 普通响应，结束流程
    return Command(
        goto="__end__",
        update={
            "event": event,
            "event_description": event_description,
            "location": location,
            "pre_date": pre_date,
            "peek_date": peek_date,
            "after_date": after_date,
        }
    )


async def pre_confirmation_node(
    state: FloodAgentState, config: RunnableConfig
) -> Command[NodeType]:
    latest_user_message = _get_latest_user_message_content(state.get("messages", []))
    mention_context = resolve_mention_context(
        latest_user_message,
        thread_id=(state.get("copilotkit") or {}).get("threadId"),
    )

    confirmation_context = build_confirmation_context(
        event=state.get("event"),
        event_description=state.get("event_description"),
        location=state.get("location"),
        pre_date=state.get("pre_date"),
        peek_date=state.get("peek_date"),
        after_date=state.get("after_date"),
        mention_context=mention_context,
        confirmation_version=(state.get("confirmation_version") or 0) + 1,
    )

    return Command(
        goto="confirmation_node",
        update={
            "resolved_aoi": confirmation_context.get("resolved_aoi"),
            "aoi_resolution_meta": confirmation_context.get("aoi_resolution_meta"),
            "confirmed_aoi": confirmation_context.get("confirmed_aoi"),
            "recommended_layers": confirmation_context.get("recommended_layers", []),
            "selected_layer_ids": confirmation_context.get("selected_layer_ids", []),
            "confirmation_version": confirmation_context.get("confirmation_version", 1),
            "coordinates": confirmation_context.get("coordinates"),
            "bounds": confirmation_context.get("bounds"),
            "geojson": confirmation_context.get("geojson"),
            "geo_data": confirmation_context.get("geo_data"),
            "location": confirmation_context.get("location"),
            "mentioned_layer_refs": confirmation_context.get("mentioned_layer_refs", []),
            "mentioned_aoi": confirmation_context.get("mentioned_aoi"),
            "mentioned_aoi_source": confirmation_context.get("mentioned_aoi_source"),
        }
    )


async def confirmation_node(
    state: FloodAgentState, config: RunnableConfig
) -> Command[NodeType]:
    """
    确认节点 - Human-in-the-Loop 用户确认
    
    职责：
    1. 使用 interrupt 暂停执行
    2. 等待用户确认或修改事件信息
    3. 处理用户取消操作
    """
    event = state.get("event")
    event_description = state.get("event_description")
    location = state.get("location")
    pre_date = state.get("pre_date")
    peek_date = state.get("peek_date")
    after_date = state.get("after_date")
    resolved_aoi = state.get("resolved_aoi")
    aoi_resolution_meta = state.get("aoi_resolution_meta")
    recommended_layers = state.get("recommended_layers") or []
    selected_layer_ids = state.get("selected_layer_ids") or []
    confirmed_aoi = state.get("confirmed_aoi") or resolved_aoi
    confirmation_version = state.get("confirmation_version") or 1
    mentioned_layer_refs = state.get("mentioned_layer_refs") or []
    mentioned_aoi = state.get("mentioned_aoi")
    mentioned_aoi_source = state.get("mentioned_aoi_source")
    
    # 使用 interrupt 暂停执行，等待用户确认
    confirmed_data_raw = interrupt({
        "type": "confirm_flood_event",
        "message": "Please confirm or modify the following flood event information:",
        "data": {
            "event": event,
            "event_description": event_description,
            "location": location,
            "pre_date": pre_date,
            "peek_date": peek_date,
            "after_date": after_date,
            "resolved_aoi": resolved_aoi,
            "aoi_resolution_meta": aoi_resolution_meta,
            "recommended_layers": recommended_layers,
            "selected_layer_ids": selected_layer_ids,
            "confirmed_aoi": confirmed_aoi,
            "confirmation_version": confirmation_version,
            "mentioned_layer_refs": mentioned_layer_refs,
            "mentioned_aoi": mentioned_aoi,
            "mentioned_aoi_source": mentioned_aoi_source,
        }
    })
    
    # 解析用户确认数据
    confirmed_data = {}
    if isinstance(confirmed_data_raw, str):
        try:
            confirmed_data = json.loads(confirmed_data_raw)
        except json.JSONDecodeError:
            confirmed_data = {}
    elif isinstance(confirmed_data_raw, dict):
        confirmed_data = confirmed_data_raw
    
    # 用户取消
    if not confirmed_data or confirmed_data.get("cancelled"):
        cancel_message = AIMessage(content="Cancelled. If you'd like to query again, please tell me which flood event you'd like to learn about.")
        return Command(
            goto="__end__",
            update={
                "messages": cancel_message,
                "stage": "initial",
                "user_confirmed": False,
                "mentioned_layer_refs": [],
                "mentioned_aoi": None,
                "mentioned_aoi_source": None,
            }
        )
    
    # 用户确认，更新数据并进入处理节点
    print("[INFO] User confirmed event details")
    
    return Command(
        goto="processing_node",
        update={
            "event": confirmed_data.get("event", event),
            "event_description": confirmed_data.get("event_description", event_description),
            "location": confirmed_data.get("location", location),
            "pre_date": confirmed_data.get("pre_date", pre_date),
            "peek_date": confirmed_data.get("peek_date", peek_date),
            "after_date": confirmed_data.get("after_date", after_date),
            "resolved_aoi": confirmed_data.get("resolved_aoi", resolved_aoi),
            "aoi_resolution_meta": confirmed_data.get("aoi_resolution_meta", aoi_resolution_meta),
            "recommended_layers": confirmed_data.get("recommended_layers", recommended_layers),
            "selected_layer_ids": confirmed_data.get("selected_layer_ids", selected_layer_ids),
            "confirmed_aoi": confirmed_data.get("confirmed_aoi", confirmed_aoi),
            "confirmation_version": confirmed_data.get("confirmation_version", confirmation_version),
            "mentioned_layer_refs": confirmed_data.get("mentioned_layer_refs", mentioned_layer_refs),
            "mentioned_aoi": confirmed_data.get("mentioned_aoi", mentioned_aoi),
            "mentioned_aoi_source": confirmed_data.get("mentioned_aoi_source", mentioned_aoi_source),
            "stage": "confirmed",
            "user_confirmed": True,
        }
    )


async def processing_node(
    state: FloodAgentState, config: RunnableConfig
) -> Command[NodeType]:
    """
    处理节点 - 地理编码和报告生成
    
    职责：
    1. 调用地理编码 API 获取坐标
    2. 使用 LLM 基于搜索内容生成详细洪水分析报告
    3. 更新最终状态
    """
    global _pending_search_contents
    
    location = state.get("location")
    event = state.get("event")
    event_description = state.get("event_description")
    pre_date = state.get("pre_date")
    peek_date = state.get("peek_date")
    after_date = state.get("after_date")
    confirmed_aoi = state.get("confirmed_aoi") or state.get("resolved_aoi")
    
    print(f"[INFO] Resolving coordinates for location: {location}")
    
    # 获取地理坐标
    existing_geo_data = dict(state.get("geo_data") or {})
    geo_data = existing_geo_data

    if confirmed_aoi:
        geo_data.update(aoi_to_geo_fields(confirmed_aoi))
    else:
        if state.get("coordinates") is not None:
            geo_data["coordinates"] = state.get("coordinates")
        if state.get("bounds") is not None:
            geo_data["bounds"] = state.get("bounds")
        if state.get("geojson") is not None:
            geo_data["geojson"] = state.get("geojson")
    
    if geo_data:
        coordinates = geo_data.get("coordinates")
        bounds = geo_data.get("bounds")
        geojson = geo_data.get("geojson")
    else:
        coordinates = [105.0, 35.0]
        bounds = {"south": 18.0, "north": 54.0, "west": 73.0, "east": 135.0}
        geojson = None
        geo_data = {}
    
    # 格式化搜索内容用于 LLM 生成报告
    search_contents_text = ""
    if _pending_search_contents:
        for i, item in enumerate(_pending_search_contents, 1):
            title = item.get("title", "")
            content = item.get("content", "")
            url = item.get("url", "")
            search_contents_text += f"### Source {i}: {title}\n{content}\nSource URL: {url}\n\n"
    else:
        search_contents_text = "No search materials available. Please analyze based on the event description."
    
    # 使用 LLM 生成详细报告
    print("[INFO] Generating detailed report with LLM...")
    model = _get_model()
    
    report_prompt = REPORT_GENERATION_PROMPT.format(
        event=event or "Unknown event",
        location=location or "To be determined",
        pre_date=pre_date or "To be determined",
        peek_date=peek_date or "To be determined",
        after_date=after_date or "To be determined",
        search_contents=search_contents_text
    )
    
    try:
        response = model.invoke([HumanMessage(content=report_prompt)])
        detailed_report = response.content
        print(f"[INFO] Detailed report generated by LLM, length={len(detailed_report)}")
    except Exception as e:
        print(f"[WARN] LLM report generation failed: {e}; using fallback content")
        detailed_report = f"""### 1. Event Overview
{event_description or 'No detailed description available'}

### 2. Cause Analysis
Limited information available; no specific cause analysis at this time.

### 3. Impact and Loss Assessment
Limited information available; no specific loss data at this time.

### 4. Emergency Response and Rescue Operations
Limited information available; no specific rescue information at this time.

### 5. Post-disaster Recovery and Lessons Learned
Limited information available; no recovery progress information at this time.

### 6. Comprehensive Summary
This flood event has caused certain impacts. Further information collection is needed for a complete assessment."""
    
    # 格式化来源信息
    sources_text = _format_sources_text(_pending_search_sources)
    
    # 组装最终报告
    flood_report = FLOOD_REPORT_TEMPLATE.format(
        event=event or "Unknown event",
        pre_date=pre_date or "To be determined",
        peek_date=peek_date or "To be determined",
        after_date=after_date or "To be determined",
        location=location or "To be determined",
        detailed_report=detailed_report,
        sources=sources_text
    )
    
    # 保存来源信息
    search_sources = _pending_search_sources.copy() if _pending_search_sources else []
    
    # 创建报告完成消息
    report_message = AIMessage(content=f"✅ Information confirmed, report generated!\n\n{flood_report}")
    
    # 生成 GEE JavaScript 代码
    gee_code = ""
    try:
        gee_code = generate_flood_gee_code(
            event_name=event or "Flood Event",
            pre_date=pre_date or "",
            peek_date=peek_date or "",
            location=location or "",
            coordinates=coordinates,
            bounds=bounds,
            geojson=geojson
        )
        print(f"[INFO] GEE code generated successfully, length={len(gee_code)}")
    except Exception as e:
        print(f"[WARN] GEE code generation failed: {e}")
    
    print(f"[INFO] Report generation completed with {len(search_sources)} reference sources")
    
    return Command(
        goto="__end__",
        update={
            "messages": report_message,
            "event": event,
            "event_description": event_description,
            "flood_report": flood_report,
            "report_document": flood_report,  # 同步到可编辑的文档
            "pre_date": pre_date,
            "after_date": after_date,
            "peek_date": peek_date,
            "location": location,
            "coordinates": coordinates,
            "bounds": bounds,
            "geojson": geojson,
            "resolved_aoi": state.get("resolved_aoi"),
            "aoi_resolution_meta": state.get("aoi_resolution_meta"),
            "confirmed_aoi": confirmed_aoi,
            "recommended_layers": state.get("recommended_layers") or [],
            "selected_layer_ids": state.get("selected_layer_ids") or [],
            "mentioned_layer_refs": state.get("mentioned_layer_refs") or [],
            "mentioned_aoi": state.get("mentioned_aoi"),
            "mentioned_aoi_source": state.get("mentioned_aoi_source"),
            "confirmation_version": state.get("confirmation_version") or 1,
            "geo_data": geo_data,
            "search_sources": search_sources,
            "gee_code": gee_code,
            "stage": "completed",
            "user_confirmed": True,
            "is_valid_flood_query": True,
        }
    )


# ============== 构建图 ==============

workflow = StateGraph(FloodAgentState)

# 添加节点 - 清晰的职责分离
workflow.add_node("entry_node", entry_node)           # 入口路由
workflow.add_node("intent_node", intent_node)         # LLM intent classification
workflow.add_node("chat_node", chat_node)             # LLM 对话 + 工具调用
workflow.add_node("tool_node", ToolNode(tools=tools)) # 工具执行
workflow.add_node("extraction_node", extraction_node) # 信息提取
workflow.add_node("pre_confirmation_node", pre_confirmation_node)
workflow.add_node("confirmation_node", confirmation_node)  # 用户确认 (HITL)
workflow.add_node("processing_node", processing_node) # 地理编码 + 报告生成
# workflow.add_node("__end__", lambda state, config: None)

# 设置入口点
workflow.set_entry_point("entry_node")

# 添加边 - 定义流程
workflow.add_edge("tool_node", "chat_node")  # 工具执行后回到聊天节点
# 编译图
checkpointer = MemorySaver()
graph = workflow.compile(checkpointer=checkpointer)


# ============== 图结构说明 ==============
"""
重构后的图结构 (5个主要节点):

                    ┌─────────────────┐
                    │   entry_node    │  入口路由
                    │   (判断阶段)     │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
              ┌────▶│   chat_node     │◀────┐
              │     │  (LLM对话)       │     │
              │     └────────┬────────┘     │
              │              │              │
              │    ┌─────────┴─────────┐    │
              │    │                   │    │
              │    ▼                   ▼    │
      ┌───────┴────────┐    ┌─────────────────┐
      │   tool_node    │    │ extraction_node │
      │  (工具执行)     │    │   (信息提取)    │
      └────────────────┘    └────────┬────────┘
                                     │
                      ┌──────────────┴──────────────┐
                      │                             │
                      ▼                             ▼
            ┌─────────────────┐            ┌───────────────┐
            │confirmation_node│            │    __end__    │
            │   (HITL确认)    │            │   (普通结束)   │
            └────────┬────────┘            └───────────────┘
                     │
          ┌──────────┴──────────┐
          │                     │
          ▼                     ▼
 ┌─────────────────┐   ┌───────────────┐
 │processing_node  │   │    __end__    │
 │(地理编码+报告)   │   │   (用户取消)  │
 └────────┬────────┘   └───────────────┘
          │
          ▼
 ┌───────────────┐
 │    __end__    │
 │  (流程完成)    │
 └───────────────┘

节点职责:
- entry_node: 入口路由，判断阶段，处理状态重置
- chat_node: LLM 对话处理，工具调用决策
- tool_node: 执行搜索工具
- extraction_node: 从 LLM 响应提取结构化数据
- confirmation_node: Human-in-the-Loop 用户确认
- processing_node: 地理编码 + 报告生成
"""

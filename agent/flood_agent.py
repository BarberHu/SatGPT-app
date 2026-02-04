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
import requests
from typing import Literal, Optional, Dict, Any

from dotenv import load_dotenv
from langchain.tools import tool
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph
from langgraph.prebuilt import ToolNode
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt

from state import FloodAgentState
from prompts import SYSTEM_PROMPT, FLOOD_REPORT_TEMPLATE, REPORT_GENERATION_PROMPT

load_dotenv()

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
        
        prompt = f"""请判断以下地名的类型：

地名: {location_name}

判断标准:
1. "administrative" - 独立的行政区域，如：国家、省/州、市、县、区等有明确行政边界的地区
   例如：北京市、德国、加利福尼亚州、东京都、巴黎

2. "composite" - 组合地名、地理区位或自然区域，包括：
   - 多个行政区域的组合：京津冀、长三角、珠三角、欧盟
   - 地理区位概念：华北地区、东南亚、中东
   - 自然地理区域：黄河流域、亚马逊盆地、阿尔卑斯山区
   - 跨行政区域的地理单元：密西西比河流域、多瑙河平原

请严格按以下JSON格式返回，不要包含其他文字：
```json
{{"type": "administrative或composite", "reason": "简短说明"}}
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
        
        print(f"🔍 地名类型判断: {location_name} -> {location_type} ({reason})")
        return {"type": location_type, "reason": reason}
        
    except Exception as e:
        print(f"⚠️ LLM判断地名类型失败: {e}，默认为行政区域")
        return {"type": "administrative", "reason": "判断失败，使用默认值"}


def _generate_geojson_with_llm(location_name: str) -> Optional[Dict[str, Any]]:
    """
    使用LLM生成组合区域的大致GeoJSON边界
    适用于：组合地名、地理区位、自然区域等非标准行政区域
    """
    try:
        model = _get_model()
        
        prompt = f"""请为以下地理区域生成一个大致的GeoJSON边界数据。

地理区域名称: {location_name}

要求:
1. 生成一个简化的多边形(Polygon)边界，用4-8个顶点即可表示大致范围
2. 坐标格式为 [经度, 纬度]，使用WGS84坐标系
3. 多边形必须闭合（首尾坐标相同）
4. 同时提供中心点坐标和边界框

请严格按照以下JSON格式返回，不要包含任何其他文字：

```json
{{
    "center": [经度, 纬度],
    "bounds": {{
        "west": 最西经度,
        "south": 最南纬度,
        "east": 最东经度,
        "north": 最北纬度
    }},
    "geometry": {{
        "type": "Polygon",
        "coordinates": [[[经度1, 纬度1], [经度2, 纬度2], ..., [经度1, 纬度1]]]
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
            raise ValueError("缺少必要字段")
        
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
        
        print(f"✅ LLM成功生成地理数据: {location_name}")
        return {
            "location": location_name,
            "coordinates": data['center'],
            "bounds": data['bounds'],
            "geojson": geojson_feature,
            "type": "composite_region",
            "source": "LLM_generated"
        }
        
    except Exception as e:
        print(f"❌ LLM生成GeoJSON失败: {e}")
        return None


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
            'accept-language': 'zh-CN,en'  # 优先中文，其次英文
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
        print(f"⚠️ Nominatim查询失败: {e}")
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
    print(f"📍 正在获取地理数据: {location_name}")
    
    # 使用LLM判断地名类型
    classification = _classify_location_type(location_name)
    is_composite = classification["type"] == "composite"
    
    if is_composite:
        print(f"🔍 检测到组合区域，使用LLM生成GeoJSON: {location_name}")
        result = _generate_geojson_with_llm(location_name)
        if result:
            return result
        # LLM失败时尝试Nominatim
        print(f"⚠️ LLM生成失败，尝试Nominatim...")
    
    # 尝试Nominatim API
    print(f"🌐 尝试从Nominatim获取: {location_name}")
    result = _get_location_from_nominatim(location_name)
    
    if result:
        print(f"✅ 成功获取地理数据: {location_name}")
        return result
    
    # Nominatim失败，尝试LLM
    if not is_composite:
        print(f"⚠️ Nominatim未找到，尝试LLM生成: {location_name}")
        result = _generate_geojson_with_llm(location_name)
        if result:
            return result
    
    # 所有方法都失败
    print(f"❌ 无法获取地理数据: {location_name}")
    return {
        "location": location_name,
        "coordinates": [0.0, 0.0],
        "bounds": {"south": -90, "north": 90, "west": -180, "east": 180},
        "geojson": None,
        "error": f"无法获取 '{location_name}' 的地理信息"
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
    
    return updates


def _format_sources_text(sources: list) -> str:
    """格式化来源信息为 Markdown 文本"""
    if not sources:
        return "*本报告信息综合自网络公开资料*"
    
    lines = []
    # 显示所有来源
    for i, source in enumerate(sources, 1):
        title = source.get("title", "未知来源")
        url = source.get("url", "#")
        lines.append(f"{i}. [{title}]({url})")
    
    result = "\n".join(lines) if lines else "*本报告信息综合自网络公开资料*"
    
    # 如果来源不足10条，添加说明
    if len(sources) < 10:
        result = f"**说明**: 由于该洪水事件公开报道数量有限，本次事件相关信息源较少（共 {len(sources)} 条），以下分析基于现有可获取的权威资料进行整理。\n\n" + result
    
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
_pending_search_contents: list = []  # 存储完整的搜索内容用于报告生成

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
        tavily_client = TavilyClient(api_key=os.getenv("TAVILY_API_KEY"))
        
        # 使用多个搜索策略获取更多来源
        all_results = []
        all_sources = []
        seen_urls = set()
        
        # 搜索策略1：基本搜索
        enhanced_query = f"{query} 洪水 灾害 时间 日期"
        response = tavily_client.search(
            query=enhanced_query,
            search_depth="advanced",
            max_results=8,
            include_answer=True
        )
        
        results = []
        if response.get("answer"):
            results.append(f"综合答案: {response['answer']}")
        
        for result in response.get("results", []):
            url = result.get("url", "")
            if url and url not in seen_urls:
                seen_urls.add(url)
                title = result.get("title", "")
                content = result.get("content", "")
                results.append(f"标题: {title}\n内容: {content}\n来源: {url}\n")
                if title and url:
                    all_sources.append({"title": title, "url": url, "content": content})
        
        # 搜索策略2：搜索影响和损失
        impact_query = f"{query} 影响 损失 伤亡 受灾"
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
                    content = result.get("content", "")
                    results.append(f"标题: {title}\n内容: {content}\n来源: {url}\n")
                    if title and url:
                        all_sources.append({"title": title, "url": url, "content": content})
        except:
            pass
        
        # 搜索策略3：搜索应急响应
        rescue_query = f"{query} 救援 应急 响应 转移"
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
                    content = result.get("content", "")
                    results.append(f"标题: {title}\n内容: {content}\n来源: {url}\n")
                    if title and url:
                        all_sources.append({"title": title, "url": url, "content": content})
        except:
            pass
        
        _pending_search_sources = [{"title": s["title"], "url": s["url"]} for s in all_sources]
        _pending_search_contents = all_sources  # 存储完整内容用于报告生成
        
        print(f"📚 搜索完成，获取到 {len(all_sources)} 条信息来源")
        
        return "\n---\n".join(results) if results else "未找到相关洪水事件信息"
        
    except Exception as e:
        _pending_search_sources = []
        _pending_search_contents = []
        return f"搜索出错: {str(e)}"


# 工具列表
tools = [search_flood_event]


# ============== 节点定义 ==============

# 定义节点路由类型
NodeType = Literal["chat_node", "tool_node", "extraction_node", "confirmation_node", "processing_node", "__end__"]


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
            }
        )
    
    return Command(goto="chat_node")


async def chat_node(
    state: FloodAgentState, config: RunnableConfig
) -> Command[NodeType]:
    """
    聊天节点 - 处理 LLM 对话和工具调用
    
    职责：
    1. 与 LLM 交互
    2. 处理工具调用请求
    3. 路由到 tool_node 或 extraction_node
    """
    model = _get_model()
    
    # 获取前端工具并绑定所有工具
    fe_tools = state.get("copilotkit", {}).get("actions", [])
    model_with_tools = model.bind_tools([*fe_tools, *tools])
    
    # 构建系统提示
    current_stage = state.get('stage', 'initial')
    system_message = SystemMessage(
        content=f"""{SYSTEM_PROMPT}

【当前阶段】: {current_stage}
用户询问洪水事件时，使用 search_flood_event 工具搜索信息。
搜索后在回复末尾附加 JSON 格式的事件信息。
"""
    )
    
    # 调用模型
    response = await model_with_tools.ainvoke(
        [system_message, *state["messages"]],
        config,
    )
    
    # 检查是否需要调用工具
    tool_calls = response.tool_calls
    
    if tool_calls and _should_route_to_tool_node(tool_calls, fe_tools):
        return Command(
            goto="tool_node", 
            update={"messages": response}
        )
    
    # 没有工具调用，进入提取节点分析响应
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
    print(f"📍 提取节点处理消息，共 {len(messages)} 条")
    if not messages:
        return Command(goto="__end__")
    
    last_message = messages[-1]
    content = str(last_message.content) if hasattr(last_message, 'content') else str(last_message)
    
    print(f"🔍 提取节点分析内容:\n{content}\n")
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
    
    # 如果有完整信息且未确认，进入确认节点
    if has_complete_info and not user_confirmed and current_stage != "completed":
        return Command(
            goto="confirmation_node",
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
    
    # 使用 interrupt 暂停执行，等待用户确认
    confirmed_data_raw = interrupt({
        "type": "confirm_flood_event",
        "message": "请确认或修改以下洪水事件信息：",
        "data": {
            "event": event,
            "event_description": event_description,
            "location": location,
            "pre_date": pre_date,
            "peek_date": peek_date,
            "after_date": after_date,
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
        cancel_message = AIMessage(content="已取消。如需重新查询，请告诉我您想了解的洪水事件。")
        return Command(
            goto="__end__",
            update={
                "messages": cancel_message,
                "stage": "initial",
                "user_confirmed": False,
            }
        )
    
    # 用户确认，更新数据并进入处理节点
    print(f"📍 用户已确认事件信息")
    
    return Command(
        goto="processing_node",
        update={
            "event": confirmed_data.get("event", event),
            "event_description": confirmed_data.get("event_description", event_description),
            "location": confirmed_data.get("location", location),
            "pre_date": confirmed_data.get("pre_date", pre_date),
            "peek_date": confirmed_data.get("peek_date", peek_date),
            "after_date": confirmed_data.get("after_date", after_date),
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
    
    print(f"📍 正在获取地理坐标: {location}")
    
    # 获取地理坐标
    geo_data = _get_location_coordinates_internal(location) if location else None
    
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
            search_contents_text += f"### 来源 {i}: {title}\n{content}\n来源链接: {url}\n\n"
    else:
        search_contents_text = "暂无搜索资料，请基于事件描述进行分析。"
    
    # 使用 LLM 生成详细报告
    print(f"📝 正在使用 LLM 生成详细报告...")
    model = _get_model()
    
    report_prompt = REPORT_GENERATION_PROMPT.format(
        event=event or "未知事件",
        location=location or "待确定",
        pre_date=pre_date or "待确定",
        peek_date=peek_date or "待确定",
        after_date=after_date or "待确定",
        search_contents=search_contents_text
    )
    
    try:
        response = model.invoke([HumanMessage(content=report_prompt)])
        detailed_report = response.content
        print(f"✅ LLM 生成报告成功，字数: {len(detailed_report)}")
    except Exception as e:
        print(f"⚠️ LLM 生成报告失败: {e}，使用默认内容")
        detailed_report = f"""### 1. 事件概述
{event_description or '暂无详细描述'}

### 2. 成因分析
相关资料有限，暂无具体成因分析。

### 3. 影响与损失评估
相关资料有限，暂无具体损失数据。

### 4. 应急响应与救援行动
相关资料有限，暂无具体救援信息。

### 5. 灾后恢复与问题反思
相关资料有限，暂无恢复进展信息。

### 6. 综合总结
本次洪水事件造成了一定影响，具体情况有待进一步信息收集。"""
    
    # 格式化来源信息
    sources_text = _format_sources_text(_pending_search_sources)
    
    # 组装最终报告
    flood_report = FLOOD_REPORT_TEMPLATE.format(
        event=event or "未知事件",
        pre_date=pre_date or "待确定",
        peek_date=peek_date or "待确定",
        after_date=after_date or "待确定",
        location=location or "待确定",
        detailed_report=detailed_report,
        sources=sources_text
    )
    
    # 保存来源信息
    search_sources = _pending_search_sources.copy() if _pending_search_sources else []
    
    # 创建报告完成消息
    report_message = AIMessage(content=f"✅ 信息已确认，报告生成完成！\n\n{flood_report}")
    
    print(f"✅ 报告生成完成，共 {len(search_sources)} 条参考来源")
    
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
            "geo_data": geo_data,
            "search_sources": search_sources,
            "stage": "completed",
            "user_confirmed": True,
            "is_valid_flood_query": True,
        }
    )


# ============== 构建图 ==============

workflow = StateGraph(FloodAgentState)

# 添加节点 - 清晰的职责分离
workflow.add_node("entry_node", entry_node)           # 入口路由
workflow.add_node("chat_node", chat_node)             # LLM 对话 + 工具调用
workflow.add_node("tool_node", ToolNode(tools=tools)) # 工具执行
workflow.add_node("extraction_node", extraction_node) # 信息提取
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

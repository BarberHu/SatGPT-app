"""
洪水智能体工具定义
"""
import os
from langchain_core.tools import tool
from tavily import TavilyClient
from dotenv import load_dotenv

load_dotenv()


@tool
def search_flood_event(query: str) -> dict:
    """
    搜索洪水事件的相关信息。
    
    Args:
        query: 搜索查询，应包含洪水事件名称、地点、时间等关键信息
        
    Returns:
        包含搜索结果和来源信息的字典
    """
    try:
        tavily_client = TavilyClient(api_key=os.getenv("TAVILY_API_KEY"))
        
        # 添加洪水相关关键词优化搜索
        enhanced_query = f"{query} 洪水 灾害 时间 日期"
        
        response = tavily_client.search(
            query=enhanced_query,
            search_depth="advanced",
            max_results=5,
            include_answer=True
        )
        
        # 提取搜索结果和来源
        results = []
        sources = []
        
        if response.get("answer"):
            results.append(f"综合答案: {response['answer']}")
        
        for result in response.get("results", []):
            title = result.get("title", "")
            content = result.get("content", "")
            url = result.get("url", "")
            results.append(f"标题: {title}\n内容: {content}\n来源: {url}\n")
            
            # 收集来源信息
            if title and url:
                sources.append({"title": title, "url": url})
        
        return {
            "content": "\n---\n".join(results) if results else "未找到相关洪水事件信息",
            "sources": sources
        }
        
    except Exception as e:
        return {
            "content": f"搜索出错: {str(e)}",
            "sources": []
        }


@tool
def extract_flood_dates(event_info: str) -> dict:
    """
    从洪水事件信息中提取关键日期。
    
    Args:
        event_info: 包含洪水事件信息的文本
        
    Returns:
        包含 pre_date, peek_date, after_date 的字典
    """
    # 这个工具主要作为提示，实际日期提取由LLM完成
    return {
        "instruction": "请从以下信息中提取洪水事件的关键日期：洪水前日期(pre_date)、洪峰日期(peek_date)、洪水后日期(after_date)",
        "event_info": event_info
    }



# 工具列表
flood_tools = [
    search_flood_event,
    extract_flood_dates,
]

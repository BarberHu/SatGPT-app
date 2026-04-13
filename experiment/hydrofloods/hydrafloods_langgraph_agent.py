from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, TypedDict

from dotenv import load_dotenv
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from token_utils import empty_token_usage, record_llm_usage
from tool_library import (
    TOOL_HANDLERS,
    TOOL_LIBRARY,
    find_tool_by_intent,
    get_tool_spec,
    render_tool_catalog_for_llm,
)


ROOT_DOTENV = Path(__file__).resolve().parents[2] / ".env"


ActionName = Literal[
    "describe_tools",
    "water_mapping",
    "flood_extent",
    "depth_estimation",
]


class AgentState(TypedDict, total=False):
    query: str
    environment: Dict[str, Any]
    parsed_request: Dict[str, Any]
    selected_tool: str
    tool_result: Dict[str, Any]
    token_usage: Dict[str, Any]
    response: str


TOOL_NAMES = [tool["name"] for tool in TOOL_LIBRARY]


class QueryPlan(BaseModel):
    selected_tool: str = Field(description=f"One of: {', '.join(TOOL_NAMES)}")
    dataset: Optional[str] = Field(default=None, description="One of Sentinel1, Sentinel2, Landsat7, Landsat8, Modis, Viirs")
    dates: List[str] = Field(default_factory=list, description="Up to two ISO dates in YYYY-MM-DD")
    bbox: Optional[List[float]] = Field(default=None, description="Bounding box as [west, south, east, north]")
    algorithm: str = Field(default="edge_otsu", description="edge_otsu or bmax_otsu")
    reference: str = Field(default="seasonal", description="seasonal, yearly, or occurrence")


DATASET_ALIASES = {
    "sentinel1": "Sentinel1",
    "sentinel-1": "Sentinel1",
    "s1": "Sentinel1",
    "哨兵1": "Sentinel1",
    "哨兵-1": "Sentinel1",
    "sar": "Sentinel1",
    "雷达": "Sentinel1",
    "sentinel2": "Sentinel2",
    "sentinel-2": "Sentinel2",
    "s2": "Sentinel2",
    "哨兵2": "Sentinel2",
    "哨兵-2": "Sentinel2",
    "landsat8": "Landsat8",
    "landsat-8": "Landsat8",
    "l8": "Landsat8",
    "landsat7": "Landsat7",
    "landsat-7": "Landsat7",
    "l7": "Landsat7",
    "modis": "Modis",
    "viirs": "Viirs",
}


ACTION_PATTERNS: Dict[ActionName, List[str]] = {
    "describe_tools": ["能力", "能做什么", "tool", "tools", "支持什么", "有哪些工具"],
    "depth_estimation": ["fwdet", "水深", "depth"],
    "flood_extent": ["洪水范围", "淹没范围", "flood extent", "extract flood", "洪水提取"],
    "water_mapping": ["水体", "积水", "积涝", "water map", "water mapping", "edge otsu", "bmax otsu", "mndwi"],
}


def _normalize_query(query: str) -> str:
    return query.lower().replace("：", ":").replace("，", ",").strip()


def _extract_bbox(query: str) -> Optional[List[float]]:
    patterns = [
        r"(?:bbox|bounds|region)\s*(?:=|:|为)?\s*\[?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]?",
        r"边界(?:框)?\s*(?:=|:|为)?\s*\[?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]?",
    ]
    for pattern in patterns:
        match = re.search(pattern, query, flags=re.IGNORECASE)
        if match:
            return [float(match.group(i)) for i in range(1, 5)]
    return None


def _extract_dates(query: str) -> List[str]:
    return re.findall(r"\d{4}-\d{2}-\d{2}", query)


def _detect_action(normalized_query: str) -> ActionName:
    for action in ["describe_tools", "depth_estimation", "flood_extent", "water_mapping"]:
        if any(token in normalized_query for token in ACTION_PATTERNS[action]):  # type: ignore[index]
            return action  # type: ignore[return-value]
    return "describe_tools"


def _detect_dataset(normalized_query: str) -> Optional[str]:
    compact_query = re.sub(r"[\s_]+", "", normalized_query)
    for alias, dataset in DATASET_ALIASES.items():
        normalized_alias = re.sub(r"[\s_]+", "", alias)
        if alias in normalized_query or normalized_alias in compact_query:
            return dataset
    return None


def _detect_algorithm(normalized_query: str) -> str:
    if "bmax" in normalized_query:
        return "bmax_otsu"
    return "edge_otsu"


def _detect_reference(normalized_query: str) -> str:
    for name in ["seasonal", "yearly", "occurrence"]:
        if name in normalized_query:
            return name
    return "seasonal"


def _build_missing_fields(action: ActionName, dataset: Optional[str], dates: List[str], bbox: Optional[List[float]]) -> List[str]:
    if action == "describe_tools":
        return []

    missing: List[str] = []
    if not dataset:
        missing.append("dataset")
    if len(dates) < 2:
        missing.append("date_range")
    if not bbox:
        missing.append("bbox")
    return missing


def _heuristic_parse(query: str) -> Dict[str, Any]:
    normalized_query = _normalize_query(query)
    action = _detect_action(normalized_query)
    dataset = _detect_dataset(normalized_query)
    dates = _extract_dates(normalized_query)
    bbox = _extract_bbox(normalized_query)
    algorithm = _detect_algorithm(normalized_query)
    reference = _detect_reference(normalized_query)

    return {
        "action": action,
        "dataset": dataset,
        "dates": dates[:2],
        "bbox": bbox,
        "algorithm": algorithm,
        "reference": reference,
    }


def _candidate_tools(heuristic: Dict[str, Any]) -> List[str]:
    action = heuristic["action"]
    if action == "describe_tools":
        return [
            "describe_hydrafloods_tools",
            "get_water_extent_tile",
            "get_flood_extent_tile",
            "estimate_flood_depth_tile",
        ]
    if action == "water_mapping":
        return ["get_water_extent_tile", "get_flood_extent_tile", "estimate_flood_depth_tile"]
    if action == "flood_extent":
        return ["get_flood_extent_tile", "estimate_flood_depth_tile", "get_water_extent_tile"]
    return ["estimate_flood_depth_tile", "get_flood_extent_tile", "get_water_extent_tile"]


def _get_parser_model() -> ChatOpenAI:
    return ChatOpenAI(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        api_key=os.getenv("OPENAI_API_KEY"),
        base_url=os.getenv("OPENAI_API_BASE"),
        temperature=0,
        max_tokens=120,
    )


def _parse_query_with_llm(
    query: str,
    token_usage: Optional[Dict[str, Any]] = None,
    token_tracking_enabled: bool = False,
) -> Dict[str, Any]:
    heuristic = _heuristic_parse(query)
    candidate_tools = _candidate_tools(heuristic)
    candidate_catalog = render_tool_catalog_for_llm(candidate_tools)
    model_name = os.getenv("LLM_MODEL", "gpt-4o-mini")

    prompt = (
        "Route one hydrafloods task.\n"
        "Choose exactly one tool from the catalog.\n"
        "Datasets: Sentinel1, Sentinel2, Landsat7, Landsat8, Modis, Viirs\n"
        "Algorithms: edge_otsu, bmax_otsu\n"
        "References: seasonal, yearly, occurrence\n"
        "Rules: choose exactly one tool; use describe_hydrafloods_tools for capability/tool questions; "
        "use water_mapping for water/ponding/积水/water-layer requests; "
        "use flood_extent only for explicit flood extent / inundation / 淹没范围 requests; "
        "depth_estimation means fwdet water depth.\n"
        f"Tool catalog:\n{candidate_catalog}\n"
        f"Heuristic hints: {json.dumps(heuristic, ensure_ascii=False)}\n"
        f"User query: {query}"
    )

    planner = _get_parser_model().with_structured_output(QueryPlan, include_raw=True)
    plan = planner.invoke([HumanMessage(content=prompt)])
    parsed = plan["parsed"].model_dump()

    if token_tracking_enabled and token_usage is not None:
        record_llm_usage(
            token_usage=token_usage,
            phase="route_query",
            model=model_name,
            raw_response=plan.get("raw"),
        )

    if parsed.get("selected_tool") not in TOOL_NAMES:
        fallback = find_tool_by_intent(heuristic["action"])
        parsed["selected_tool"] = fallback["name"] if fallback else "describe_hydrafloods_tools"

    if parsed.get("dataset") not in set(DATASET_ALIASES.values()):
        parsed["dataset"] = heuristic.get("dataset")

    if not parsed.get("dates"):
        parsed["dates"] = heuristic.get("dates", [])
    parsed["dates"] = parsed.get("dates", [])[:2]

    if not parsed.get("bbox"):
        parsed["bbox"] = heuristic.get("bbox")

    if parsed.get("algorithm") not in {"edge_otsu", "bmax_otsu"}:
        parsed["algorithm"] = heuristic.get("algorithm", "edge_otsu")

    if parsed.get("reference") not in {"seasonal", "yearly", "occurrence"}:
        parsed["reference"] = heuristic.get("reference", "seasonal")

    tool_spec = get_tool_spec(parsed["selected_tool"])
    parsed["action"] = tool_spec["intent"]
    parsed["missing_fields"] = _build_missing_fields(
        tool_spec["intent"],
        parsed.get("dataset"),
        parsed.get("dates", []),
        parsed.get("bbox"),
    )
    parsed["heuristic_hints"] = heuristic
    return parsed


def detect_environment_node(state: AgentState) -> AgentState:
    load_dotenv(ROOT_DOTENV)
    token_tracking_enabled = str(os.getenv("HYDRAFLOODS_TOKEN_TRACE", "0")).lower() in {"1", "true", "yes", "on"}
    if state.get("environment", {}).get("token_tracking_enabled") is True:
        token_tracking_enabled = True
    return {
        "environment": {
            "gee_project_id": "configured",
            "llm_model": os.getenv("LLM_MODEL", "gpt-4o-mini"),
            "token_tracking_enabled": token_tracking_enabled,
        }
    }


def parse_request_node(state: AgentState) -> AgentState:
    token_tracking_enabled = state["environment"]["token_tracking_enabled"]
    token_usage = state.get("token_usage") or empty_token_usage(token_tracking_enabled)
    parsed_request = _parse_query_with_llm(
        state["query"],
        token_usage=token_usage,
        token_tracking_enabled=token_tracking_enabled,
    )
    return {"parsed_request": parsed_request, "token_usage": token_usage}


def select_tool_node(state: AgentState) -> AgentState:
    return {"selected_tool": state["parsed_request"]["selected_tool"]}


def execute_tool_node(state: AgentState) -> AgentState:
    parsed = state["parsed_request"]

    if parsed["missing_fields"]:
        return {
            "tool_result": {
                "status": "error",
                "summary": f"缺少必要参数: {', '.join(parsed['missing_fields'])}",
                "inputs": parsed,
            }
        }

    tool_name = state["selected_tool"]
    handler = TOOL_HANDLERS[tool_name]
    if tool_name == "describe_hydrafloods_tools":
        tool_result = handler()
    elif tool_name == "get_water_extent_tile":
        tool_result = handler(
            dataset=parsed["dataset"],
            start_date=parsed["dates"][0],
            end_date=parsed["dates"][1],
            bbox=parsed["bbox"],
            algorithm=parsed["algorithm"],
        )
    elif tool_name == "get_flood_extent_tile":
        tool_result = handler(
            dataset=parsed["dataset"],
            start_date=parsed["dates"][0],
            end_date=parsed["dates"][1],
            bbox=parsed["bbox"],
            algorithm=parsed["algorithm"],
            reference=parsed["reference"],
        )
    elif tool_name == "estimate_flood_depth_tile":
        tool_result = handler(
            dataset=parsed["dataset"],
            start_date=parsed["dates"][0],
            end_date=parsed["dates"][1],
            bbox=parsed["bbox"],
            algorithm=parsed["algorithm"],
            reference=parsed["reference"],
        )
    else:
        raise ValueError(f"Unsupported tool: {tool_name}")

    return {"tool_result": tool_result}


def _render_registry(result: Dict[str, Any]) -> str:
    registry = result["registry"]
    lines = [
        "# HYDRAFloods Tool-Agent 实验结果",
        "",
        f"- GEE Project: `{result['gee_project_id']}`",
        "",
        "## 工具层",
    ]
    for name, desc in registry["task_tools"].items():
        lines.append(f"- `{name}`: {desc}")
    lines.extend(
        [
            "",
            "## 数据与算法",
            f"- 数据集: {', '.join(registry['datasets']['supported'])}",
            f"- 推荐数据集: {', '.join(registry['datasets']['recommended'])}",
            f"- 水体算法: {', '.join(registry['algorithms']['water_mapping'])}",
            f"- 洪水算法: {', '.join(registry['algorithms']['flood'])}",
            f"- 水深算法: {', '.join(registry['algorithms']['depth'])}",
            "",
            "## 工程边界",
        ]
    )
    lines.extend([f"- {item}" for item in registry["engineering_boundaries"]])
    return "\n".join(lines)


def _render_token_usage(token_usage: Optional[Dict[str, Any]]) -> List[str]:
    if not token_usage or not token_usage.get("enabled"):
        return []

    totals = token_usage["totals"]
    lines = [
        "",
        "## Token Usage",
        f"- prompt_tokens: `{totals['prompt_tokens']}`",
        f"- completion_tokens: `{totals['completion_tokens']}`",
        f"- total_tokens: `{totals['total_tokens']}`",
    ]
    for item in token_usage.get("llm_calls", []):
        lines.append(
            f"- {item['phase']} ({item['model']}): prompt={item['prompt_tokens']}, completion={item['completion_tokens']}, total={item['total_tokens']}"
        )
    return lines


def _render_tool_result(
    result: Dict[str, Any],
    parsed: Dict[str, Any],
    tool_name: str,
    token_usage: Optional[Dict[str, Any]] = None,
) -> str:
    if result["status"] != "ok":
        lines = [
            "# HYDRAFloods Tool-Agent 实验结果",
            "",
            f"- 工具: `{tool_name}`",
            f"- 错误: {result['summary']}",
        ]
        lines.extend(_render_token_usage(token_usage))
        return "\n".join(lines)

    lines = [
        "# HYDRAFloods Tool-Agent 实验结果",
        "",
        f"- 工具: `{tool_name}`",
        f"- 动作: `{parsed['action']}`",
        f"- 数据集: `{parsed.get('dataset')}`",
        f"- 日期: `{', '.join(parsed.get('dates', []))}`",
        f"- 边界框: `{parsed.get('bbox')}`",
        f"- 算法: `{parsed.get('algorithm')}`",
        "",
        f"结论: {result['summary']}",
    ]

    primary_layer = result.get("artifacts", {}).get("primary_layer")
    if primary_layer:
        lines.append(f"- Tile URL: {primary_layer['tile_url']}")
        lines.append(f"- Thumbnail URL: {primary_layer['thumbnail_url']}")

    metadata = result.get("metadata", {})
    if metadata:
        lines.extend(
            [
                "",
                "## 元数据",
            ]
        )
        for key, value in metadata.items():
            lines.append(f"- {key}: `{value}`")

    if result.get("repro_code"):
        lines.extend(
            [
                "",
                "## 复现代码",
                "```python",
                result["repro_code"],
                "```",
            ]
        )
    lines.extend(_render_token_usage(token_usage))
    return "\n".join(lines)


def format_response_node(state: AgentState) -> AgentState:
    parsed = state["parsed_request"]
    tool_name = state["selected_tool"]
    result = state["tool_result"]
    token_usage = state.get("token_usage")

    if tool_name == "describe_hydrafloods_tools":
        response = _render_registry(result)
        token_lines = _render_token_usage(token_usage)
        if token_lines:
            response = response + "\n" + "\n".join(token_lines)
        return {"response": response}
    return {"response": _render_tool_result(result, parsed, tool_name, token_usage=token_usage)}


def build_graph():
    workflow = StateGraph(AgentState)
    workflow.add_node("detect_environment", detect_environment_node)
    workflow.add_node("parse_request", parse_request_node)
    workflow.add_node("select_tool", select_tool_node)
    workflow.add_node("execute_tool", execute_tool_node)
    workflow.add_node("format_response", format_response_node)

    workflow.add_edge(START, "detect_environment")
    workflow.add_edge("detect_environment", "parse_request")
    workflow.add_edge("parse_request", "select_tool")
    workflow.add_edge("select_tool", "execute_tool")
    workflow.add_edge("execute_tool", "format_response")
    workflow.add_edge("format_response", END)
    return workflow.compile()


GRAPH = build_graph()


EXAMPLES = [
    "请列出当前 HYDRAFloods 工具层暴露了哪些任务工具。",
    "请用 Landsat 8 在 bbox=[90.30,23.60,90.50,23.80] 上，对 2020-07-01 到 2020-07-15 做水体提取。",
    "请用 Sentinel-1 在 bbox=[90.30,23.60,90.50,23.80] 上，对 2020-07-01 到 2020-07-15 做洪水范围提取。",
    "请用 Sentinel-1 在 bbox=[90.30,23.60,90.50,23.80] 上，对 2020-07-01 到 2020-07-15 做水深估算。",
]


def main() -> None:
    parser = argparse.ArgumentParser(description="LangGraph + HYDRAFloods 本地工具适配实验")
    parser.add_argument("--query", type=str, help="自然语言查询")
    parser.add_argument("--json", action="store_true", help="输出完整 JSON 状态")
    parser.add_argument("--examples", action="store_true", help="打印内置示例")
    parser.add_argument("--token-stats", action="store_true", help="开启一次问答过程中的 token 用量统计")
    args = parser.parse_args()

    if args.examples:
        print(json.dumps(EXAMPLES, ensure_ascii=False, indent=2))
        return

    if not args.query:
        raise SystemExit("请通过 --query 传入自然语言请求，或通过 --examples 查看示例。")

    initial_state: Dict[str, Any] = {"query": args.query}
    if args.token_stats:
        initial_state["environment"] = {"token_tracking_enabled": True}

    final_state = GRAPH.invoke(initial_state)
    if args.json:
        print(json.dumps(final_state, ensure_ascii=False, indent=2))
    else:
        print(final_state["response"])


if __name__ == "__main__":
    main()

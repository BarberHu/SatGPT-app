from __future__ import annotations

import argparse
import json
import os
import re
import traceback
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, TypedDict

from dotenv import load_dotenv
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

# SATGPT_TRACE_DELETE_ME_START
from debug_trace import new_debug_trace, summarize_tool_result, trace_event
# SATGPT_TRACE_DELETE_ME_END
from adapter import execute_tool, preflight_asset_recommendation
from token_utils import empty_token_usage, record_llm_usage
from tool_library import (
    TOOL_LIBRARY,
    find_tool_by_intent,
    get_tool_spec,
    render_tool_catalog_for_llm,
)


ROOT_DOTENV = Path(__file__).resolve().parents[2] / ".env"


ActionName = Literal[
    "describe_tools",
    "asset_recommendation",
    "water_mapping",
    "flood_extent",
    "depth_estimation",
]


class AgentState(TypedDict, total=False):
    query: str
    environment: Dict[str, Any]
    debug_trace: Dict[str, Any]
    parsed_request: Dict[str, Any]
    execution_plan: Dict[str, Any]
    preflight: Dict[str, Any]
    selected_tool: str
    tool_result: Dict[str, Any]
    token_usage: Dict[str, Any]
    response: str


TOOL_NAMES = [tool["name"] for tool in TOOL_LIBRARY]

ACTION_PRIORITY = (
    "describe_tools",
    "asset_recommendation",
    "depth_estimation",
    "flood_extent",
    "water_mapping",
)

RECOMMENDATION_HINTS = (
    "推荐",
    "recommend",
    "asset",
    "产品",
    "reference layer",
    "参考图层",
    "现成数据",
    "现成资产",
    "baseline",
    "context",
    "archive",
    "历史",
)

ASSET_FIRST_HINTS = (
    "优先",
    "先看",
    "先展示",
    "reference",
    "参考",
    "baseline",
    "context",
    "现成资产",
    "现成数据",
)

OPTICAL_DATASETS = {"Sentinel2", "Landsat7", "Landsat8", "Modis", "Viirs"}
COMPUTE_INTENTS = ("water_mapping", "flood_extent", "depth_estimation")

CANDIDATE_TOOL_MAP = {
    "describe_tools": [
        "describe_hydrafloods_tools",
        "recommend_flood_asset_layers",
    ],
    "asset_recommendation": ["recommend_flood_asset_layers"],
    "water_mapping": ["get_water_extent_tile", "get_flood_extent_tile", "estimate_flood_depth_tile"],
    "flood_extent": ["get_flood_extent_tile", "estimate_flood_depth_tile", "get_water_extent_tile"],
    "depth_estimation": ["estimate_flood_depth_tile", "get_flood_extent_tile", "get_water_extent_tile"],
}


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
    "asset_recommendation": ["推荐数据", "推荐产品", "数据产品", "asset", "dataset recommendation", "reference layer", "图层推荐"],
    "depth_estimation": ["fwdet", "水深", "depth"],
    "flood_extent": ["洪水范围", "淹没范围", "flood extent", "extract flood", "洪水提取"],
    "water_mapping": ["水体", "积水", "积涝", "water map", "water mapping", "edge otsu", "bmax otsu", "mndwi"],
}


def _trace(debug_trace: Dict[str, Any], node: str, phase: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    return trace_event(debug_trace, node=node, phase=phase, payload=payload)


def _get_debug_trace(state: AgentState, enabled: bool = False) -> Dict[str, Any]:
    return state.get("debug_trace") or new_debug_trace(enabled)


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
    for action in ACTION_PRIORITY:
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
    if action == "asset_recommendation":
        return [] if bbox else ["bbox"]

    missing: List[str] = []
    if not dataset:
        missing.append("dataset")
    if len(dates) < 2:
        missing.append("date_range")
    if not bbox:
        missing.append("bbox")
    return missing


def _query_has_any_hint(normalized_query: str, hints: tuple[str, ...]) -> bool:
    return any(hint in normalized_query for hint in hints)


def _detect_compute_action(normalized_query: str) -> Optional[ActionName]:
    for action in ("depth_estimation", "flood_extent", "water_mapping"):
        if any(token in normalized_query for token in ACTION_PATTERNS[action]):  # type: ignore[index]
            return action  # type: ignore[return-value]
    return None


def _primary_tool_from_plan(execution_plan: Dict[str, Any]) -> str:
    return execution_plan["primary_tool"]


def _build_execution_plan(query: str, parsed: Dict[str, Any]) -> Dict[str, Any]:
    normalized_query = _normalize_query(query)
    selected_tool = parsed["selected_tool"]
    selected_intent = get_tool_spec(selected_tool)["intent"]
    compute_action = _detect_compute_action(normalized_query)
    wants_asset_recommendation = (
        selected_tool == "recommend_flood_asset_layers"
        or _query_has_any_hint(normalized_query, RECOMMENDATION_HINTS)
    )
    primary_output = "assets" if _query_has_any_hint(normalized_query, ASSET_FIRST_HINTS) else "compute"

    compute_tool: Optional[str] = None
    if selected_intent in COMPUTE_INTENTS:
        compute_tool = selected_tool
    elif compute_action:
        fallback = find_tool_by_intent(compute_action)
        compute_tool = fallback["name"] if fallback else None

    if selected_tool == "describe_hydrafloods_tools":
        return {
            "mode": "describe_only",
            "primary_tool": "describe_hydrafloods_tools",
            "compute_tool": None,
            "asset_tool": None,
            "primary_output": "describe",
        }

    if wants_asset_recommendation and not compute_tool:
        return {
            "mode": "assets_only",
            "primary_tool": "recommend_flood_asset_layers",
            "compute_tool": None,
            "asset_tool": "recommend_flood_asset_layers",
            "primary_output": "assets",
        }

    if wants_asset_recommendation and compute_tool:
        return {
            "mode": "hybrid",
            "primary_tool": "recommend_flood_asset_layers" if primary_output == "assets" else compute_tool,
            "compute_tool": compute_tool,
            "asset_tool": "recommend_flood_asset_layers",
            "primary_output": primary_output,
        }

    return {
        "mode": "compute_only",
        "primary_tool": compute_tool or selected_tool,
        "compute_tool": compute_tool or selected_tool,
        "asset_tool": None,
        "primary_output": "compute",
    }


def _preflight_asset_checks(parsed: Dict[str, Any], execution_plan: Dict[str, Any]) -> Dict[str, Any]:
    return preflight_asset_recommendation(
        parsed,
        enabled=execution_plan["mode"] in {"assets_only", "hybrid"},
    )


def _preflight_sensor_checks(parsed: Dict[str, Any], execution_plan: Dict[str, Any]) -> Dict[str, Any]:
    if execution_plan["mode"] not in {"compute_only", "hybrid"}:
        return {"blocking_issues": [], "warnings": []}

    warnings: List[str] = []
    dataset = parsed.get("dataset")
    compute_tool = execution_plan.get("compute_tool")
    action = get_tool_spec(compute_tool)["intent"] if compute_tool else parsed.get("action")

    if action == "flood_extent" and dataset in OPTICAL_DATASETS:
        warnings.append("当前洪水范围提取使用光学传感器，可能受云和阴影影响。")
    if action == "depth_estimation" and dataset != "Sentinel1":
        warnings.append("当前水深估算更适合先使用 Sentinel-1 生成稳态洪水范围。")
    if action == "water_mapping" and dataset == "Sentinel1":
        warnings.append("当前 Sentinel-1 水体提取链路对阈值和时序合成较敏感，建议结合参考资产图层一起判断。")
    return {"blocking_issues": [], "warnings": warnings}


def _run_preflight_checks(query: str, parsed: Dict[str, Any], execution_plan: Dict[str, Any]) -> Dict[str, Any]:
    blocking_issues = list(parsed.get("missing_fields", []))
    warnings: List[str] = []

    if blocking_issues:
        blocking_issues = [f"缺少必要参数: {', '.join(blocking_issues)}"]

    asset_checks = _preflight_asset_checks(parsed, execution_plan)
    sensor_checks = _preflight_sensor_checks(parsed, execution_plan)
    blocking_issues.extend(asset_checks["blocking_issues"])
    blocking_issues.extend(sensor_checks["blocking_issues"])
    warnings.extend(asset_checks["warnings"])
    warnings.extend(sensor_checks["warnings"])

    return {
        "status": "error" if blocking_issues else "ok",
        "blocking_issues": blocking_issues,
        "warnings": warnings,
        "checked_query": query,
    }


def _merge_asset_result_into_compute(compute_result: Dict[str, Any], asset_result: Dict[str, Any]) -> Dict[str, Any]:
    merged = deepcopy(compute_result)
    merged["recommendations"] = asset_result.get("recommendations", [])
    merged.setdefault("artifacts", {})
    merged["artifacts"]["recommended_layers"] = asset_result.get("artifacts", {}).get("layers", [])
    merged.setdefault("metadata", {})
    merged["metadata"]["recommended_asset_count"] = asset_result.get("metadata", {}).get("recommended_asset_count", 0)
    return merged


def _merge_compute_result_into_assets(asset_result: Dict[str, Any], compute_result: Dict[str, Any]) -> Dict[str, Any]:
    merged = deepcopy(asset_result)
    compute_layer = compute_result.get("artifacts", {}).get("primary_layer")
    merged.setdefault("artifacts", {})
    merged.setdefault("metadata", {})
    merged["analysis_result"] = {
        "tool_name": compute_result.get("tool_name"),
        "summary": compute_result.get("summary"),
        "metadata": compute_result.get("metadata", {}),
    }
    merged["metadata"]["analysis_tool"] = compute_result.get("tool_name")
    if compute_layer:
        merged["artifacts"].setdefault("layers", [])
        merged["artifacts"]["layers"].append(
            {
                **compute_layer,
                "visible": False,
            }
        )
    return merged


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
    return CANDIDATE_TOOL_MAP[heuristic["action"]]


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
        "use recommend_flood_asset_layers for data-product recommendation or reference-layer requests; "
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
    debug_trace_enabled = str(os.getenv("HYDRAFLOODS_DEBUG_TRACE", "0")).lower() in {"1", "true", "yes", "on"}
    if state.get("environment", {}).get("token_tracking_enabled") is True:
        token_tracking_enabled = True
    if state.get("environment", {}).get("debug_trace_enabled") is True:
        debug_trace_enabled = True

    debug_trace = _get_debug_trace(state, debug_trace_enabled)
    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="detect_environment",
        phase="enter",
        payload={"query": state.get("query")},
    )
    # SATGPT_TRACE_DELETE_ME_END
    environment = {
        "gee_project_id": "configured",
        "llm_model": os.getenv("LLM_MODEL", "gpt-4o-mini"),
        "token_tracking_enabled": token_tracking_enabled,
        "debug_trace_enabled": debug_trace_enabled,
    }
    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="detect_environment",
        phase="exit",
        payload=environment,
    )
    # SATGPT_TRACE_DELETE_ME_END
    return {"environment": environment, "debug_trace": debug_trace}


def parse_request_node(state: AgentState) -> AgentState:
    debug_trace = _get_debug_trace(state)
    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="parse_request",
        phase="enter",
        payload={"query": state["query"]},
    )
    # SATGPT_TRACE_DELETE_ME_END
    token_tracking_enabled = state["environment"]["token_tracking_enabled"]
    token_usage = state.get("token_usage") or empty_token_usage(token_tracking_enabled)
    parsed_request = _parse_query_with_llm(
        state["query"],
        token_usage=token_usage,
        token_tracking_enabled=token_tracking_enabled,
    )
    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="parse_request",
        phase="exit",
        payload={"parsed_request": parsed_request, "token_usage": token_usage.get("totals")},
    )
    # SATGPT_TRACE_DELETE_ME_END
    return {"parsed_request": parsed_request, "token_usage": token_usage, "debug_trace": debug_trace}


def plan_execution_node(state: AgentState) -> AgentState:
    debug_trace = _get_debug_trace(state)
    execution_plan = _build_execution_plan(state["query"], state["parsed_request"])
    parsed_request = deepcopy(state["parsed_request"])
    parsed_request["primary_action"] = get_tool_spec(execution_plan["primary_tool"])["intent"]
    if execution_plan.get("compute_tool"):
        parsed_request["compute_action"] = get_tool_spec(execution_plan["compute_tool"])["intent"]
    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="plan_execution",
        phase="planned",
        payload=execution_plan,
    )
    # SATGPT_TRACE_DELETE_ME_END
    return {
        "execution_plan": execution_plan,
        "parsed_request": parsed_request,
        "debug_trace": debug_trace,
    }


def preflight_check_node(state: AgentState) -> AgentState:
    debug_trace = _get_debug_trace(state)
    preflight = _run_preflight_checks(
        state["query"],
        state["parsed_request"],
        state["execution_plan"],
    )
    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="preflight_check",
        phase="completed",
        payload=preflight,
    )
    # SATGPT_TRACE_DELETE_ME_END
    return {"preflight": preflight, "debug_trace": debug_trace}


def select_tool_node(state: AgentState) -> AgentState:
    debug_trace = _get_debug_trace(state)
    selected_tool = _primary_tool_from_plan(state["execution_plan"])
    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="select_tool",
        phase="selected",
        payload={
            "selected_tool": selected_tool,
            "mode": state["execution_plan"].get("mode"),
            "action": state["parsed_request"].get("action"),
        },
    )
    # SATGPT_TRACE_DELETE_ME_END
    return {"selected_tool": selected_tool, "debug_trace": debug_trace}


def execute_tool_node(state: AgentState) -> AgentState:
    parsed = state["parsed_request"]
    debug_trace = _get_debug_trace(state)
    preflight = state["preflight"]
    execution_plan = state["execution_plan"]

    if preflight["blocking_issues"]:
        # SATGPT_TRACE_DELETE_ME_START
        debug_trace = _trace(
            debug_trace,
            node="execute_tool",
            phase="blocked_preflight",
            payload={"preflight": preflight, "parsed_request": parsed},
        )
        # SATGPT_TRACE_DELETE_ME_END
        return {
            "tool_result": {
                "status": "error",
                "summary": "执行前检查未通过。",
                "inputs": parsed,
                "preflight": preflight,
            },
            "debug_trace": debug_trace,
        }

    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="execute_tool",
        phase="plan_dispatch",
        payload=execution_plan,
    )
    # SATGPT_TRACE_DELETE_ME_END
    try:
        mode = execution_plan["mode"]
        if mode == "describe_only":
            tool_name = "describe_hydrafloods_tools"
            tool_result = execute_tool(tool_name, parsed, state["query"])
        elif mode == "assets_only":
            tool_name = "recommend_flood_asset_layers"
            tool_result = execute_tool(tool_name, parsed, state["query"])
        elif mode == "compute_only":
            tool_name = execution_plan["compute_tool"]
            # SATGPT_TRACE_DELETE_ME_START
            debug_trace = _trace(
                debug_trace,
                node="execute_tool",
                phase="tool_call",
                payload={"tool_name": tool_name, "parsed_request": parsed},
            )
            # SATGPT_TRACE_DELETE_ME_END
            tool_result = execute_tool(tool_name, parsed, state["query"])
        elif mode == "hybrid":
            compute_tool = execution_plan["compute_tool"]
            asset_tool = execution_plan["asset_tool"]
            # SATGPT_TRACE_DELETE_ME_START
            debug_trace = _trace(
                debug_trace,
                node="execute_tool",
                phase="hybrid_calls",
                payload={
                    "compute_tool": compute_tool,
                    "parsed_request": parsed,
                    "asset_tool": asset_tool,
                },
            )
            # SATGPT_TRACE_DELETE_ME_END
            asset_result = execute_tool(asset_tool, parsed, state["query"])
            compute_result = execute_tool(compute_tool, parsed, state["query"])
            if execution_plan["primary_output"] == "assets":
                tool_name = asset_tool
                tool_result = _merge_compute_result_into_assets(asset_result, compute_result)
            else:
                tool_name = compute_tool
                tool_result = _merge_asset_result_into_compute(compute_result, asset_result)
        else:
            raise ValueError(f"Unsupported execution mode: {mode}")
    except Exception as exc:
        # SATGPT_TRACE_DELETE_ME_START
        debug_trace = _trace(
            debug_trace,
            node="execute_tool",
            phase="tool_exception",
            payload={
                "tool_name": state.get("selected_tool"),
                "exception_type": type(exc).__name__,
                "exception_message": str(exc),
                "traceback": traceback.format_exc(),
            },
        )
        # SATGPT_TRACE_DELETE_ME_END
        raise

    tool_result.setdefault("metadata", {})
    tool_result["metadata"]["execution_mode"] = execution_plan["mode"]
    if preflight["warnings"]:
        tool_result["metadata"]["preflight_warning_count"] = len(preflight["warnings"])
    tool_result["preflight"] = preflight

    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="execute_tool",
        phase="tool_result",
        payload=summarize_tool_result(tool_result),
    )
    # SATGPT_TRACE_DELETE_ME_END
    return {"tool_result": tool_result, "debug_trace": debug_trace}


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
            f"- 精选资产数: {registry['assets']['asset_count']}",
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
        preflight = result.get("preflight", {})
        if preflight.get("blocking_issues"):
            lines.extend(
                [
                    "",
                    "## 执行前检查",
                ]
            )
            for item in preflight["blocking_issues"]:
                lines.append(f"- {item}")
        lines.extend(_render_token_usage(token_usage))
        return "\n".join(lines)

    lines = [
        "# HYDRAFloods Tool-Agent 实验结果",
        "",
        f"- 工具: `{tool_name}`",
        f"- 动作: `{parsed.get('primary_action', parsed['action'])}`",
        f"- 数据集: `{parsed.get('dataset')}`",
        f"- 日期: `{', '.join(parsed.get('dates', []))}`",
        f"- 边界框: `{parsed.get('bbox')}`",
        f"- 算法: `{parsed.get('algorithm')}`",
        "",
        f"结论: {result['summary']}",
    ]

    preflight = result.get("preflight", {})
    if preflight.get("warnings"):
        lines.extend(
            [
                "",
                "## 执行前检查",
            ]
        )
        for item in preflight["warnings"]:
            lines.append(f"- {item}")

    primary_layer = result.get("artifacts", {}).get("primary_layer")
    if primary_layer:
        lines.append(f"- Tile URL: {primary_layer['tile_url']}")
        lines.append(f"- Thumbnail URL: {primary_layer['thumbnail_url']}")

    recommendations = result.get("recommendations", [])
    if recommendations:
        lines.extend(
            [
                "",
                "## 推荐资产",
            ]
        )
        for item in recommendations:
            lines.append(
                f"- `{item['asset_id']}` ({item['title']}): score={item['score']}, reason={item['reason']}"
            )

    recommended_layers = result.get("artifacts", {}).get("recommended_layers", [])
    if recommended_layers:
        lines.extend(
            [
                "",
                "## 推荐图层",
            ]
        )
        for layer in recommended_layers:
            lines.append(
                f"- `{layer['asset_id']}`: {layer['tile_url']}"
            )

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
    debug_trace = _get_debug_trace(state)

    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="format_response",
        phase="enter",
        payload={
            "tool_name": tool_name,
            "result_status": result.get("status"),
        },
    )
    # SATGPT_TRACE_DELETE_ME_END

    if tool_name == "describe_hydrafloods_tools":
        response = _render_registry(result)
        token_lines = _render_token_usage(token_usage)
        if token_lines:
            response = response + "\n" + "\n".join(token_lines)
        # SATGPT_TRACE_DELETE_ME_START
        debug_trace = _trace(
            debug_trace,
            node="format_response",
            phase="exit",
            payload={"response_length": len(response)},
        )
        # SATGPT_TRACE_DELETE_ME_END
        return {"response": response, "debug_trace": debug_trace}

    response = _render_tool_result(result, parsed, tool_name, token_usage=token_usage)
    # SATGPT_TRACE_DELETE_ME_START
    debug_trace = _trace(
        debug_trace,
        node="format_response",
        phase="exit",
        payload={"response_length": len(response)},
    )
    # SATGPT_TRACE_DELETE_ME_END
    return {"response": response, "debug_trace": debug_trace}


def build_graph():
    workflow = StateGraph(AgentState)
    workflow.add_node("detect_environment", detect_environment_node)
    workflow.add_node("parse_request", parse_request_node)
    workflow.add_node("plan_execution", plan_execution_node)
    workflow.add_node("preflight_check", preflight_check_node)
    workflow.add_node("select_tool", select_tool_node)
    workflow.add_node("execute_tool", execute_tool_node)
    workflow.add_node("format_response", format_response_node)

    workflow.add_edge(START, "detect_environment")
    workflow.add_edge("detect_environment", "parse_request")
    workflow.add_edge("parse_request", "plan_execution")
    workflow.add_edge("plan_execution", "preflight_check")
    workflow.add_edge("preflight_check", "select_tool")
    workflow.add_edge("select_tool", "execute_tool")
    workflow.add_edge("execute_tool", "format_response")
    workflow.add_edge("format_response", END)
    return workflow.compile()


GRAPH = build_graph()


EXAMPLES = [
    "请列出当前 HYDRAFloods 工具层暴露了哪些任务工具。",
    "请推荐适合这个区域洪水分析的数据产品，并把可用图层挂到地图上，bbox=[90.30,23.60,90.50,23.80]，时间是2020-07-01到2020-07-15。",
    "请用 Landsat 8 在 bbox=[90.30,23.60,90.50,23.80] 上，对 2020-07-01 到 2020-07-15 做水体提取。",
    "请用 Sentinel-1 在 bbox=[90.30,23.60,90.50,23.80] 上，对 2020-07-01 到 2020-07-15 做洪水范围提取。",
    "请用 Sentinel-1 在 bbox=[90.30,23.60,90.50,23.80] 上，对 2020-07-01 到 2020-07-15 做水深估算。",
]


def run_agent_query(
    query: str,
    *,
    token_stats: bool = True,
    debug_trace: bool = False,
) -> Dict[str, Any]:
    initial_state: Dict[str, Any] = {"query": query}
    if token_stats or debug_trace:
        initial_state["environment"] = {}
    if token_stats:
        initial_state["environment"]["token_tracking_enabled"] = True
    if debug_trace:
        initial_state["environment"]["debug_trace_enabled"] = True
    return GRAPH.invoke(initial_state)


def main() -> None:
    parser = argparse.ArgumentParser(description="LangGraph + HYDRAFloods 本地工具适配实验")
    parser.add_argument("--query", type=str, help="自然语言查询")
    parser.add_argument("--json", action="store_true", help="输出完整 JSON 状态")
    parser.add_argument("--examples", action="store_true", help="打印内置示例")
    parser.add_argument("--token-stats", action="store_true", help="开启一次问答过程中的 token 用量统计")
    parser.add_argument("--debug-trace", action="store_true", help="输出 graph 节点和工具调用的详细跟踪日志")
    args = parser.parse_args()

    if args.examples:
        print(json.dumps(EXAMPLES, ensure_ascii=False, indent=2))
        return

    if not args.query:
        raise SystemExit("请通过 --query 传入自然语言请求，或通过 --examples 查看示例。")

    final_state = run_agent_query(
        args.query,
        token_stats=args.token_stats,
        debug_trace=args.debug_trace,
    )
    if args.json:
        print(json.dumps(final_state, ensure_ascii=False, indent=2))
    else:
        print(final_state["response"])


if __name__ == "__main__":
    main()

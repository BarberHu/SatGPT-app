from __future__ import annotations

from typing import Any, Dict, List, Optional

from assets_library import build_assets_registry_summary


TOOL_LIBRARY: List[Dict[str, Any]] = [
    {
        "name": "describe_hydrafloods_tools",
        "intent": "describe_tools",
        "summary": "列出当前实验暴露给 LangGraph 的本地任务级工具。",
        "when_to_use": "当用户想了解支持什么能力、有哪些工具、当前边界是什么时使用。",
        "when_not_to_use": "当用户已经明确要执行水体、洪水或水深任务时不要使用。",
        "required_fields": [],
        "optional_fields": [],
        "defaults": {},
        "returns": ["registry", "gee_project_id", "engineering_boundaries"],
        "examples": [
            "列出当前 HYDRAFloods 工具层暴露了哪些任务工具。",
        ],
    },
    {
        "name": "get_water_extent_tile",
        "intent": "water_mapping",
        "summary": "执行水体提取，并返回在线地图 tile URL 和缩略图。",
        "when_to_use": "当用户要看积水图、水体图、水体范围图、water layer 时使用。",
        "when_not_to_use": "当用户明确要求洪水范围或水深估算时不要使用。",
        "required_fields": ["dataset", "start_date", "end_date", "bbox"],
        "optional_fields": ["algorithm"],
        "defaults": {"algorithm": "edge_otsu"},
        "returns": ["tile_url", "thumbnail_url", "metadata", "repro_code"],
        "examples": [
            "帮我给这个区域做一层可以直接挂在线地图上的积水图。",
        ],
    },
    {
        "name": "recommend_flood_asset_layers",
        "intent": "asset_recommendation",
        "summary": "推荐适合当前洪水/水体问题的数据产品，并返回可直接挂到地图上的资产图层。",
        "when_to_use": "当用户想知道该看哪些现成 GEE 数据产品、想快速挂参考图层或想做多源对比时使用。",
        "when_not_to_use": "当用户只想执行 HYDRAFloods 原生水体/洪水/水深工作流且不需要额外产品推荐时不要单独使用。",
        "required_fields": ["bbox"],
        "optional_fields": ["dataset", "start_date", "end_date"],
        "defaults": {},
        "returns": ["recommendations", "tile_url", "layers", "legend_spec"],
        "examples": [
            "请推荐适合这个洪水问题的数据产品，并直接把图层挂到地图上。",
        ],
    },
    {
        "name": "get_flood_extent_tile",
        "intent": "flood_extent",
        "summary": "执行洪水范围提取，并返回在线地图 tile URL 和缩略图。",
        "when_to_use": "当用户明确要求淹没范围、洪水范围、flood extent 图层时使用。",
        "when_not_to_use": "当用户只是要一般水体图或明确要水深时不要使用。",
        "required_fields": ["dataset", "start_date", "end_date", "bbox"],
        "optional_fields": ["algorithm", "reference"],
        "defaults": {"algorithm": "edge_otsu", "reference": "seasonal"},
        "returns": ["tile_url", "thumbnail_url", "metadata", "repro_code"],
        "examples": [
            "我想看同一块区域的淹没范围图层。",
        ],
    },
    {
        "name": "estimate_flood_depth_tile",
        "intent": "depth_estimation",
        "summary": "执行 FwDET 水深估算，并返回在线地图 tile URL 和缩略图。",
        "when_to_use": "当用户明确要求水深、深度分布、depth map、FwDET 时使用。",
        "when_not_to_use": "当用户只要水体或洪水范围图时不要使用。",
        "required_fields": ["dataset", "start_date", "end_date", "bbox"],
        "optional_fields": ["algorithm", "reference", "dem_asset"],
        "defaults": {
            "algorithm": "edge_otsu",
            "reference": "seasonal",
            "dem_asset": "USGS/SRTMGL1_003",
        },
        "returns": ["tile_url", "thumbnail_url", "metadata", "repro_code"],
        "examples": [
            "请生成这片区域的洪水水深图。",
        ],
    },
]


SUPPORTED_DATASETS = ["Sentinel1", "Sentinel2", "Landsat7", "Landsat8", "Modis", "Viirs"]
RECOMMENDED_DATASETS = ["Sentinel1", "Sentinel2", "Landsat8"]
ALGORITHM_REGISTRY = {
    "water_mapping": ["edge_otsu", "bmax_otsu"],
    "flood": ["extract_flood"],
    "depth": ["fwdet"],
}
ENGINEERING_BOUNDARIES = [
    "adapter 层只负责执行 HYDRAFloods 工作流，不直接承担工具注册和目录维护。",
    "tool library 层负责维护工具目录和工具说明，是 agent 的工具单一事实来源。",
    "工具层返回结构化结果、工件链接和元数据，不把 ee.Image 等内部对象暴露给 LLM。",
    "本地工具依赖规范环境变量 GOOGLE_APPLICATION_CREDENTIALS 和 GEE_PROJECT_ID。",
]


def build_tool_registry() -> Dict[str, Any]:
    return {
        "assets": build_assets_registry_summary(),
        "datasets": {
            "supported": SUPPORTED_DATASETS,
            "recommended": RECOMMENDED_DATASETS,
        },
        "task_tools": {tool["name"]: tool["summary"] for tool in TOOL_LIBRARY},
        "algorithms": ALGORITHM_REGISTRY,
        "engineering_boundaries": ENGINEERING_BOUNDARIES,
    }


def get_tool_spec(tool_name: str) -> Dict[str, Any]:
    for tool in TOOL_LIBRARY:
        if tool["name"] == tool_name:
            return tool
    raise KeyError(f"Unknown tool: {tool_name}")


def find_tool_by_intent(intent: str) -> Optional[Dict[str, Any]]:
    for tool in TOOL_LIBRARY:
        if tool["intent"] == intent:
            return tool
    return None


def shortlist_tools(tool_names: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    if not tool_names:
        return TOOL_LIBRARY
    selected = []
    allowed = set(tool_names)
    for tool in TOOL_LIBRARY:
        if tool["name"] in allowed:
            selected.append(tool)
    return selected


def render_tool_catalog_for_llm(tool_names: Optional[List[str]] = None) -> str:
    lines: List[str] = []
    for tool in shortlist_tools(tool_names):
        lines.append(f"- {tool['name']}")
        lines.append(f"  intent: {tool['intent']}")
        lines.append(f"  summary: {tool['summary']}")
        lines.append(f"  use: {tool['when_to_use']}")
        if tool["required_fields"]:
            lines.append(f"  required: {', '.join(tool['required_fields'])}")
        if tool["optional_fields"]:
            lines.append(f"  optional: {', '.join(tool['optional_fields'])}")
        if tool["defaults"]:
            defaults = ", ".join(f"{k}={v}" for k, v in tool["defaults"].items())
            lines.append(f"  defaults: {defaults}")
    return "\n".join(lines)


def render_tool_library_markdown() -> str:
    lines = [
        "# HYDRAFloods Tool Library",
        "",
        "这份目录是当前 experiment 中供 LangGraph 使用的本地工具库视图。",
        "",
    ]
    for tool in TOOL_LIBRARY:
        lines.extend(
            [
                f"## {tool['name']}",
                "",
                f"- Intent: `{tool['intent']}`",
                f"- Summary: {tool['summary']}",
                f"- When to use: {tool['when_to_use']}",
                f"- When not to use: {tool['when_not_to_use']}",
                f"- Required fields: {', '.join(tool['required_fields']) if tool['required_fields'] else 'None'}",
                f"- Optional fields: {', '.join(tool['optional_fields']) if tool['optional_fields'] else 'None'}",
                f"- Defaults: {tool['defaults'] if tool['defaults'] else '{}'}",
                f"- Returns: {', '.join(tool['returns'])}",
                "- Example:",
                f"  - {tool['examples'][0]}",
                "",
            ]
        )
    return "\n".join(lines)

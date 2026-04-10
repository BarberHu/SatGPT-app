from __future__ import annotations

import json
from typing import Literal, Optional

from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph
from langgraph.types import Command, interrupt

from state import FloodAgentState
from water_asset_service import ParsedAssetQuery, TokenUsageEntry, WaterAssetService


water_asset_service = WaterAssetService()


NodeType = Literal[
    "chat_node",
    "asset_parse_node",
    "asset_recommend_node",
    "asset_selection_node",
    "asset_render_node",
    "__end__",
]


def _latest_user_text(state: FloodAgentState) -> str:
    messages = state.get("messages", [])
    for message in reversed(messages):
        role = getattr(message, "type", None) or getattr(message, "role", None)
        if role not in {"human", "user"}:
            continue
        content = getattr(message, "content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text")
                    if text:
                        parts.append(str(text))
            return "\n".join(parts)
        return str(content)
    return ""


def _thread_id_from_config(config: RunnableConfig) -> Optional[str]:
    configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
    return configurable.get("thread_id") or configurable.get("conversation_id")


def _serialize_usage(entries: list[TokenUsageEntry]) -> list[dict]:
    return [entry.__dict__.copy() for entry in entries]


def _reset_payload() -> dict:
    return {
        "stage": "water_initial",
        "user_confirmed": False,
        "event": None,
        "event_description": None,
        "flood_report": None,
        "report_document": None,
        "pre_date": None,
        "peek_date": None,
        "after_date": None,
        "is_valid_flood_query": False,
        "search_sources": [],
        "gee_code": None,
        "agent_intent": None,
        "query_themes": [],
        "recommended_assets": [],
        "selected_asset_ids": [],
        "water_asset_layers": [],
        "token_usage": [],
        "token_cost_summary": {},
    }


async def entry_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    current_stage = state.get("stage")
    if current_stage in {"water_ready", "water_cancelled", "water_render_failed", "completed"}:
        return Command(goto="chat_node", update=_reset_payload())
    return Command(goto="chat_node", update={"stage": "water_initial"})


async def chat_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    return Command(goto="asset_parse_node")


async def asset_parse_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    question = _latest_user_text(state)
    if not question:
        return Command(goto="__end__")

    parsed_query, usage_entries = await water_asset_service.parse_query(question)
    update = {
        "stage": "water_parsed",
        "agent_intent": parsed_query.agent_intent,
        "query_themes": parsed_query.themes,
        "location": parsed_query.location,
        "pre_date": parsed_query.start_date,
        "peek_date": parsed_query.end_date,
        "after_date": None,
        "coordinates": parsed_query.coordinates,
        "bounds": parsed_query.bounds,
        "geojson": parsed_query.geojson,
        "event_description": parsed_query.answer,
        "token_usage": _serialize_usage(usage_entries),
        "token_cost_summary": water_asset_service.summarize_usage(usage_entries),
    }
    return Command(goto="asset_recommend_node", update=update)


async def asset_recommend_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    parsed_query = ParsedAssetQuery(
        raw_question=_latest_user_text(state),
        answer=state.get("event_description") or "",
        agent_intent=state.get("agent_intent") or "discover",
        need_visualization=True,
        themes=list(state.get("query_themes") or ["surface_water"]),
        location=state.get("location"),
        start_date=state.get("pre_date"),
        end_date=state.get("peek_date"),
        coordinates=state.get("coordinates"),
        bounds=state.get("bounds"),
        geojson=state.get("geojson"),
    )
    recommended_assets, usage_entries = water_asset_service.recommend_assets(parsed_query)
    total_entries = [
        *[
            TokenUsageEntry(**entry)
            for entry in state.get("token_usage", [])
            if isinstance(entry, dict)
        ],
        *usage_entries,
    ]
    serialized_assets = water_asset_service.serialize_assets(recommended_assets, parsed_query)

    if not serialized_assets:
        message = AIMessage(
            content=(
                "I couldn't find a suitable water dataset yet. Add a location, time range, "
                "or use case and I'll refine the recommendation."
            )
        )
        summary = water_asset_service.summarize_usage(total_entries)
        print(
            json.dumps(
                water_asset_service.build_usage_log(
                    thread_id=_thread_id_from_config(config),
                    agent_intent=parsed_query.agent_intent,
                    usage_entries=total_entries,
                ),
                ensure_ascii=False,
            )
        )
        return Command(
            goto="__end__",
            update={
                "messages": message,
                "stage": "water_ready",
                "recommended_assets": [],
                "selected_asset_ids": [],
                "water_asset_layers": [],
                "token_usage": _serialize_usage(total_entries),
                "token_cost_summary": summary,
            },
        )

    intro = AIMessage(
        content=(
            f"{state.get('event_description') or 'Intent parsed.'}\n\n"
            f"I found {len(serialized_assets)} candidate water datasets. Choose the layers you want to add to the map."
        )
    )
    return Command(
        goto="asset_selection_node",
        update={
            "messages": intro,
            "stage": "water_recommended",
            "recommended_assets": serialized_assets,
            "token_usage": _serialize_usage(total_entries),
            "token_cost_summary": water_asset_service.summarize_usage(total_entries),
        },
    )


async def asset_selection_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    recommended_assets = state.get("recommended_assets") or []
    default_ids = [recommended_assets[0]["asset_id"]] if recommended_assets else []
    selected_payload_raw = interrupt(
        {
            "type": "select_water_assets",
            "message": "Choose the water datasets to load on the map.",
            "recommended_assets": recommended_assets,
            "preselected_asset_ids": default_ids,
        }
    )

    if isinstance(selected_payload_raw, str):
        try:
            selected_payload = json.loads(selected_payload_raw)
        except json.JSONDecodeError:
            selected_payload = {}
    elif isinstance(selected_payload_raw, dict):
        selected_payload = selected_payload_raw
    else:
        selected_payload = {}

    if selected_payload.get("cancelled"):
        usage_entries = [
            *[
                TokenUsageEntry(**entry)
                for entry in state.get("token_usage", [])
                if isinstance(entry, dict)
            ],
            TokenUsageEntry(
                stage="asset_selection_explain",
                model=water_asset_service.model_name,
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                estimated_cost_usd=0.0,
                source="human_interrupt",
                note="User cancelled the water dataset selection.",
            ),
        ]
        message = AIMessage(
            content="Cancelled this layer selection. You can ask a new question or choose datasets again."
        )
        return Command(
            goto="__end__",
            update={
                "messages": message,
                "stage": "water_cancelled",
                "selected_asset_ids": [],
                "water_asset_layers": [],
                "token_usage": _serialize_usage(usage_entries),
                "token_cost_summary": water_asset_service.summarize_usage(usage_entries),
            },
        )

    selected_asset_ids = selected_payload.get("selected_asset_ids") or default_ids
    return Command(
        goto="asset_render_node",
        update={
            "stage": "water_selection_done",
            "selected_asset_ids": selected_asset_ids,
        },
    )


async def asset_render_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    selected_asset_ids = state.get("selected_asset_ids") or []
    usage_entries = [
        TokenUsageEntry(**entry)
        for entry in state.get("token_usage", [])
        if isinstance(entry, dict)
    ]
    usage_entries.append(
        TokenUsageEntry(
            stage="asset_selection_explain",
            model=water_asset_service.model_name,
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
            estimated_cost_usd=0.0,
            source="human_interrupt",
            note="User completed the water dataset selection.",
        )
    )

    try:
        layers = water_asset_service.render_assets(
            selected_asset_ids,
            location_hint=state.get("location"),
            start_date=state.get("pre_date"),
            end_date=state.get("peek_date"),
        )
    except Exception as exc:
        summary = water_asset_service.summarize_usage(usage_entries)
        print(
            json.dumps(
                water_asset_service.build_usage_log(
                    thread_id=_thread_id_from_config(config),
                    agent_intent=state.get("agent_intent") or "discover",
                    usage_entries=usage_entries,
                ),
                ensure_ascii=False,
            )
        )
        return Command(
            goto="__end__",
            update={
                "messages": AIMessage(
                    content=(
                        "Dataset selection finished, but layer rendering failed. "
                        f"Reason: {str(exc)}. Please check GEE authentication or refine the query area and try again."
                    )
                ),
                "stage": "water_render_failed",
                "water_asset_layers": [],
                "token_usage": _serialize_usage(usage_entries),
                "token_cost_summary": summary,
            },
        )

    first_layer = layers[0] if layers else {}
    first_center = first_layer.get("map_center") or []
    coordinates = (
        [first_center[1], first_center[0]]
        if isinstance(first_center, (list, tuple)) and len(first_center) >= 2
        else state.get("coordinates")
    )
    selected_titles = [layer["title"] for layer in layers]
    message = AIMessage(
        content=(
            "Added these layers to the map: "
            + (", ".join(selected_titles) if selected_titles else "no available layers")
        )
    )
    summary = water_asset_service.summarize_usage(usage_entries)
    print(
        json.dumps(
            water_asset_service.build_usage_log(
                thread_id=_thread_id_from_config(config),
                agent_intent=state.get("agent_intent") or "discover",
                usage_entries=usage_entries,
            ),
            ensure_ascii=False,
        )
    )
    return Command(
        goto="__end__",
        update={
            "messages": message,
            "stage": "water_ready",
            "coordinates": coordinates,
            "bounds": first_layer.get("bounds") or state.get("bounds"),
            "water_asset_layers": layers,
            "token_usage": _serialize_usage(usage_entries),
            "token_cost_summary": summary,
        },
    )


workflow = StateGraph(FloodAgentState)
workflow.add_node("entry_node", entry_node)
workflow.add_node("chat_node", chat_node)
workflow.add_node("asset_parse_node", asset_parse_node)
workflow.add_node("asset_recommend_node", asset_recommend_node)
workflow.add_node("asset_selection_node", asset_selection_node)
workflow.add_node("asset_render_node", asset_render_node)
workflow.set_entry_point("entry_node")
workflow.add_edge("chat_node", "asset_parse_node")
checkpointer = MemorySaver()
graph = workflow.compile(checkpointer=checkpointer)

from __future__ import annotations

import json
import os
import re
import requests
from dataclasses import replace
from datetime import datetime
from typing import Any, Dict, Literal, Optional

from dotenv import load_dotenv
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph
from langgraph.types import Command, interrupt

from gee_code_generator import generate_flood_gee_code
from prompts import FLOOD_REPORT_TEMPLATE, REPORT_GENERATION_PROMPT, SYSTEM_PROMPT
from state import FloodAgentState
from water_asset_service import ParsedAssetQuery, TokenUsageEntry, WaterAssetService


load_dotenv()

http_proxy = os.getenv("HTTP_PROXY")
https_proxy = os.getenv("HTTPS_PROXY")
if http_proxy:
    os.environ["HTTP_PROXY"] = http_proxy
if https_proxy:
    os.environ["HTTPS_PROXY"] = https_proxy


water_asset_service = WaterAssetService()


_pending_search_sources: list[dict[str, str]] = []
_pending_search_contents: list[dict[str, str]] = []


NodeType = Literal[
    "chat_node",
    "extraction_node",
    "confirmation_node",
    "processing_node",
    "__end__",
]


def _get_model() -> ChatOpenAI:
    return ChatOpenAI(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        api_key=os.getenv("OPENAI_API_KEY", ""),
        base_url=os.getenv("OPENAI_API_BASE"),
        temperature=0.3,
    )


def _classify_location_type(location_name: str) -> dict[str, str]:
    try:
        model = _get_model()
        prompt = f"""Please determine the type of the following place name:

Place name: {location_name}

Criteria:
1. "administrative" - An independent administrative region, such as country, province/state, city, county, district, etc., with clearly defined administrative boundaries.
2. "composite" - A composite place name, geographic location, or natural region, including multiple administrative regions, geographic location concepts, natural regions, and trans-administrative geographic units.

Return strict JSON only:
{{"type": "administrative or composite", "reason": "brief explanation"}}
"""
        response = model.invoke([HumanMessage(content=prompt)])
        content = str(response.content)
        start = content.find("{")
        end = content.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return {"type": "administrative", "reason": "No valid JSON returned"}
        data = json.loads(content[start : end + 1])
        location_type = data.get("type", "administrative")
        reason = data.get("reason", "")
        if location_type not in {"administrative", "composite"}:
            location_type = "administrative"
        return {"type": location_type, "reason": reason}
    except Exception as exc:
        return {"type": "administrative", "reason": f"Classification fallback: {exc.__class__.__name__}"}


def _generate_geojson_with_llm(location_name: str) -> Optional[Dict[str, Any]]:
    try:
        model = _get_model()
        prompt = f"""Please generate an approximate GeoJSON boundary for the following geographic region.

Geographic region name: {location_name}

Requirements:
1. Generate a simplified Polygon boundary with 4-8 vertices to represent the approximate extent.
2. Coordinates must use [longitude, latitude] in WGS84.
3. The polygon must be closed.
4. Also provide the center point coordinates and bounding box.

Return strict JSON only:
{{
  "center": [longitude, latitude],
  "bounds": {{"west": 0, "south": 0, "east": 0, "north": 0}},
  "geometry": {{
    "type": "Polygon",
    "coordinates": [[[lon1, lat1], [lon2, lat2], [lon3, lat3], [lon1, lat1]]]
  }}
}}
"""
        response = model.invoke([HumanMessage(content=prompt)])
        content = str(response.content)
        start = content.find("{")
        end = content.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        data = json.loads(content[start : end + 1])
        if not all(key in data for key in ["center", "bounds", "geometry"]):
            return None
        return {
            "location": location_name,
            "coordinates": data["center"],
            "bounds": data["bounds"],
            "geojson": {
                "type": "Feature",
                "properties": {
                    "name": location_name,
                    "type": "composite_region",
                    "source": "llm_generated",
                },
                "geometry": data["geometry"],
            },
            "type": "composite_region",
            "source": "llm_generated",
        }
    except Exception:
        return None


def _get_location_from_nominatim(location_name: str) -> Optional[Dict[str, Any]]:
    try:
        response = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": location_name,
                "format": "geojson",
                "polygon_geojson": 1,
                "limit": 1,
                "accept-language": "en",
            },
            headers={"User-Agent": "FloodAgent/1.0 (flood monitoring application)"},
            timeout=20,
        )
        response.raise_for_status()
        data = response.json()
        features = data.get("features") or []
        if not features:
            return None

        feature = features[0]
        geometry = feature.get("geometry")
        properties = feature.get("properties", {})
        bounds = None
        center = None

        if geometry and geometry.get("coordinates"):
            if geometry["type"] == "Point":
                lon, lat = geometry["coordinates"]
                buffer = 0.5
                bounds = {
                    "west": lon - buffer,
                    "south": lat - buffer,
                    "east": lon + buffer,
                    "north": lat + buffer,
                }
                center = [lon, lat]
                geojson_feature = _rectangle_geojson(bounds, properties.get("display_name", location_name))
                geojson_feature["properties"]["source"] = "nominatim_point_buffer"
            else:
                def extract_coords(coords: Any, result_coords: Optional[list[list[float]]] = None) -> list[list[float]]:
                    if result_coords is None:
                        result_coords = []
                    if isinstance(coords[0], (int, float)):
                        result_coords.append(coords)
                    else:
                        for coord in coords:
                            extract_coords(coord, result_coords)
                    return result_coords

                all_coords = extract_coords(geometry["coordinates"])
                if all_coords:
                    lons = [coord[0] for coord in all_coords]
                    lats = [coord[1] for coord in all_coords]
                    bounds = {
                        "west": min(lons),
                        "south": min(lats),
                        "east": max(lons),
                        "north": max(lats),
                    }
                    center = [
                        (bounds["west"] + bounds["east"]) / 2,
                        (bounds["south"] + bounds["north"]) / 2,
                    ]
                geojson_feature = {
                    "type": "Feature",
                    "properties": {
                        "name": properties.get("display_name", location_name),
                        "type": properties.get("type"),
                        "class": properties.get("class"),
                        "source": "nominatim_polygon",
                    },
                    "geometry": geometry,
                }
        else:
            return None

        return {
            "location": properties.get("display_name", location_name),
            "coordinates": center if center else [0.0, 0.0],
            "bounds": bounds if bounds else {"south": -90.0, "north": 90.0, "west": -180.0, "east": 180.0},
            "geojson": geojson_feature,
            "type": properties.get("type", "administrative"),
            "source": "nominatim",
        }
    except Exception:
        return None


def _get_location_coordinates_internal(location_name: str) -> Dict[str, Any]:
    classification = _classify_location_type(location_name)
    is_composite = classification["type"] == "composite"

    if is_composite:
        llm_result = _generate_geojson_with_llm(location_name)
        if llm_result:
            return llm_result

    nominatim_result = _get_location_from_nominatim(location_name)
    if nominatim_result:
        return nominatim_result

    if not is_composite:
        llm_result = _generate_geojson_with_llm(location_name)
        if llm_result:
            return llm_result

    return {
        "location": location_name,
        "coordinates": [0.0, 0.0],
        "bounds": {"south": -90.0, "north": 90.0, "west": -180.0, "east": 180.0},
        "geojson": None,
        "error": f"Unable to retrieve geographic information for '{location_name}'",
        "source": "fallback_default",
    }


def _thread_id_from_config(config: RunnableConfig) -> Optional[str]:
    configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
    return configurable.get("thread_id") or configurable.get("conversation_id")


def _serialize_usage(entries: list[TokenUsageEntry]) -> list[dict[str, Any]]:
    return [entry.__dict__.copy() for entry in entries]


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
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text")
                    if text:
                        parts.append(str(text))
            return "\n".join(parts)
        return str(content)
    return ""


def _reset_payload() -> dict[str, Any]:
    return {
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
        "geo_data": None,
        "search_sources": [],
        "gee_code": None,
        "agent_intent": None,
        "query_themes": [],
        "recommended_assets": [],
        "selected_asset_ids": [],
        "water_asset_layers": [],
        "token_usage": [],
        "token_cost_summary": {},
        "aoi_source": None,
        "pending_extraction_payload": None,
    }


def _extract_flood_info_from_content(content: str) -> dict[str, Any]:
    try:
        cleaned = content or ""
        if "```json" in cleaned:
            json_str = cleaned.split("```json", 1)[1].split("```", 1)[0]
        elif "```" in cleaned:
            json_str = cleaned.split("```", 1)[1].split("```", 1)[0]
        else:
            start = cleaned.find("{")
            end = cleaned.rfind("}")
            if start == -1 or end == -1 or end <= start:
                return {}
            json_str = cleaned[start : end + 1]
        data = json.loads(json_str.strip())
    except (json.JSONDecodeError, IndexError, TypeError):
        return {}

    updates: dict[str, Any] = {}
    for field in [
        "event",
        "event_description",
        "location",
        "pre_date",
        "peek_date",
        "after_date",
    ]:
        if data.get(field):
            updates[field] = data[field]
    if data.get("coordinates") and isinstance(data["coordinates"], list) and len(data["coordinates"]) == 2:
        updates["coordinates"] = data["coordinates"]
    if data.get("bounds") and isinstance(data["bounds"], dict):
        required_keys = ["west", "east", "south", "north"]
        if all(key in data["bounds"] for key in required_keys):
            updates["bounds"] = data["bounds"]
    if data.get("geojson") and isinstance(data["geojson"], dict):
        updates["geojson"] = data["geojson"]
    return updates


def _format_sources_text(sources: list[dict[str, str]]) -> str:
    if not sources:
        return "*This report is compiled from publicly available online sources.*"

    lines = []
    for index, source in enumerate(sources, start=1):
        title = source.get("title", "Unknown source")
        url = source.get("url", "#")
        lines.append(f"{index}. [{title}]({url})")
    return "\n".join(lines)


_MONTH_NAME_TO_NUMBER = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "sept": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


def _extract_summary_line(search_text: str) -> str:
    if not search_text:
        return ""
    for line in search_text.splitlines():
        if line.startswith("Summary:"):
            return line.replace("Summary:", "", 1).strip()
    return search_text.splitlines()[0].strip() if search_text.splitlines() else ""


def _extract_dates_from_text(text: str) -> list[str]:
    if not text:
        return []

    normalized_dates: list[str] = []

    iso_pattern = re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})\b")
    for year, month, day in iso_pattern.findall(text):
        normalized_dates.append(f"{year}-{month}-{day}")

    month_day_year_pattern = re.compile(
        r"\b("
        r"January|February|March|April|May|June|July|August|September|October|November|December|"
        r"Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
        r")\s+(\d{1,2}),\s*(20\d{2})\b",
        re.IGNORECASE,
    )
    for month_name, day, year in month_day_year_pattern.findall(text):
        month = _MONTH_NAME_TO_NUMBER[month_name.lower()]
        normalized_dates.append(f"{int(year):04d}-{month:02d}-{int(day):02d}")

    day_month_year_pattern = re.compile(
        r"\b(\d{1,2})\s+("
        r"January|February|March|April|May|June|July|August|September|October|November|December|"
        r"Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
        r")\s+(20\d{2})\b",
        re.IGNORECASE,
    )
    for day, month_name, year in day_month_year_pattern.findall(text):
        month = _MONTH_NAME_TO_NUMBER[month_name.lower()]
        normalized_dates.append(f"{int(year):04d}-{month:02d}-{int(day):02d}")

    unique_sorted = sorted(set(normalized_dates))
    return unique_sorted


def _extract_month_range(text: str, fallback_year: Optional[int]) -> tuple[Optional[str], Optional[str]]:
    if not text or fallback_year is None:
        return None, None

    month_range_pattern = re.compile(
        r"from\s+("
        r"January|February|March|April|May|June|July|August|September|October|November|December|"
        r"Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
        r")\s+to\s+("
        r"January|February|March|April|May|June|July|August|September|October|November|December|"
        r"Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
        r")",
        re.IGNORECASE,
    )
    match = month_range_pattern.search(text)
    if not match:
        return None, None

    start_month = _MONTH_NAME_TO_NUMBER[match.group(1).lower()]
    end_month = _MONTH_NAME_TO_NUMBER[match.group(2).lower()]
    start_date = f"{fallback_year:04d}-{start_month:02d}-01"
    end_date = f"{fallback_year:04d}-{end_month:02d}-28"
    return start_date, end_date


def _heuristic_extract_flood_payload(question: str, search_text: str) -> dict[str, Any]:
    summary = _extract_summary_line(search_text)
    year_match = re.search(r"\b(20\d{2})\b", question) or re.search(r"\b(20\d{2})\b", search_text)
    year = int(year_match.group(1)) if year_match else None

    event_match = re.search(
        r"(?:analyze|assess|study|review|look at|summarize)\s+(?:the\s+)?(?P<event>.+?)\s+flood event(?:\s+in\s+(?P<country>.+))?$",
        question.strip(),
        re.IGNORECASE,
    )

    event_core = None
    location = None
    if event_match:
        event_core = event_match.group("event").strip(" .")
        country = event_match.group("country")
        event_core = re.sub(r"^\d{4}\s+", "", event_core).strip()
        if country:
            location = f"{event_core}, {country.strip(' .')}"
        else:
            location = event_core

    if not event_core:
        chiang_mai_match = re.search(r"\b(Chiang Mai|Chiang Rai|Bangkok|Jakarta|Zhengzhou)\b", question, re.IGNORECASE)
        if chiang_mai_match:
            event_core = chiang_mai_match.group(1)
            location = event_core

    if year and event_core:
        event = f"{year} {event_core} Flood"
    elif event_core:
        event = f"{event_core} Flood"
    else:
        event = "Flood Event"

    if not location:
        in_match = re.search(r"\bin\s+([A-Za-z][A-Za-z,\s-]+)$", question.strip())
        if in_match:
            location = in_match.group(1).strip(" .")

    if not location:
        location = "Unknown location"

    extracted_dates = _extract_dates_from_text(summary)
    pre_date = None
    peak_date = None
    after_date = None
    if extracted_dates:
        peak_date = extracted_dates[-1]
        pre_date = extracted_dates[0]
        after_date = peak_date

    month_range_start, month_range_end = _extract_month_range(summary, year)
    pre_date = month_range_start or pre_date
    after_date = month_range_end or after_date
    peak_date = peak_date or after_date or pre_date

    if year and not pre_date:
        pre_date = f"{year:04d}-08-01"
    if year and not peak_date:
        peak_date = f"{year:04d}-10-07"
    if year and not after_date:
        after_date = f"{year:04d}-10-28"

    event_description = summary or f"Flood event query for {location}."

    return {
        "event": event,
        "event_description": event_description,
        "location": location,
        "pre_date": pre_date or "",
        "peek_date": peak_date or "",
        "after_date": after_date or "",
    }


def _build_fallback_extraction_response(question: str) -> str:
    search_text = search_flood_event(question)
    payload = _heuristic_extract_flood_payload(question, search_text)
    summary = payload["event_description"]
    return (
        f"I could not use the tool-calling LLM path, so I prepared a fallback extraction from search results.\n\n"
        f"Summary: {summary}\n\n"
        "```json\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n"
        "```"
    )


def _rectangle_geojson(bounds: dict[str, float], label: str) -> dict[str, Any]:
    west = bounds["west"]
    south = bounds["south"]
    east = bounds["east"]
    north = bounds["north"]
    return {
        "type": "Feature",
        "properties": {
            "label": label,
            "source": "geocode_bounds",
        },
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
            ]],
        },
    }


def _merge_usage(
    existing_entries: list[dict[str, Any]],
    *new_entries: list[TokenUsageEntry],
) -> list[TokenUsageEntry]:
    merged = [
        TokenUsageEntry(**entry)
        for entry in existing_entries
        if isinstance(entry, dict)
    ]
    for entry_group in new_entries:
        merged.extend(entry_group)
    return merged


def search_flood_event(query: str) -> str:
    """
    Search web sources for a flood event and cache the source list for downstream report generation.
    """
    global _pending_search_sources, _pending_search_contents
    try:
        from tavily import TavilyClient

        tavily_client = TavilyClient(api_key=os.getenv("TAVILY_API_KEY"))

        all_sources: list[dict[str, str]] = []
        seen_urls: set[str] = set()
        output_chunks: list[str] = []

        search_specs = [
            (f"{query} flood disaster timeline date", "advanced", 8, True),
            (f"{query} impact damage casualties affected", "advanced", 5, False),
            (f"{query} rescue emergency response evacuation", "basic", 5, False),
        ]

        for search_query, depth, max_results, include_answer in search_specs:
            try:
                response = tavily_client.search(
                    query=search_query,
                    search_depth=depth,
                    max_results=max_results,
                    include_answer=include_answer,
                )
            except Exception:
                continue

            if include_answer and response.get("answer"):
                output_chunks.append(f"Summary: {response['answer']}")

            for result in response.get("results", []):
                url = result.get("url", "")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                title = result.get("title", "")
                content = result.get("content", "")
                output_chunks.append(
                    f"Title: {title}\nContent: {content}\nSource: {url}\n"
                )
                if title and url:
                    all_sources.append({"title": title, "url": url, "content": content})

        _pending_search_sources = [{"title": item["title"], "url": item["url"]} for item in all_sources]
        _pending_search_contents = all_sources

        return "\n---\n".join(output_chunks) if output_chunks else "No relevant flood event information found."
    except Exception as exc:
        _pending_search_sources = []
        _pending_search_contents = []
        return f"Search error: {exc}"


async def entry_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    current_stage = state.get("stage")
    if current_stage in {"completed", "cancelled"}:
        return Command(goto="chat_node", update=_reset_payload())
    return Command(goto="chat_node", update={"stage": current_stage or "initial"})


async def chat_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    latest_question = _latest_user_text(state)
    current_stage = state.get("stage", "initial")

    # CopilotKit / AG-UI currently crashes on ToolNode stream events when the tool
    # output is serialized as a plain string. For the first-turn flood workflow, route
    # directly through deterministic search + heuristic extraction instead of streaming
    # tool calls. This keeps the original agent flow alive: search -> extract -> confirm -> process.
    if current_stage in {"initial", None} and latest_question:
        fallback_content = _build_fallback_extraction_response(latest_question)
        return Command(
            goto="extraction_node",
            update={
                "stage": "initial",
                "user_confirmed": False,
                "pending_extraction_payload": fallback_content,
            },
        )

    model = _get_model()

    system_message = SystemMessage(
        content=(
            f"{SYSTEM_PROMPT}\n\n"
            f"[Current Stage]: {state.get('stage', 'initial')}\n"
            "If you can extract a concrete event from the conversation, append the JSON block exactly as instructed."
        )
    )

    try:
        response = await model.ainvoke([system_message, *state["messages"]], config)
    except Exception as exc:
        error_text = str(exc)
        if "401" in error_text or "Invalid token" in error_text or "AuthenticationError" in exc.__class__.__name__:
            if latest_question:
                fallback_content = _build_fallback_extraction_response(latest_question)
                return Command(
                    goto="extraction_node",
                    update={
                        "stage": "initial",
                        "user_confirmed": False,
                        "pending_extraction_payload": fallback_content,
                    },
                )
            return Command(
                goto="__end__",
                update={
                    "messages": AIMessage(
                        content=(
                            "The backend LLM authentication failed, so the flood-agent search flow could not start. "
                            "Please check OPENAI_API_KEY and OPENAI_API_BASE, then try again."
                        )
                    ),
                    "stage": "initial",
                    "user_confirmed": False,
                },
            )
        return Command(
            goto="__end__",
            update={
                "messages": AIMessage(
                    content=f"The flood-agent workflow stopped before search. Reason: {error_text}"
                ),
                "stage": "initial",
                "user_confirmed": False,
            },
        )
    return Command(goto="extraction_node", update={"messages": response})


async def extraction_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    messages = state.get("messages", [])
    pending_payload = state.get("pending_extraction_payload")
    if not messages and not pending_payload:
        return Command(goto="__end__")

    if pending_payload:
        content = pending_payload
    else:
        last_message = messages[-1]
        content = getattr(last_message, "content", "")
        if not isinstance(content, str):
            content = str(content)

    extracted = _extract_flood_info_from_content(content)

    merged_event = extracted.get("event") or state.get("event")
    merged_description = extracted.get("event_description") or state.get("event_description")
    merged_location = extracted.get("location") or state.get("location")
    merged_pre_date = extracted.get("pre_date") or state.get("pre_date")
    merged_peak_date = extracted.get("peek_date") or state.get("peek_date")
    merged_after_date = extracted.get("after_date") or state.get("after_date")
    merged_coordinates = extracted.get("coordinates") or state.get("coordinates")
    merged_bounds = extracted.get("bounds") or state.get("bounds")
    merged_geojson = extracted.get("geojson") or state.get("geojson")

    has_complete_info = all(
        [
            merged_event,
            merged_location,
            merged_pre_date,
            merged_peak_date,
            merged_after_date,
        ]
    )

    if not has_complete_info or state.get("user_confirmed"):
        return Command(
            goto="__end__",
            update={
                "event": merged_event,
                "event_description": merged_description,
                "location": merged_location,
                "pre_date": merged_pre_date,
                "peek_date": merged_peak_date,
                "after_date": merged_after_date,
                "coordinates": merged_coordinates,
                "bounds": merged_bounds,
                "geojson": merged_geojson,
            },
        )

    latest_question = _latest_user_text(state)
    query_seed = latest_question or "\n".join(
        part for part in [merged_event, merged_description, merged_location] if part
    )
    parsed_query, parse_usage = await water_asset_service.parse_query(query_seed)
    parsed_query = replace(
        parsed_query,
        location=merged_location or parsed_query.location,
        start_date=merged_pre_date or parsed_query.start_date,
        end_date=merged_peak_date or parsed_query.end_date,
    )

    coordinates = merged_coordinates
    bounds = merged_bounds
    geojson = merged_geojson
    aoi_source = state.get("aoi_source")
    geo_data = state.get("geo_data")

    if parsed_query.location or merged_location:
        location_data = _get_location_coordinates_internal(parsed_query.location or merged_location)
        if location_data:
            geo_data = location_data
            coordinates = coordinates or location_data.get("coordinates")
            bounds = bounds or location_data.get("bounds")
            geojson = geojson or location_data.get("geojson")
            aoi_source = aoi_source or location_data.get("source")

    if parsed_query.coordinates:
        coordinates = parsed_query.coordinates
        aoi_source = "query_coordinates"
    if parsed_query.geojson:
        geojson = parsed_query.geojson
        aoi_source = "query_geojson"
    if parsed_query.bounds:
        bounds = parsed_query.bounds
        aoi_source = aoi_source or "query_bounds"
        if not geojson:
            geojson = _rectangle_geojson(parsed_query.bounds, merged_location or "Analysis boundary")

    recommended_assets, recommend_usage = water_asset_service.recommend_assets(parsed_query)
    usage_entries = _merge_usage(state.get("token_usage", []), parse_usage, recommend_usage)
    serialized_assets = water_asset_service.serialize_assets(recommended_assets, parsed_query)
    default_selected_ids = serialized_assets[:1]

    return Command(
        goto="confirmation_node",
        update={
            "event": merged_event,
            "event_description": merged_description,
            "location": merged_location,
            "pre_date": merged_pre_date,
            "peek_date": merged_peak_date,
            "after_date": merged_after_date,
            "coordinates": coordinates,
            "bounds": bounds,
            "geojson": geojson,
            "geo_data": geo_data,
            "aoi_source": aoi_source,
            "agent_intent": parsed_query.agent_intent,
            "query_themes": parsed_query.themes,
            "recommended_assets": serialized_assets,
            "selected_asset_ids": [item["asset_id"] for item in default_selected_ids],
            "token_usage": _serialize_usage(usage_entries),
            "token_cost_summary": water_asset_service.summarize_usage(usage_entries),
            "stage": "pending_confirmation",
            "pending_extraction_payload": None,
        },
    )


async def confirmation_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    recommended_assets = state.get("recommended_assets") or []
    default_selected_ids = state.get("selected_asset_ids") or (
        [recommended_assets[0]["asset_id"]] if recommended_assets else []
    )

    confirmed_data_raw = interrupt(
        {
            "type": "confirm_flood_event",
            "message": "Confirm the flood event, the analysis boundary, and the layers you want to load.",
            "data": {
                "event": state.get("event"),
                "event_description": state.get("event_description"),
                "location": state.get("location"),
                "pre_date": state.get("pre_date"),
                "peek_date": state.get("peek_date"),
                "after_date": state.get("after_date"),
                "coordinates": state.get("coordinates"),
                "bounds": state.get("bounds"),
                "geojson": state.get("geojson"),
                "aoi_source": state.get("aoi_source"),
                "agent_intent": state.get("agent_intent"),
                "recommended_assets": recommended_assets,
                "preselected_asset_ids": default_selected_ids,
            },
        }
    )

    if isinstance(confirmed_data_raw, str):
        try:
            confirmed_data = json.loads(confirmed_data_raw)
        except json.JSONDecodeError:
            confirmed_data = {}
    elif isinstance(confirmed_data_raw, dict):
        confirmed_data = confirmed_data_raw
    else:
        confirmed_data = {}

    if not confirmed_data or confirmed_data.get("cancelled"):
        return Command(
            goto="__end__",
            update={
                "messages": AIMessage(
                    content="Cancelled. If you want to continue, ask about a flood event again."
                ),
                "stage": "cancelled",
                "user_confirmed": False,
            },
        )

    return Command(
        goto="processing_node",
        update={
            "event": confirmed_data.get("event", state.get("event")),
            "event_description": confirmed_data.get("event_description", state.get("event_description")),
            "location": confirmed_data.get("location", state.get("location")),
            "pre_date": confirmed_data.get("pre_date", state.get("pre_date")),
            "peek_date": confirmed_data.get("peek_date", state.get("peek_date")),
            "after_date": confirmed_data.get("after_date", state.get("after_date")),
            "coordinates": confirmed_data.get("coordinates", state.get("coordinates")),
            "bounds": confirmed_data.get("bounds", state.get("bounds")),
            "geojson": confirmed_data.get("geojson", state.get("geojson")),
            "aoi_source": confirmed_data.get("aoi_source", state.get("aoi_source")),
            "selected_asset_ids": confirmed_data.get("selected_asset_ids", state.get("selected_asset_ids") or []),
            "stage": "confirmed",
            "user_confirmed": True,
        },
    )


async def processing_node(state: FloodAgentState, config: RunnableConfig) -> Command[NodeType]:
    global _pending_search_contents

    event = state.get("event")
    event_description = state.get("event_description")
    location = state.get("location")
    pre_date = state.get("pre_date")
    peak_date = state.get("peek_date")
    after_date = state.get("after_date")
    coordinates = state.get("coordinates")
    bounds = state.get("bounds")
    geojson = state.get("geojson")
    geo_data = state.get("geo_data")

    if (not bounds or not coordinates or not geojson) and location:
        geo_data = geo_data or _get_location_coordinates_internal(location)
        if geo_data:
            if not coordinates:
                coordinates = geo_data.get("coordinates")
            if not bounds:
                bounds = geo_data.get("bounds")
            if not geojson:
                geojson = geo_data.get("geojson")

    search_contents_text = ""
    if _pending_search_contents:
        for index, item in enumerate(_pending_search_contents, start=1):
            title = item.get("title", "")
            snippet = item.get("content", "")
            url = item.get("url", "")
            search_contents_text += f"### Source {index}: {title}\n{snippet}\nSource URL: {url}\n\n"
    else:
        search_contents_text = "No search materials available. Analyze only the confirmed event information."

    report_prompt = REPORT_GENERATION_PROMPT.format(
        event=event or "Unknown event",
        location=location or "Unknown location",
        pre_date=pre_date or "Unknown",
        peek_date=peak_date or "Unknown",
        after_date=after_date or "Unknown",
        search_contents=search_contents_text,
    )

    model = _get_model()
    try:
        report_response = model.invoke([HumanMessage(content=report_prompt)])
        detailed_report = str(report_response.content)
    except Exception:
        detailed_report = (
            "### 1. Event Overview\n"
            f"{event_description or 'Limited information is currently available for this event.'}\n\n"
            "### 2. Cause Analysis\nLimited information available.\n\n"
            "### 3. Impact and Loss Assessment\nLimited information available.\n\n"
            "### 4. Emergency Response and Rescue Operations\nLimited information available.\n\n"
            "### 5. Post-disaster Recovery and Lessons Learned\nLimited information available.\n\n"
            "### 6. Comprehensive Summary\nAdditional authoritative sources are required for a complete assessment."
        )

    sources_text = _format_sources_text(_pending_search_sources)
    flood_report = FLOOD_REPORT_TEMPLATE.format(
        event=event or "Unknown event",
        pre_date=pre_date or "Unknown",
        peek_date=peak_date or "Unknown",
        after_date=after_date or "Unknown",
        location=location or "Unknown location",
        detailed_report=detailed_report,
        sources=sources_text,
    )

    gee_code = ""
    try:
        gee_code = generate_flood_gee_code(
            event_name=event or "Flood Event",
            pre_date=pre_date or "",
            peek_date=peak_date or "",
            location=location or "",
            coordinates=coordinates,
            bounds=bounds,
            geojson=geojson,
        )
    except Exception:
        gee_code = ""

    usage_entries = _merge_usage(
        state.get("token_usage", []),
        [
            TokenUsageEntry(
                stage="asset_selection_explain",
                model=water_asset_service.model_name,
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                estimated_cost_usd=0.0,
                source="human_interrupt",
                note="User confirmed the event, AOI, and selected dataset layers.",
            )
        ],
    )

    selected_asset_ids = state.get("selected_asset_ids") or []
    rendered_layers: list[dict[str, Any]] = []
    layer_render_error: Optional[str] = None
    if selected_asset_ids:
        try:
            rendered_layers = water_asset_service.render_assets(
                selected_asset_ids,
                location_hint=location,
                start_date=pre_date,
                end_date=peak_date,
            )
        except Exception as exc:
            layer_render_error = str(exc)

    usage_summary = water_asset_service.summarize_usage(usage_entries)
    usage_log = water_asset_service.build_usage_log(
        thread_id=_thread_id_from_config(config),
        agent_intent=state.get("agent_intent") or "discover",
        usage_entries=usage_entries,
    )
    print(json.dumps(usage_log, ensure_ascii=False))

    selected_titles = [layer["title"] for layer in rendered_layers]
    if layer_render_error:
        assistant_message = AIMessage(
            content=(
                f"The flood report is ready, but the selected layers could not be rendered. "
                f"Reason: {layer_render_error}\n\n{flood_report}"
            )
        )
    elif selected_titles:
        assistant_message = AIMessage(
            content=(
                f"The flood report is ready. Added these layers to the map: {', '.join(selected_titles)}.\n\n"
                f"{flood_report}"
            )
        )
    else:
        assistant_message = AIMessage(
            content=f"The flood report is ready. No additional dataset layers were selected.\n\n{flood_report}"
        )

    return Command(
        goto="__end__",
        update={
            "messages": assistant_message,
            "event": event,
            "event_description": event_description,
            "flood_report": flood_report,
            "report_document": flood_report,
            "pre_date": pre_date,
            "peek_date": peak_date,
            "after_date": after_date,
            "location": location,
            "coordinates": coordinates,
            "bounds": bounds,
            "geojson": geojson,
            "geo_data": geo_data,
            "search_sources": _pending_search_sources.copy(),
            "gee_code": gee_code,
            "recommended_assets": state.get("recommended_assets") or [],
            "selected_asset_ids": selected_asset_ids,
            "water_asset_layers": rendered_layers,
            "token_usage": _serialize_usage(usage_entries),
            "token_cost_summary": usage_summary,
            "stage": "completed",
            "user_confirmed": True,
            "is_valid_flood_query": True,
        },
    )


workflow = StateGraph(FloodAgentState)
workflow.add_node("entry_node", entry_node)
workflow.add_node("chat_node", chat_node)
workflow.add_node("extraction_node", extraction_node)
workflow.add_node("confirmation_node", confirmation_node)
workflow.add_node("processing_node", processing_node)
workflow.set_entry_point("entry_node")

checkpointer = MemorySaver()
graph = workflow.compile(checkpointer=checkpointer)

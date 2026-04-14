from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import folium

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

# Streamlit's source watcher can trip over torch's dynamic modules in this env.
# Disable it here so the debug UI stays minimal and starts reliably.
os.environ.setdefault("STREAMLIT_SERVER_FILE_WATCHER_TYPE", "none")

import streamlit as st
from streamlit_folium import st_folium

from hydrafloods_langgraph_agent import EXAMPLES, run_agent_query


st.set_page_config(page_title="HYDRAFloods Debug UI", layout="wide")


def _bbox_center(bbox: Optional[List[float]]) -> tuple[float, float]:
    if not bbox or len(bbox) != 4:
        return 23.7, 90.4
    west, south, east, north = bbox
    return (south + north) / 2, (west + east) / 2


def _collect_layers(tool_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    artifacts = tool_result.get("artifacts", {})
    candidates: List[Dict[str, Any]] = []
    for key in ["primary_layer"]:
        layer = artifacts.get(key)
        if isinstance(layer, dict) and layer.get("tile_url"):
            candidates.append(layer)
    for key in ["layers", "recommended_layers"]:
        for layer in artifacts.get(key, []):
            if isinstance(layer, dict) and layer.get("tile_url"):
                candidates.append(layer)

    deduped: List[Dict[str, Any]] = []
    seen = set()
    for layer in candidates:
        layer_key = layer.get("asset_id") or layer.get("name") or layer.get("title") or layer.get("tile_url")
        if layer_key in seen:
            continue
        seen.add(layer_key)
        deduped.append(layer)
    return deduped


def _build_map(parsed_request: Dict[str, Any], tool_result: Dict[str, Any]) -> folium.Map:
    bbox = parsed_request.get("bbox")
    center_lat, center_lon = _bbox_center(bbox)
    fmap = folium.Map(location=[center_lat, center_lon], zoom_start=11, tiles="OpenStreetMap")

    if bbox and len(bbox) == 4:
        west, south, east, north = bbox
        folium.Rectangle(
            bounds=[[south, west], [north, east]],
            color="#ef4444",
            weight=2,
            fill=False,
        ).add_to(fmap)

    for index, layer in enumerate(_collect_layers(tool_result)):
        layer_name = layer.get("title") or layer.get("name") or layer.get("asset_id") or f"layer-{index + 1}"
        folium.TileLayer(
            tiles=layer["tile_url"],
            attr="Google Earth Engine",
            name=layer_name,
            overlay=True,
            control=True,
            opacity=0.75,
            show=index == 0 or layer.get("visible", False),
        ).add_to(fmap)

    folium.LayerControl(collapsed=False).add_to(fmap)
    return fmap


def _render_summary(final_state: Dict[str, Any]) -> None:
    parsed = final_state.get("parsed_request", {})
    tool_result = final_state.get("tool_result", {})
    token_usage = final_state.get("token_usage", {})
    totals = token_usage.get("totals", {})
    metadata = tool_result.get("metadata", {})

    col1, col2, col3, col4, col5 = st.columns(5)
    col1.metric("Selected Tool", final_state.get("selected_tool") or "-")
    col2.metric("Status", tool_result.get("status") or "-")
    col3.metric("Dataset", parsed.get("dataset") or "-")
    col4.metric("Recommended Assets", metadata.get("recommended_asset_count", 0))
    col5.metric("Total Tokens", totals.get("total_tokens", 0))


def _render_recommendations(tool_result: Dict[str, Any]) -> None:
    recommendations = tool_result.get("recommendations", [])
    if not recommendations:
        st.info("No recommended asset products returned for this run.")
        return

    for index, item in enumerate(recommendations, start=1):
        title = item.get("title") or item.get("asset_id") or f"recommendation-{index}"
        st.markdown(f"**{index}. {title}**")
        st.write(f"`{item.get('asset_id', '-')}`")
        meta_cols = st.columns(3)
        meta_cols[0].metric("Score", item.get("score", "-"))
        meta_cols[1].metric("Group", item.get("product_group", "-"))
        meta_cols[2].metric("Default", item.get("default_selected", False))
        st.caption(item.get("reason", ""))
        st.divider()


def _render_legend(legend_spec: Dict[str, Any]) -> None:
    legend_type = legend_spec.get("type")
    label = legend_spec.get("label", "Legend")
    st.markdown(f"**{label}**")

    if legend_type == "categorical":
        for item in legend_spec.get("items", []):
            color = item.get("color", "#cccccc")
            value = item.get("value", "-")
            text = item.get("label", "-")
            st.markdown(
                f"<div style='display:flex;align-items:center;gap:8px;margin-bottom:4px;'>"
                f"<span style='display:inline-block;width:14px;height:14px;background:{color};border:1px solid #999;'></span>"
                f"<span>{value}: {text}</span>"
                f"</div>",
                unsafe_allow_html=True,
            )
        return

    if legend_type == "continuous":
        palette = ", ".join(legend_spec.get("palette", []))
        st.caption(f"Range: {legend_spec.get('min', '-')} to {legend_spec.get('max', '-')}")
        st.code(palette or "No palette")
        return

    if legend_type == "vector":
        style = legend_spec.get("style", {})
        st.code(str(style))
        return

    st.json(legend_spec)


def _render_layers(tool_result: Dict[str, Any]) -> None:
    layers = _collect_layers(tool_result)
    if not layers:
        st.info("No tile layers available in the current result.")
        return

    for index, layer in enumerate(layers, start=1):
        name = layer.get("title") or layer.get("name") or layer.get("asset_id") or f"layer-{index}"
        with st.expander(f"{index}. {name}", expanded=index == 1):
            if layer.get("asset_id"):
                st.write(f"Asset: `{layer['asset_id']}`")
            if layer.get("product_group"):
                st.write(f"Group: `{layer['product_group']}`")
            if layer.get("tile_url"):
                st.write(f"Tile URL: {layer['tile_url']}")
            if layer.get("thumbnail_url"):
                st.write(f"Thumbnail URL: {layer['thumbnail_url']}")
            legend_spec = layer.get("legend_spec")
            if legend_spec:
                _render_legend(legend_spec)
            recommendation = layer.get("recommendation")
            if recommendation:
                st.caption(recommendation.get("reason", ""))


def _render_map_legends(tool_result: Dict[str, Any]) -> None:
    layers = _collect_layers(tool_result)
    layers_with_legend = [layer for layer in layers if layer.get("legend_spec")]
    if not layers_with_legend:
        st.info("No legend metadata available for the current map layers.")
        return

    for index, layer in enumerate(layers_with_legend, start=1):
        name = layer.get("title") or layer.get("name") or layer.get("asset_id") or f"layer-{index}"
        st.markdown(f"### {name}")
        if layer.get("asset_id"):
            st.caption(layer["asset_id"])
        _render_legend(layer["legend_spec"])
        recommendation = layer.get("recommendation")
        if recommendation:
            st.caption(recommendation.get("reason", ""))
        if index < len(layers_with_legend):
            st.divider()


def _render_response_panel(final_state: Dict[str, Any]) -> None:
    st.markdown(final_state.get("response", "_No response generated._"))


def _render_result(final_state: Dict[str, Any]) -> None:
    parsed = final_state.get("parsed_request", {})
    tool_result = final_state.get("tool_result", {})

    _render_summary(final_state)

    tab_result, tab_map, tab_reco, tab_layers, tab_raw = st.tabs(
        ["Result", "Map", "Recommendations", "Layers", "Raw State"]
    )

    with tab_result:
        _render_response_panel(final_state)

    with tab_map:
        if _collect_layers(tool_result):
            map_col, legend_col = st.columns([3, 1.35], gap="large")
            with map_col:
                st_folium(_build_map(parsed, tool_result), width=None, height=560, returned_objects=[])
            with legend_col:
                st.subheader("Legend")
                _render_map_legends(tool_result)
        else:
            st.info("This run did not return any map layers.")

    with tab_reco:
        _render_recommendations(tool_result)

    with tab_layers:
        _render_layers(tool_result)

    with tab_raw:
        st.json(final_state)


def _use_example(query: str) -> None:
    st.session_state["query_input"] = query


st.title("HYDRAFloods LangGraph Debug UI")
st.caption("Single-page debug console for tool execution, asset recommendation, and map layer inspection.")

with st.sidebar:
    st.subheader("Options")
    token_stats = st.checkbox("Enable token stats", value=True)
    debug_trace = st.checkbox("Enable debug trace", value=False)
    st.caption("Use the current LangGraph + HYDRAFloods stack directly.")

    st.subheader("Quick Tests")
    for index, example in enumerate(EXAMPLES, start=1):
        if st.button(f"Use Example {index}", key=f"example-{index}", use_container_width=True):
            _use_example(example)


query = st.text_area(
    "Query",
    value=st.session_state.get("query_input", EXAMPLES[1]),
    height=150,
    key="query_input",
)

run = st.button("Run Query", type="primary", use_container_width=True)

if run:
    with st.spinner("Running agent..."):
        try:
            final_state = run_agent_query(
                query.strip(),
                token_stats=token_stats,
                debug_trace=debug_trace,
            )
        except Exception as exc:
            st.error(f"Agent execution failed: {type(exc).__name__}: {exc}")
        else:
            _render_result(final_state)
else:
    st.info("Choose an example or enter a custom query, then click `Run Query`.")

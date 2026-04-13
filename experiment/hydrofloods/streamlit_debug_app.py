from __future__ import annotations

from pathlib import Path
import sys
from typing import Any, Dict, List, Optional
import os

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

    artifacts = tool_result.get("artifacts", {})
    layers: List[Dict[str, Any]] = []
    primary_layer = artifacts.get("primary_layer")
    if primary_layer and primary_layer.get("tile_url"):
        layers.append(primary_layer)
    for layer in artifacts.get("recommended_layers", []):
        if layer.get("tile_url"):
            layers.append(layer)

    seen = set()
    for index, layer in enumerate(layers):
        layer_key = layer.get("asset_id") or layer.get("name") or f"layer-{index}"
        if layer_key in seen:
            continue
        seen.add(layer_key)
        folium.TileLayer(
            tiles=layer["tile_url"],
            attr="Google Earth Engine",
            name=layer.get("title") or layer.get("name", layer_key),
            overlay=True,
            control=True,
            opacity=0.75,
            show=index == 0 or layer.get("visible", False),
        ).add_to(fmap)

    folium.LayerControl().add_to(fmap)
    return fmap


def _render_summary(final_state: Dict[str, Any]) -> None:
    parsed = final_state.get("parsed_request", {})
    tool_result = final_state.get("tool_result", {})
    token_usage = final_state.get("token_usage", {})
    totals = token_usage.get("totals", {})

    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Selected Tool", final_state.get("selected_tool") or "-")
    col2.metric("Status", tool_result.get("status") or "-")
    col3.metric("Dataset", parsed.get("dataset") or "-")
    col4.metric("Total Tokens", totals.get("total_tokens", 0))


def _render_result(final_state: Dict[str, Any]) -> None:
    parsed = final_state.get("parsed_request", {})
    tool_result = final_state.get("tool_result", {})

    _render_summary(final_state)
    st.markdown(final_state.get("response", "_No response generated._"))

    if (
        tool_result.get("artifacts", {}).get("primary_layer", {}).get("tile_url")
        or tool_result.get("artifacts", {}).get("recommended_layers")
    ):
        st.subheader("Map")
        st_folium(_build_map(parsed, tool_result), width=None, height=520, returned_objects=[])

    with st.expander("Raw State"):
        st.json(final_state)


st.title("HYDRAFloods LangGraph Debug UI")
st.caption("Minimal Streamlit app for local debugging of the experiment agent.")

with st.sidebar:
    st.subheader("Options")
    token_stats = st.checkbox("Enable token stats", value=True)
    debug_trace = st.checkbox("Enable debug trace", value=False)
    st.caption("Use the current LangGraph + HYDRAFloods stack directly.")

query = st.text_area("Query", height=140, placeholder=EXAMPLES[1])

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

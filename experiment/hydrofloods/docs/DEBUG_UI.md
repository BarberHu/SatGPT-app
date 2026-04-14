# Streamlit Debug UI Notes

This document describes the current testing UI in `streamlit_debug_app.py`.

The page is intentionally small and local to the experiment. It is a debug shell, not a production frontend.

## Goal

Provide one page for testing the latest agent structure, including:

- direct natural-language queries
- execution mode inspection
- preflight inspection
- asset recommendation inspection
- map-layer loading
- legend rendering
- raw-state debugging

## Supported Result Shapes

The current UI is aligned with the latest agent output shape:

- `parsed_request`
- `execution_plan`
- `preflight`
- `tool_result`
- `token_usage`

It is designed to work across:

- `describe_only`
- `assets_only`
- `compute_only`
- `hybrid`

## Page Structure

### Top Summary

The summary row shows:

- mode
- selected tool
- status
- dataset
- asset layer count
- total tokens

### `Overview` Tab

The overview tab combines:

- rendered response markdown
- attached analysis result if assets are primary
- execution-plan summary
- preflight status, warnings, and blocking issues

### `Map` Tab

The map tab shows:

- AOI bounding box
- primary and secondary tile layers
- layer control
- right-side legend panel

Legend rendering supports:

- categorical legends
- continuous legends
- vector style metadata

### `Recommendations` Tab

Displays recommended assets with:

- asset id
- title
- score
- product group
- default-selection flag
- reason

### `Layers` Tab

Layers are grouped for easier hybrid debugging:

- Primary Output
- Recommended Asset Layers
- Additional Asset Layers

This makes it easier to inspect which layer came from recommendation and which came from fresh computation.

### `Raw State` Tab

Shows the full final state returned by the graph.

This is the most useful tab when debugging:

- routing errors
- execution-plan drift
- preflight failures
- missing metadata
- legend propagation issues

## Why This UI Exists

The debug UI exists to reduce notebook-only testing and make it easier to inspect:

- what the agent decided
- why it chose that path
- what layers came back
- how results are grouped

It should remain low-coupling and easy to delete or replace later.

## Current Constraint

The UI disables Streamlit's file watcher in this environment:

```python
os.environ.setdefault("STREAMLIT_SERVER_FILE_WATCHER_TYPE", "none")
```

That keeps startup more stable, but it also means code updates require a manual Streamlit restart.

## Run

```powershell
streamlit run experiment\hydrofloods\streamlit_debug_app.py
```

If a dedicated conda environment is used:

```powershell
conda run -n floodagent python -m streamlit run experiment\hydrofloods\streamlit_debug_app.py
```

# HYDRAFloods Tool Library

这份目录是当前 `experiment/hydrofloods` 中供 LangGraph 使用的本地工具库视图。

单一事实来源在 [tool_library.py](C:\Users\admin\.codex\worktrees\9b90\SatGPT-app\experiment\hydrofloods\tool_library.py)。

## describe_hydrafloods_tools

- Intent: `describe_tools`
- Summary: 列出当前实验暴露给 LangGraph 的本地任务级工具。
- When to use: 当用户想了解支持什么能力、有哪些工具、当前边界是什么时使用。
- When not to use: 当用户已经明确要执行水体、洪水或水深任务时不要使用。
- Required fields: None
- Optional fields: None
- Defaults: `{}`
- Returns: `registry`, `gee_project_id`, `engineering_boundaries`
- Example: 列出当前 HYDRAFloods 工具层暴露了哪些任务工具。

## get_water_extent_tile

- Intent: `water_mapping`
- Summary: 执行水体提取，并返回在线地图 `tile_url` 和缩略图。
- When to use: 当用户要看积水图、水体图、水体范围图、water layer 时使用。
- When not to use: 当用户明确要求洪水范围或水深估算时不要使用。
- Required fields: `dataset`, `start_date`, `end_date`, `bbox`
- Optional fields: `algorithm`
- Defaults: `algorithm=edge_otsu`
- Returns: `tile_url`, `thumbnail_url`, `metadata`, `repro_code`
- Example: 帮我给这个区域做一层可以直接挂在线地图上的积水图。

## get_flood_extent_tile

- Intent: `flood_extent`
- Summary: 执行洪水范围提取，并返回在线地图 `tile_url` 和缩略图。
- When to use: 当用户明确要求淹没范围、洪水范围、flood extent 图层时使用。
- When not to use: 当用户只是要一般水体图或明确要水深时不要使用。
- Required fields: `dataset`, `start_date`, `end_date`, `bbox`
- Optional fields: `algorithm`, `reference`
- Defaults: `algorithm=edge_otsu`, `reference=seasonal`
- Returns: `tile_url`, `thumbnail_url`, `metadata`, `repro_code`
- Example: 我想看同一块区域的淹没范围图层。

## estimate_flood_depth_tile

- Intent: `depth_estimation`
- Summary: 执行 FwDET 水深估算，并返回在线地图 `tile_url` 和缩略图。
- When to use: 当用户明确要求水深、深度分布、depth map、FwDET 时使用。
- When not to use: 当用户只要水体或洪水范围图时不要使用。
- Required fields: `dataset`, `start_date`, `end_date`, `bbox`
- Optional fields: `algorithm`, `reference`, `dem_asset`
- Defaults: `algorithm=edge_otsu`, `reference=seasonal`, `dem_asset=USGS/SRTMGL1_003`
- Returns: `tile_url`, `thumbnail_url`, `metadata`, `repro_code`
- Example: 请生成这片区域的洪水水深图。

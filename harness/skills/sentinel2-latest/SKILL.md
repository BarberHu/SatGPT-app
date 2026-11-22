---
name: sentinel2-latest
description: Find the latest usable Sentinel-2 optical observations for the task area and display a true-color layer when requested.
---

# Latest Sentinel-2 imagery

For the latest optical imagery, start with one gee_eval metadata query filtered by analysis_region and a short lookback ending at the request time. Check the latest actual system:time_start using aggregate_max. Expand the lookback only if needed. Use the verified recent imagery to create the true-color layer with gee_layer. A single scene may cover only part of the region. If compositing recent scenes, report the actual observation date range of the composite and describe its coverage. Omit optional pixel coverage statistics for requests to display imagery. If coverage is explicitly requested, compute it separately at a scale appropriate for the region and report that scale.
For a request to find and display the latest Sentinel-2 true color, use the following two scripts. Replace START_UTC and END_UTC with an initial lookback of about two weeks ending at the request timestamp. Start with gee_eval:
```python
scenes = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(analysis_region).filterDate('START_UTC', 'END_UTC')
result = ee.Dictionary({'count': scenes.size(), 'first_ms': scenes.aggregate_min('system:time_start'), 'last_ms': scenes.aggregate_max('system:time_start')})
```
Then use gee_layer for a recent RGB mosaic when multiple scenes are needed for the viewport. Use the verified interval and put the actual first and last observation dates in metadata.observed_at:
```python
scenes = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(analysis_region).filterDate('START_UTC', 'END_UTC')
result = scenes.sort('system:time_start').select(['B4', 'B3', 'B2']).mosaic().clip(analysis_region)
```
Give gee_layer the RGB bands B4/B3/B2 and a reflectance display range such as 0–3000 for this collection. Explain that the mosaic can contain clouds and gaps. Skip daily scene breakdowns, cloud-mask coverage calculations, and a separate gee_preview for this simple display request. gee_layer already provides a thumbnail.

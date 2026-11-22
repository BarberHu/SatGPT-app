---
name: rainfall-analysis
description: Check rainfall observations and summarize cumulative rainfall or compare periods in the exact study area.
---

# Rainfall observations and comparisons

For rainfall, start with the user-specified dataset or one verified suitable dataset. For a two-period comparison, use one gee_eval for availability and observed dates, followed by one gee_eval for the requested statistics. Follow the examples below and substitute the requested parameters. Omit the second period if only one was requested. In the metadata call use only the counts and dates of the two filtered periods. Skip collection-wide totals and date ranges. In the statistics call, return the requested totals and daily values. Skip extra pixel-count, coverage, and cross-check queries unless the user requests them or the required result is missing. Finish after both calls if they returned the requested evidence.
```python
first = ee.ImageCollection('DATASET_ID').filterBounds(analysis_region).filterDate('FIRST_START_UTC', 'FIRST_END_UTC').select('BAND').sort('system:time_start')
second = ee.ImageCollection('DATASET_ID').filterBounds(analysis_region).filterDate('SECOND_START_UTC', 'SECOND_END_UTC').select('BAND').sort('system:time_start')
result = ee.Dictionary({'first_count': first.size(), 'first_dates_ms': first.aggregate_array('system:time_start'), 'second_count': second.size(), 'second_dates_ms': second.aggregate_array('system:time_start')})
```
If a period has no observations or usable timestamps, report the gap instead of reducing an empty collection. Compute cumulative rainfall by summing the original masked daily band before reducing over the AOI. Preserve the source masks: do not fill masked values with zero, mask valid zeros, or add a requirement that every day be valid at each pixel. A valid zero stays zero; report a null mean as missing. If both means are available, subtract the returned numbers in the answer. For short requested daily series, use the optional toBands() lines below to reduce each day on the same grid, keeping its own mask; use the same date-sorted collections and confirm the band-to-date order. Use only the requested statistics and remove the daily lines and result fields when daily values were not requested.
```python
rain = ee.ImageCollection('DATASET_ID').filterBounds(analysis_region).select('BAND')
first = rain.filterDate('FIRST_START_UTC', 'FIRST_END_UTC').sort('system:time_start')
second = rain.filterDate('SECOND_START_UTC', 'SECOND_END_UTC').sort('system:time_start')
reduce_options = dict(reducer=ee.Reducer.mean(), geometry=analysis_region, scale=SCALE, crs='CRS')
first_mean = first.sum().reduceRegion(**reduce_options).get('BAND')
second_mean = second.sum().reduceRegion(**reduce_options).get('BAND')
first_daily = first.toBands().reduceRegion(**reduce_options)
second_daily = second.toBands().reduceRegion(**reduce_options)
result = ee.Dictionary({'first_mean': first_mean, 'second_mean': second_mean, 'first_daily': first_daily, 'second_daily': second_daily})
```

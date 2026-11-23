"""Bounded spatial partitioning for Agent building queries."""

import asyncio
from collections import Counter
import json
import math
import time

from shapely import orient_polygons, union_all
from shapely.geometry import box, mapping, shape

from .osm_queries import LIMITS, _convert, _polygonal, bounding_box_area
from .osm_transport import RoadNetworkError


MAX_BUILDING_AREA_KM2 = 1_000
MAX_PARTITION_QUERIES = 32
MAX_MERGED_BUILDINGS = 25_000
MAX_MERGED_BYTES = 12_000_000
MAX_PARTITION_INPUT_BYTES = 32_000_000
MIN_PARTITION_EDGE_KM = .025
ONLINE_DEADLINE_SECONDS = 60
BUILDING_DEADLINE_SECONDS = 80


def check_deadline(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        raise RoadNetworkError(504, 'osm_timeout', 'The OSM building query reached its time budget. Select a smaller area.')


class BuildingPartitions:
    def __init__(self, area, deadline, *, first_query_over_limit=False):
        self.pending = []
        self.attempts = int(first_query_over_limit)
        self.deadline = deadline
        if first_query_over_limit:
            self.split(area)
        else:
            self.pending.append(area)

    def __iter__(self):
        while self.pending:
            check_deadline(self.deadline)
            area = self.pending.pop()
            if bounding_box_area(area.bounds) > LIMITS['buildings'][0]:
                self.split(area)
                continue
            if self.attempts >= MAX_PARTITION_QUERIES:
                raise RoadNetworkError(422, 'feature_limit',
                                       f'The query reached its {MAX_PARTITION_QUERIES} building partition requests. Select a smaller area.')
            self.attempts += 1
            yield area

    def split(self, area):
        west, south, east, north = area.bounds
        width = (east - west) * 111.195 * math.cos(math.radians((south + north) / 2))
        height = (north - south) * 111.195
        if max(width, height) < 2 * MIN_PARTITION_EDGE_KM:
            raise RoadNetworkError(422, 'feature_limit',
                                   'A building partition is still over the query limit at the minimum size. Select a smaller area.')
        if width >= height:
            mid = (west + east) / 2
            children = (box(west, south, mid, north), box(mid, south, east, north))
        else:
            mid = (south + north) / 2
            children = (box(west, south, east, mid), box(west, mid, east, north))
        for child in reversed(children):
            clipped = _polygonal(area.intersection(child))
            if not clipped.is_empty and clipped.area > 0:
                self.pending.append(clipped)


def check_input_budget(size):
    if size > MAX_PARTITION_INPUT_BYTES:
        raise RoadNetworkError(422, 'feature_limit',
                               'The building partitions exceed the combined input budget. Select a smaller area.')


async def query_online_buildings(service, region, bounds, area, deadline):
    if bounding_box_area(area.bounds) <= LIMITS['buildings'][0]:
        try:
            summary, content = await service.query('buildings', None, region, bounds)
            return {**summary, 'partition_count': 1}, content
        except RoadNetworkError as exc:
            if exc.code != 'feature_limit':
                raise
        partitions = BuildingPartitions(area, deadline, first_query_over_limit=True)
    else:
        partitions = BuildingPartitions(area, deadline)

    candidates, timestamps = {}, []
    partition_count = input_bytes = 0
    for tile in partitions:
        try:
            elements, timestamp = await service.get(('buildings', None, tile.bounds))
        except RoadNetworkError as exc:
            if exc.code != 'feature_limit':
                raise
            partitions.split(tile)
            continue
        for key, element in elements.items():
            if key in candidates:
                if candidates[key] != element:
                    raise RoadNetworkError(502, 'osm_unavailable',
                                           'Building partitions returned conflicting versions of an OSM object.')
                continue
            input_bytes += len(json.dumps(element, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
            check_input_budget(input_bytes)
            candidates[key] = element
        if timestamp is not None:
            timestamps.append(timestamp)
        partition_count += 1

    provenance = {'partition_count': partition_count}
    timestamp = min(timestamps) if len(timestamps) == partition_count and timestamps else None
    if timestamps and min(timestamps) != max(timestamps):
        provenance['osm_data_time_range'] = [min(timestamps), max(timestamps)]
    return await asyncio.to_thread(_convert, 'buildings', None, candidates, timestamp, area,
                                   result_budget=MAX_MERGED_BYTES, feature_budget=MAX_MERGED_BUILDINGS,
                                   provenance=provenance)


def query_snapshot_buildings(query_tile, area, deadline):
    partitions = BuildingPartitions(area, deadline)
    parts = {}
    partition_count = input_bytes = 0
    for tile in partitions:
        try:
            summary, payload = query_tile(tile)
        except RoadNetworkError as exc:
            if exc.code != 'feature_limit':
                raise
            partitions.split(tile)
            continue
        check_deadline(deadline)
        if partitions.attempts == 1 and tile.equals(area):
            return {**summary, 'partition_count': 1}, payload
        partition_count += 1
        input_bytes += len(payload)
        check_input_budget(input_bytes)
        collection = json.loads(payload)
        for feature in collection['features']:
            props = feature['properties']
            key = (props['osm_type'], props['osm_id'])
            properties, geometries = parts.setdefault(key, (props, []))
            if properties != props:
                raise ValueError('Inconsistent properties in building snapshot')
            geometries.append(shape(feature['geometry']))
        if len(parts) > MAX_MERGED_BUILDINGS:
            raise RoadNetworkError(422, 'feature_limit',
                                   f'The merged result exceeds {MAX_MERGED_BUILDINGS:,} buildings. Select a smaller area.')

    features = []
    for properties, geometries in parts.values():
        check_deadline(deadline)
        geometry = geometries[0]
        if len(geometries) > 1:
            geometry = orient_polygons(_polygonal(union_all(geometries).intersection(area)))
        features.append({'type': 'Feature', 'geometry': mapping(geometry), 'properties': properties})
    summary.update(status='ok' if features else 'empty', count=len(features), partition_count=partition_count,
                   by_category=dict(sorted(Counter(f['properties']['category'] for f in features).items())))
    collection.update(features=features, partition_count=partition_count)
    payload = json.dumps(collection, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(payload) > MAX_MERGED_BYTES:
        raise RoadNetworkError(422, 'feature_limit', 'The merged GeoJSON exceeds the result budget. Select a smaller area.')
    check_deadline(deadline)
    return summary, payload

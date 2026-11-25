"""Resident, isolated JSON-lines worker for SatGPT OSM tools."""

import asyncio
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
from uuid import uuid4

import httpx

# The worker is launched with Python's isolated mode.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from harness.app.osm_building_partitions import (BUILDING_DEADLINE_SECONDS, MAX_BUILDING_AREA_KM2,
                                                  ONLINE_DEADLINE_SECONDS, query_online_buildings)
from harness.app.osm_queries import OverpassQueries, query_scope, validate_category
from harness.app.osm_transport import OVERPASS_REQUEST_TIMEOUT_SECONDS, RoadNetworkError
from harness.app.road_snapshot import query_snapshot
from harness.app.regional_osm import query_regional_snapshot
from harness.app.geo_index import get as indexed_data, publish as index_publication
from shapely import GEOSException
from shapely.geometry import mapping, shape


ONLINE_FAILURES = {'osm_timeout', 'osm_rate_limited', 'osm_unavailable'}


async def query_local(kind, category, area, **snapshot_options):
    regional = os.environ.get('SATGPT_OSM_SNAPSHOT_DIR')
    road = os.environ.get('SATGPT_ROAD_SNAPSHOT') if kind == 'roads' else None
    failure = None
    if regional:
        try:
            summary, content = await asyncio.to_thread(query_regional_snapshot, regional, kind, category, area,
                                                       **snapshot_options)
            return {**summary, 'source_mode': 'regional_snapshot'}, content
        except RoadNetworkError as exc:
            failure = exc
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, GEOSException):
            failure = RoadNetworkError(502, 'osm_snapshot_unavailable', 'The configured OSM snapshot could not be read.')
    if road:
        try:
            result = await asyncio.to_thread(query_snapshot, road, category, area)
            if result is not None:
                summary, content = result
                return {**summary, 'source_mode': 'road_snapshot'}, content
            if failure is None:
                failure = RoadNetworkError(422, 'osm_snapshot_outside_coverage',
                                           'The road snapshot does not match this selection and category.')
        except RoadNetworkError as exc:
            failure = exc
        except (OSError, ValueError, KeyError, TypeError, GEOSException):
            failure = RoadNetworkError(502, 'osm_snapshot_unavailable', 'The configured road snapshot could not be read.')
    if failure is not None:
        raise failure
    raise RoadNetworkError(503, 'osm_unavailable', 'No local OSM snapshot is configured for this query.')


def building_scope(region, bounds):
    return query_scope(region, bounds, 'buildings', area_budget=MAX_BUILDING_AREA_KM2)


async def query_buildings(service, region, bounds):
    started = time.monotonic()
    deadline = started + BUILDING_DEADLINE_SECONDS
    area = building_scope(region, bounds)
    if service is None:
        return await query_local('buildings', None, area, building_deadline=deadline)

    try:
        try:
            async with asyncio.timeout(ONLINE_DEADLINE_SECONDS):
                summary, content = await query_online_buildings(service, region, bounds, area,
                                                                started + ONLINE_DEADLINE_SECONDS)
        except TimeoutError as exc:
            raise RoadNetworkError(504, 'osm_timeout', 'The online building query reached its time budget.') from exc
        return {**summary, 'source_mode': 'overpass', 'source': 'OpenStreetMap via Overpass'}, content
    except RoadNetworkError as online:
        if online.code not in ONLINE_FAILURES and online.code != 'feature_limit':
            raise
        try:
            summary, content = await query_local('buildings', None, area, building_deadline=deadline)
        except RoadNetworkError as local:
            raise RoadNetworkError(online.status_code, online.code, f'{online} {local}') from online
        if online.code == 'feature_limit' and not summary['count']:
            raise
        return {**summary, 'fallback_reason': online.code}, content


async def query_sources(service, kind, category, region, bounds):
    validate_category(kind, category)
    if kind == 'buildings':
        return await query_buildings(service, region, bounds)
    if service is None:
        area = query_scope(region, bounds, kind)
        if kind == 'pois':
            raise RoadNetworkError(503, 'osm_unavailable', 'No online OSM provider is configured for POI queries.')
        return await query_local(kind, category, area)

    try:
        summary, content = await service.query(kind, category, region, bounds)
        return {**summary, 'source_mode': 'overpass', 'source': 'OpenStreetMap via Overpass'}, content
    except RoadNetworkError as online:
        if kind == 'pois' or online.code not in ONLINE_FAILURES:
            raise
        try:
            summary, content = await query_local(kind, category, query_scope(region, bounds, kind))
        except RoadNetworkError as local:
            raise RoadNetworkError(online.status_code, online.code, f'{online} {local}') from online
        return {**summary, 'fallback_reason': online.code}, content


async def execute(service, payload):
    kind, category = payload['kind'], payload.get('category')
    region, bounds = payload.get('analysis_region'), payload.get('bounds')
    flood_ref = payload.get('flood_ref')
    selected = payload.get('selected_region')
    context = payload.get('geo_context')
    label = (payload.get('analysis_aoi') or {}).get('label')
    if payload.get('flood_data_ref'):
        try:
            flood = indexed_data(context, payload['flood_data_ref'], ('flood',))
        except ValueError as exc:
            raise RoadNetworkError(422, 'invalid_data_reference', str(exc)) from exc
        selected, region, bounds = region, flood['geometry'], flood['bounds']
        flood_ref = flood['legacy_ref']
        label = flood['name']
    if flood_ref and selected and not shape(selected).equals(shape(region)):
        raise RoadNetworkError(422, 'scope_conflict', 'The confirmed area differs from the saved flood area. Select the original flood area or clear the current selection.')
    summary, content = await query_sources(service, kind, category, region, bounds)
    if flood_ref and summary['count']:
        collection = json.loads(content)
        collection['flood_result_ref'] = flood_ref
        content = json.dumps(collection, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    result = {"summary": summary}
    if summary["count"]:
        area = building_scope(region, bounds) if kind == 'buildings' else query_scope(region, bounds, kind)
        folder = Path(payload["artifact_dir"])
        folder.mkdir(parents=True, exist_ok=True)
        reference = uuid4().hex
        path = folder / f"{reference}.geojson"
        temporary = path.with_suffix(".tmp")
        try:
            temporary.write_bytes(content)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        result["artifact_ref"] = reference
        if context:
            try:
                data_ref = index_publication(context, kind, reference, {**summary, 'category': category},
                    {'analysis_region': mapping(area), 'bounds': list(area.bounds), 'label': label})
                if data_ref is None:
                    raise ValueError('OSM artifact could not be indexed')
            except (ValueError, OSError, sqlite3.Error):
                path.unlink(missing_ok=True)
                raise RoadNetworkError(502, 'osm_index_unavailable', 'The OSM result could not be registered.') from None
            summary['data_ref'] = data_ref
        result['bounds'] = list(area.bounds)
    return result


async def main():
    # DSH adds bracketed IPv6 literals to NO_PROXY. HTTPX expects bare IPv6 entries.
    for key in [name for name in os.environ if name.lower() == "no_proxy"]:
        hosts = os.environ[key].split(",")
        os.environ[key] = ",".join(re.sub(r"^\s*\[([\da-fA-F:.]*:[\da-fA-F:.]*)\]\s*$", r"\1", host) for host in hosts)
    async with httpx.AsyncClient(headers={"User-Agent": "SatGPT/OSM (OpenStreetMap data query)"},
                                 timeout=httpx.Timeout(OVERPASS_REQUEST_TIMEOUT_SECONDS, connect=5)) as client:
        endpoint = os.environ.get('SATGPT_OVERPASS_URL')
        service = OverpassQueries(client, endpoint) if endpoint else None
        try:
            while line := await asyncio.to_thread(sys.stdin.readline):
                request = json.loads(line)
                response = {"id": request["id"], "ok": True}
                try:
                    response["data"] = await execute(service, request["payload"])
                except RoadNetworkError as exc:
                    response["data"] = {"error": {"code": exc.code, "message": str(exc)}}
                except (OSError, ValueError, KeyError, TypeError):
                    response.update(ok=False, error="OSM query or artifact could not be processed.")
                print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)
        finally:
            if service is not None:
                await service.close()


if __name__ == "__main__":
    asyncio.run(main())

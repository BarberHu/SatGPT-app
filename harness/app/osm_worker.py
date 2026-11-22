"""Resident, isolated JSON-lines worker for SatGPT OSM tools."""

import asyncio
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from uuid import uuid4

import httpx

# The worker is launched with Python's isolated mode.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from harness.app.osm_queries import OverpassQueries, query_scope, validate_category
from harness.app.osm_transport import RoadNetworkError

from harness.app.road_snapshot import query_snapshot
from harness.app.regional_osm import query_regional_snapshot
from shapely import GEOSException


ONLINE_FAILURES = {'osm_timeout', 'osm_rate_limited', 'osm_unavailable'}


async def query_local(kind, category, area):
    regional = os.environ.get('SATGPT_OSM_SNAPSHOT_DIR')
    road = os.environ.get('SATGPT_ROAD_SNAPSHOT') if kind == 'roads' else None
    failure = None
    if regional:
        try:
            summary, content = await asyncio.to_thread(query_regional_snapshot, regional, kind, category, area)
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


async def query_sources(service, kind, category, region, bounds):
    validate_category(kind, category)
    if service is None:
        area = query_scope(region, bounds, kind)
        if kind == 'pois':
            raise RoadNetworkError(503, 'osm_unavailable', 'No online OSM provider is configured for POI queries.')
        return await query_local(kind, category, area)

    try:
        summary, content = await service.query(kind, category, region, bounds)
        return {**summary, 'source_mode': 'overpass', 'source': 'OpenStreetMap via Overpass'}, content
    except RoadNetworkError as online:
        building_limit = kind == 'buildings' and online.code == 'feature_limit'
        if kind == 'pois' or not (online.code in ONLINE_FAILURES or building_limit):
            raise
        try:
            summary, content = await query_local(kind, category, query_scope(region, bounds, kind))
        except RoadNetworkError as local:
            raise RoadNetworkError(online.status_code, online.code, f'{online} {local}') from online
        if building_limit and not summary['count']:
            raise
        return {**summary, 'fallback_reason': online.code}, content


async def execute(service, payload):
    kind, category = payload['kind'], payload.get('category')
    region, bounds = payload.get('analysis_region'), payload.get('bounds')
    summary, content = await query_sources(service, kind, category, region, bounds)
    result = {"summary": summary}
    if summary["count"]:
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
        result["bounds"] = list(query_scope(region, bounds, kind).bounds)
    return result


async def main():
    # DSH adds bracketed IPv6 literals to NO_PROXY. HTTPX expects bare IPv6 entries.
    for key in [name for name in os.environ if name.lower() == "no_proxy"]:
        hosts = os.environ[key].split(",")
        os.environ[key] = ",".join(re.sub(r"^\s*\[([\da-fA-F:.]*:[\da-fA-F:.]*)\]\s*$", r"\1", host) for host in hosts)
    async with httpx.AsyncClient(headers={"User-Agent": "SatGPT/OSM (OpenStreetMap data query)"},
                                 timeout=httpx.Timeout(10, connect=5)) as client:
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

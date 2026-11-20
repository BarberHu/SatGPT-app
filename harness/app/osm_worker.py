"""Resident, isolated JSON-lines worker for SatGPT OSM tools."""

import asyncio
import json
import os
from pathlib import Path
import re
import sys
from uuid import uuid4

import httpx

# The worker is launched with Python's isolated mode.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from basic.osm_queries import OverpassQueries
from basic.road_network import RoadNetworkError


async def execute(service, payload):
    summary, content = await service.query(payload["kind"], payload.get("category"),
                                           payload.get("analysis_region"), payload.get("bounds"))
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
    return result


async def main():
    # DSH adds bracketed IPv6 literals to NO_PROXY. HTTPX expects bare IPv6 entries.
    for key in [name for name in os.environ if name.lower() == "no_proxy"]:
        hosts = os.environ[key].split(",")
        os.environ[key] = ",".join(re.sub(r"^\s*\[([\da-fA-F:.]*:[\da-fA-F:.]*)\]\s*$", r"\1", host) for host in hosts)
    async with httpx.AsyncClient(headers={"User-Agent": "SatGPT/OSM (OpenStreetMap data query)"},
                                 timeout=httpx.Timeout(10, connect=5)) as client:
        service = OverpassQueries(client, os.environ["SATGPT_OVERPASS_URL"])
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
            await service.close()


if __name__ == "__main__":
    asyncio.run(main())

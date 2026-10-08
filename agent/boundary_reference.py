"""Versioned reference boundaries for places with unsuitable geocoder outlines."""

import json
import re
from copy import deepcopy
from functools import lru_cache
from pathlib import Path


_BOUNDARIES = (
    {
        "file": "bangkok.geojson",
        "osm_relation": "92277",
        "aliases": {
            "bangkok", "bangkok thailand", "bangkok metropolis",
            "bangkok metropolis thailand", "krung thep maha nakhon",
            "krung thep maha nakhon thailand", "กรุงเทพมหานคร", "กรุงเทพฯ",
            "曼谷", "曼谷 泰国", "泰国 曼谷",
        },
    },
)


def _normalize_query(query):
    return re.sub(r"[\s,，]+", " ", str(query or "")).strip().casefold()


@lru_cache(maxsize=8)
def _load_boundary(filename):
    path = Path(__file__).resolve().parent / "data" / "boundaries" / filename
    return json.loads(path.read_text(encoding="utf-8"))


def find_reference_boundary(query=None, properties=None):
    """Match an exact city alias or OSM identity, never a district/metro substring."""
    normalized = _normalize_query(query)
    properties = properties or {}
    for entry in _BOUNDARIES:
        matches_query = normalized in entry["aliases"]
        matches_identity = (
            properties.get("osm_type") == "relation"
            and str(properties.get("osm_id")) == entry["osm_relation"]
        )
        if matches_query or matches_identity:
            # Callers change scope properties; keep the cached asset immutable.
            return deepcopy(_load_boundary(entry["file"]))
    return None

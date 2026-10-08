import threading
import time
from collections import OrderedDict
from copy import deepcopy
from typing import Any, Dict, Optional

import requests
from boundary_reference import find_reference_boundary
from boundary_geometry import checked_polygon, polygon_identity


AOI_STATUS_RESOLVED = "Boundary resolved"
AOI_STATUS_APPROXIMATE = "Approximate boundary"
NOMINATIM_MIN_INTERVAL_SECONDS = 1.0
NOMINATIM_CACHE_MAX_ENTRIES = 256
NOMINATIM_CACHE_TTL_SECONDS = 3600

_NOMINATIM_LOCK = threading.Lock()
_NOMINATIM_LAST_REQUEST_AT = 0.0
_NOMINATIM_CACHE: OrderedDict[str, tuple[float, Dict[str, Any]]] = OrderedDict()


def _query_nominatim(location_name: str) -> Dict[str, Any]:
    """Query Nominatim through a process-local 1 RPS gate and bounded cache."""
    global _NOMINATIM_LAST_REQUEST_AT

    normalized_location = " ".join(str(location_name or "").strip().split())
    cache_key = normalized_location.casefold()
    if not cache_key:
        return {}

    with _NOMINATIM_LOCK:
        cached = _NOMINATIM_CACHE.get(cache_key)
        if cached is not None and time.monotonic() - cached[0] < NOMINATIM_CACHE_TTL_SECONDS:
            _NOMINATIM_CACHE.move_to_end(cache_key)
            return deepcopy(cached[1])

        elapsed = time.monotonic() - _NOMINATIM_LAST_REQUEST_AT
        remaining_delay = NOMINATIM_MIN_INTERVAL_SECONDS - elapsed
        if remaining_delay > 0:
            time.sleep(remaining_delay)

        _NOMINATIM_LAST_REQUEST_AT = time.monotonic()
        response = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": normalized_location,
                "format": "geojson",
                "polygon_geojson": 1,
                "limit": 10,
                "layer": "address",
                "addressdetails": 1,
                "extratags": 1,
                "accept-language": "en,zh-CN",
            },
            headers={"User-Agent": "FloodAgent/2.0"},
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()

        _NOMINATIM_CACHE[cache_key] = (time.monotonic(), deepcopy(data))
        _NOMINATIM_CACHE.move_to_end(cache_key)
        while len(_NOMINATIM_CACHE) > NOMINATIM_CACHE_MAX_ENTRIES:
            _NOMINATIM_CACHE.popitem(last=False)

        return deepcopy(data)


def _close_ring(coordinates: list[list[float]]) -> list[list[float]]:
    if not coordinates:
        return []
    normalized = [[float(lon), float(lat)] for lon, lat in coordinates]
    if normalized[0] != normalized[-1]:
        normalized.append(list(normalized[0]))
    return normalized


def _build_bounds_polygon(bounds: Dict[str, float]) -> Dict[str, Any]:
    ring = _close_ring(
        [
            [bounds["west"], bounds["south"]],
            [bounds["east"], bounds["south"]],
            [bounds["east"], bounds["north"]],
            [bounds["west"], bounds["north"]],
        ]
    )
    return {
        "type": "Feature",
        "properties": {},
        "geometry": {
            "type": "Polygon",
            "coordinates": [ring],
        },
    }


def _extract_all_coordinates(coordinates: Any, result: Optional[list[list[float]]] = None) -> list[list[float]]:
    output = result if result is not None else []
    if isinstance(coordinates, list) and coordinates:
        first = coordinates[0]
        if isinstance(first, (int, float)) and len(coordinates) >= 2:
            output.append([float(coordinates[0]), float(coordinates[1])])
        else:
            for item in coordinates:
                _extract_all_coordinates(item, output)
    return output


def _bounds_from_geometry(geometry: Optional[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    if not geometry:
        return None
    coords = _extract_all_coordinates(geometry.get("coordinates"))
    if not coords:
        return None
    lons = [coord[0] for coord in coords]
    lats = [coord[1] for coord in coords]
    return {
        "west": min(lons),
        "south": min(lats),
        "east": max(lons),
        "north": max(lats),
    }


def _center_from_bounds(bounds: Optional[Dict[str, float]]) -> list[float]:
    if not bounds:
        return [0.0, 0.0]
    return [
        (bounds["west"] + bounds["east"]) / 2,
        (bounds["south"] + bounds["north"]) / 2,
    ]


def _build_aoi(
    *,
    location: str,
    geometry: Dict[str, Any],
    bounds: Dict[str, float],
    source: str,
    confidence: float,
    status: str,
    resolution_rank: int,
    boundary_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    feature = {
        "type": "Feature",
        "properties": {
            "label": location,
            "source": source,
            "confidence": confidence,
            "status": status,
            **(boundary_metadata or {}),
        },
        "geometry": geometry,
    }
    return {
        "version": 1,
        "source": source,
        "label": location,
        "kind": "multipolygon" if geometry.get("type") == "MultiPolygon" else "polygon",
        "bounds": bounds,
        "geojson": feature,
        "confidence": confidence,
        "status": status,
        "resolution_rank": resolution_rank,
        **(boundary_metadata or {}),
    }


def _build_resolution_meta(
    *,
    location: str,
    source: str,
    confidence: float,
    status: str,
    bounds: Optional[Dict[str, float]],
    resolution_rank: int,
    boundary_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "location": location,
        "source": source,
        "confidence": confidence,
        "status": status,
        "bounds": bounds,
        "resolution_rank": resolution_rank,
        **(boundary_metadata or {}),
    }


def _search_location_features(location_name: str) -> list[Dict[str, Any]]:
    reference = find_reference_boundary(query=location_name)
    if reference:
        return [reference]

    data = _query_nominatim(location_name)
    features = []
    for feature in data.get("features") or []:
        if not isinstance(feature, dict):
            continue
        reference = find_reference_boundary(properties=feature.get("properties"))
        features.append(reference or feature)
    return features


def _boundary_metadata(properties: Dict[str, Any]) -> Dict[str, Any]:
    keys = ("source_label", "boundary_provider", "boundary_year", "boundary_id",
            "boundary_url", "boundary_notice", "boundary_license", "boundary_scope")
    metadata = {key: properties[key] for key in keys if properties.get(key)}
    address = properties.get("address") or {}
    tags = properties.get("extratags") or {}
    source = "reference_boundary" if properties.get("source") == "reference_boundary" else "osm_boundary"
    metadata.update({
        "boundary_source": source,
        "boundary_scope": metadata.get("boundary_scope") or "administrative_extent",
        "boundary_kind": properties.get("addresstype") or "administrative region",
        "country_code": address.get("country_code", "").upper(),
        "country": address.get("country"),
        "admin_level": tags.get("admin_level"),
        "geometry_validation": "valid_polygon",
        "can_analyze": True,
    })
    if source == "osm_boundary":
        metadata.update({
            "source_label": "OpenStreetMap boundary",
            "boundary_provider": "OpenStreetMap contributors / Nominatim",
            "boundary_license": "ODbL 1.0",
            "boundary_year": "Not supplied",
            "boundary_notice": "Community-mapped administrative extent; may include offshore waters. Boundary year not supplied.",
        })
        osm_type, osm_id = properties.get("osm_type"), properties.get("osm_id")
        if osm_type in {"relation", "way"} and str(osm_id or "").isdigit():
            metadata["boundary_url"] = f"https://www.openstreetmap.org/{osm_type}/{osm_id}"
    return {key: value for key, value in metadata.items() if value is not None}


def search_location_candidates(location_name: str, limit: int = 5) -> list[Dict[str, Any]]:
    """Only actual administrative polygons can become searchable analysis scopes."""
    location = (location_name or "").strip()
    if not location:
        return []
    safe_limit = max(1, min(int(limit or 5), 10))
    try:
        features = _search_location_features(location)
    except Exception:
        return []

    candidates: list[Dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_geometries: set[tuple[str, str, str]] = set()
    for index, feature in enumerate(features):
        if not isinstance(feature, dict):
            continue
        properties = feature.get("properties") or {}
        if (properties.get("category") or properties.get("class")) != "boundary" or properties.get("type") != "administrative":
            continue
        geometry = feature.get("geometry")
        polygon = checked_polygon(geometry)
        if polygon is None:
            continue
        # Never use a geocoder bbox to create a replacement polygon. Preserve
        # the original rings, holes and every island; bounds are derived from it.
        bounds = _bounds_from_geometry(geometry)
        label = str(properties.get("display_name") or location).strip()
        source = "reference_boundary" if properties.get("source") == "reference_boundary" else "osm_boundary"
        candidate_id = str(properties.get("place_id") or f"candidate:{index}")
        if properties.get("osm_type") and properties.get("osm_id"):
            candidate_id = f"{source}:{properties['osm_type']}:{properties['osm_id']}"
        metadata = _boundary_metadata(properties)
        geometry_id = (metadata.get("country_code", ""), metadata.get("admin_level") or metadata["boundary_kind"],
                       polygon_identity(polygon))
        if candidate_id in seen_ids or geometry_id in seen_geometries:
            continue
        confidence = 0.9 if source == "reference_boundary" else 0.75
        resolved_aoi = _build_aoi(
            location=label, geometry=geometry, bounds=bounds, source=source,
            confidence=confidence, status=AOI_STATUS_RESOLVED, resolution_rank=1,
            boundary_metadata=metadata,
        )
        candidates.append({
            "id": candidate_id, "location": label, "label": label,
            "resolved_aoi": resolved_aoi,
            "aoi_resolution_meta": _build_resolution_meta(
                location=label, source=source, confidence=confidence,
                status=AOI_STATUS_RESOLVED, bounds=bounds, resolution_rank=1,
                boundary_metadata=metadata,
            ),
            "coordinates": _center_from_bounds(bounds), "bounds": bounds,
            "geojson": resolved_aoi["geojson"], "source": source,
            "raw_type": properties.get("type"),
            "raw_class": properties.get("category") or properties.get("class"),
            **metadata,
        })
        seen_ids.add(candidate_id)
        seen_geometries.add(geometry_id)
        if len(candidates) >= safe_limit:
            break
    return candidates


def resolve_location_aoi(location_name: str) -> Dict[str, Any]:
    """Use the same checked candidates as map search, requiring an unambiguous scope."""
    location = (location_name or "").strip()
    candidates = search_location_candidates(location, limit=10)
    if len(candidates) == 1:
        candidate = candidates[0]
        return {
            "resolved_aoi": candidate["resolved_aoi"],
            "aoi_resolution_meta": candidate["aoi_resolution_meta"],
            "coordinates": candidate["coordinates"], "bounds": candidate["bounds"],
            "geojson": candidate["geojson"],
            "geo_data": {"location": candidate["label"], "source": candidate["source"]},
        }
    ambiguous = len(candidates) > 1
    notice = (
        "Multiple administrative boundaries match. Search and select the intended region, then mention its @ layer."
        if ambiguous else
        "No usable administrative polygon found. Include the country/region, or draw/upload the intended area."
    )
    return {
        "resolved_aoi": None,
        "aoi_resolution_meta": _build_resolution_meta(
            location=location, source="ambiguous" if ambiguous else "unresolved",
            confidence=0.0,
            status="Boundary selection required" if ambiguous else "Boundary unavailable",
            bounds=None, resolution_rank=99,
            boundary_metadata={
                "can_analyze": False, "boundary_notice": notice,
                "candidates": [{"id": c["id"], "label": c["label"], "boundary_kind": c["boundary_kind"]} for c in candidates],
            },
        ),
        "coordinates": [0.0, 0.0], "bounds": None, "geojson": None,
        "geo_data": {"error": notice},
    }


def aoi_to_geo_fields(aoi: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not aoi:
        return {
            "coordinates": [0.0, 0.0],
            "bounds": {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0},
            "geojson": None,
        }
    geojson = aoi.get("geojson") or {}
    geometry = geojson.get("geometry") if geojson.get("type") == "Feature" else geojson
    bounds = aoi.get("bounds") or _bounds_from_geometry(geometry)
    return {
        "coordinates": _center_from_bounds(bounds),
        "bounds": bounds,
        "geojson": aoi.get("geojson"),
    }


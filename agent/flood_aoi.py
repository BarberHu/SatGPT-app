import json
import os
import time
from typing import Any, Dict, Optional

import requests
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI


AOI_STATUS_RESOLVED = "Boundary resolved"
AOI_STATUS_APPROXIMATE = "Approximate boundary"


def get_chat_model() -> ChatOpenAI:
    return ChatOpenAI(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        api_key=os.getenv("OPENAI_API_KEY", ""),
        base_url=os.getenv("OPENAI_API_BASE"),
        temperature=0.2,
    )


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
    output = result or []
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
) -> Dict[str, Any]:
    feature = {
        "type": "Feature",
        "properties": {
            "label": location,
            "source": source,
            "confidence": confidence,
            "status": status,
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
    }


def _build_resolution_meta(
    *,
    location: str,
    source: str,
    confidence: float,
    status: str,
    bounds: Optional[Dict[str, float]],
    resolution_rank: int,
) -> Dict[str, Any]:
    return {
        "location": location,
        "source": source,
        "confidence": confidence,
        "status": status,
        "bounds": bounds,
        "resolution_rank": resolution_rank,
    }


def _classify_location_type(location_name: str) -> str:
    prompt = f"""Determine whether this place name is an administrative region or a composite/natural region.

Place: {location_name}

Return JSON only:
{{"type":"administrative|composite"}}
"""
    try:
        response = get_chat_model().invoke([HumanMessage(content=prompt)])
        content = str(response.content).strip()
        if "```json" in content:
            content = content.split("```json", 1)[1].split("```", 1)[0]
        elif "```" in content:
            content = content.split("```", 1)[1].split("```", 1)[0]
        payload = json.loads(content.strip())
        return payload.get("type", "administrative")
    except Exception:
        return "administrative"


def _generate_geojson_with_llm(location_name: str) -> Optional[Dict[str, Any]]:
    prompt = f"""Generate an approximate GeoJSON polygon for this geographic region.

Region: {location_name}

Rules:
- return a simplified polygon with 4-8 vertices
- coordinates must be [longitude, latitude]
- polygon must be closed

Return JSON only:
{{
  "geometry": {{
    "type": "Polygon",
    "coordinates": [[[lon, lat], [lon, lat], [lon, lat], [lon, lat], [lon, lat]]]
  }}
}}
"""
    try:
        response = get_chat_model().invoke([HumanMessage(content=prompt)])
        content = str(response.content).strip()
        if "```json" in content:
            content = content.split("```json", 1)[1].split("```", 1)[0]
        elif "```" in content:
            content = content.split("```", 1)[1].split("```", 1)[0]
        payload = json.loads(content.strip())
        geometry = payload.get("geometry")
        bounds = _bounds_from_geometry(geometry)
        if not geometry or not bounds:
            return None
        return {
            "geometry": geometry,
            "bounds": bounds,
        }
    except Exception:
        return None


def _get_location_from_nominatim(location_name: str) -> Optional[Dict[str, Any]]:
    try:
        time.sleep(1)
        response = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": location_name,
                "format": "geojson",
                "polygon_geojson": 1,
                "limit": 1,
                "accept-language": "en,zh-CN",
            },
            headers={"User-Agent": "FloodAgent/2.0"},
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        features = data.get("features") or []
        if not features:
            return None

        feature = features[0]
        geometry = feature.get("geometry")
        properties = feature.get("properties", {})
        bounds = _bounds_from_geometry(geometry)

        return {
            "location": properties.get("display_name", location_name),
            "geometry": geometry,
            "bounds": bounds,
            "raw_type": properties.get("type"),
            "raw_class": properties.get("class"),
        }
    except Exception:
        return None


def search_location_candidates(location_name: str, limit: int = 5) -> list[Dict[str, Any]]:
    location = (location_name or "").strip()
    if not location:
        return []

    safe_limit = max(1, min(int(limit or 5), 5))

    try:
        time.sleep(1)
        response = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": location,
                "format": "geojson",
                "polygon_geojson": 1,
                "limit": safe_limit,
                "accept-language": "en,zh-CN",
            },
            headers={"User-Agent": "FloodAgent/2.0"},
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
    except Exception:
        return []

    features = data.get("features") or []
    candidates: list[Dict[str, Any]] = []
    seen_labels: set[str] = set()

    for index, feature in enumerate(features):
        properties = feature.get("properties", {})
        geometry = feature.get("geometry")
        bbox = feature.get("bbox") or []
        label = properties.get("display_name", location).strip() or location
        label_key = label.lower()
        if label_key in seen_labels:
            continue

        bounds = _bounds_from_geometry(geometry)
        if not bounds and len(bbox) == 4:
            bounds = {
                "west": float(bbox[0]),
                "south": float(bbox[1]),
                "east": float(bbox[2]),
                "north": float(bbox[3]),
            }

        if geometry and geometry.get("type") in {"Polygon", "MultiPolygon"} and bounds:
            source = "official_boundary"
            confidence = 0.98
            status = AOI_STATUS_RESOLVED
            resolution_rank = 1
            resolved_geometry = geometry
        elif bounds:
            source = "bounds_fallback"
            confidence = 0.72
            status = AOI_STATUS_APPROXIMATE
            resolution_rank = 3
            resolved_geometry = _build_bounds_polygon(bounds)["geometry"]
        else:
            continue

        resolved_aoi = _build_aoi(
            location=label,
            geometry=resolved_geometry,
            bounds=bounds,
            source=source,
            confidence=confidence,
            status=status,
            resolution_rank=resolution_rank,
        )

        candidate_id = str(
            properties.get("place_id")
            or properties.get("osm_id")
            or f"{label_key}-{index}"
        )

        candidates.append({
            "id": candidate_id,
            "location": label,
            "label": label,
            "resolved_aoi": resolved_aoi,
            "aoi_resolution_meta": _build_resolution_meta(
                location=label,
                source=source,
                confidence=confidence,
                status=status,
                bounds=bounds,
                resolution_rank=resolution_rank,
            ),
            "coordinates": _center_from_bounds(bounds),
            "bounds": bounds,
            "geojson": resolved_aoi["geojson"],
            "source": source,
            "raw_type": properties.get("type"),
            "raw_class": properties.get("class"),
        })
        seen_labels.add(label_key)

        if len(candidates) >= safe_limit:
            break

    return candidates


def resolve_location_aoi(location_name: str) -> Dict[str, Any]:
    location = (location_name or "").strip()
    if not location:
        empty_bounds = {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}
        return {
            "resolved_aoi": None,
            "aoi_resolution_meta": _build_resolution_meta(
                location="",
                source="empty",
                confidence=0.0,
                status=AOI_STATUS_APPROXIMATE,
                bounds=empty_bounds,
                resolution_rank=99,
            ),
            "coordinates": [0.0, 0.0],
            "bounds": empty_bounds,
            "geojson": None,
            "geo_data": {},
        }

    nominatim = _get_location_from_nominatim(location)
    if nominatim and nominatim.get("geometry") and nominatim["geometry"].get("type") in {"Polygon", "MultiPolygon"}:
        bounds = nominatim["bounds"] or _bounds_from_geometry(nominatim["geometry"])
        resolved_aoi = _build_aoi(
            location=nominatim["location"],
            geometry=nominatim["geometry"],
            bounds=bounds,
            source="official_boundary",
            confidence=0.98,
            status=AOI_STATUS_RESOLVED,
            resolution_rank=1,
        )
        return {
            "resolved_aoi": resolved_aoi,
            "aoi_resolution_meta": _build_resolution_meta(
                location=nominatim["location"],
                source="official_boundary",
                confidence=0.98,
                status=AOI_STATUS_RESOLVED,
                bounds=bounds,
                resolution_rank=1,
            ),
            "coordinates": _center_from_bounds(bounds),
            "bounds": bounds,
            "geojson": resolved_aoi["geojson"],
            "geo_data": nominatim,
        }

    if nominatim and nominatim.get("bounds"):
        bounds = nominatim["bounds"]
        approx_feature = _build_bounds_polygon(bounds)
        resolved_aoi = _build_aoi(
            location=nominatim["location"],
            geometry=approx_feature["geometry"],
            bounds=bounds,
            source="bounds_fallback",
            confidence=0.72,
            status=AOI_STATUS_APPROXIMATE,
            resolution_rank=3,
        )
        return {
            "resolved_aoi": resolved_aoi,
            "aoi_resolution_meta": _build_resolution_meta(
                location=nominatim["location"],
                source="bounds_fallback",
                confidence=0.72,
                status=AOI_STATUS_APPROXIMATE,
                bounds=bounds,
                resolution_rank=3,
            ),
            "coordinates": _center_from_bounds(bounds),
            "bounds": bounds,
            "geojson": resolved_aoi["geojson"],
            "geo_data": nominatim,
        }

    classification = _classify_location_type(location)
    if classification in {"composite", "administrative"}:
        llm_geo = _generate_geojson_with_llm(location)
        if llm_geo:
            resolved_aoi = _build_aoi(
                location=location,
                geometry=llm_geo["geometry"],
                bounds=llm_geo["bounds"],
                source="approximate_boundary",
                confidence=0.45,
                status=AOI_STATUS_APPROXIMATE,
                resolution_rank=4,
            )
            return {
                "resolved_aoi": resolved_aoi,
                "aoi_resolution_meta": _build_resolution_meta(
                    location=location,
                    source="approximate_boundary",
                    confidence=0.45,
                    status=AOI_STATUS_APPROXIMATE,
                    bounds=llm_geo["bounds"],
                    resolution_rank=4,
                ),
                "coordinates": _center_from_bounds(llm_geo["bounds"]),
                "bounds": llm_geo["bounds"],
                "geojson": resolved_aoi["geojson"],
                "geo_data": {"classification": classification},
            }

    empty_bounds = {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0}
    return {
        "resolved_aoi": None,
        "aoi_resolution_meta": _build_resolution_meta(
            location=location,
            source="unresolved",
            confidence=0.0,
            status=AOI_STATUS_APPROXIMATE,
            bounds=empty_bounds,
            resolution_rank=99,
        ),
        "coordinates": [0.0, 0.0],
        "bounds": empty_bounds,
        "geojson": None,
        "geo_data": {"error": f"Unable to resolve boundary for '{location}'"},
    }


def aoi_to_geo_fields(aoi: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not aoi:
        return {
            "coordinates": [0.0, 0.0],
            "bounds": {"west": -180.0, "south": -90.0, "east": 180.0, "north": 90.0},
            "geojson": None,
        }
    return {
        "coordinates": _center_from_bounds(aoi.get("bounds")),
        "bounds": aoi.get("bounds"),
        "geojson": aoi.get("geojson"),
    }


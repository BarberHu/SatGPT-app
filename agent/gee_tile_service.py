from __future__ import annotations

import json
import math
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import ee
import requests

from water_asset_catalog import AssetRecord

try:
    from dotenv import dotenv_values, load_dotenv
except ImportError:  # pragma: no cover
    dotenv_values = None
    load_dotenv = None


def lon_lat_to_tile(lon: float, lat: float, zoom: int) -> Tuple[int, int]:
    lat_rad = math.radians(max(min(lat, 85.05112878), -85.05112878))
    scale = 2**zoom
    x_tile = int((lon + 180.0) / 360.0 * scale)
    y_tile = int((1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * scale)
    return x_tile, y_tile


def resolve_tile_template(url_template: str, x_tile: int, y_tile: int, zoom: int) -> str:
    return (url_template or "").replace("{x}", str(x_tile)).replace("{y}", str(y_tile)).replace("{z}", str(zoom))


def _bootstrap_env(project_root: Path) -> None:
    env_path = project_root / ".env"
    if not env_path.exists():
        return
    if load_dotenv:
        load_dotenv(env_path, override=True)
    if not dotenv_values:
        return
    values = dotenv_values(env_path)
    desired_project = values.get("GEE_PROJECT_ID") or values.get("PROJECT_ID")
    if desired_project:
        os.environ["GEE_PROJECT_ID"] = desired_project
        os.environ["PROJECT_ID"] = desired_project
    for key in ["GOOGLE_APPLICATION_CREDENTIALS", "EE_PRIVATE_KEY_FILE", "EE_ACCOUNT"]:
        if values.get(key):
            os.environ[key] = values[key]


class _TileProxyHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self) -> None:  # pragma: no cover - runtime path
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:  # pragma: no cover - runtime path
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) != 5 or parts[0] != "ee-tiles":
            self.send_response(404, "Unknown tile path")
            self._send_cors_headers()
            self.end_headers()
            return
        _, layer_id, z_value, x_value, y_value = parts
        fetcher = getattr(self.server, "tile_registry", {}).get(layer_id)
        if fetcher is None:
            self.send_response(404, "Unknown layer id")
            self._send_cors_headers()
            self.end_headers()
            return
        try:
            tile_bytes = fetcher.fetch_tile(int(x_value), int(y_value), int(z_value))
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(tile_bytes)
        except ConnectionAbortedError:
            return
        except Exception as exc:
            error_text = str(exc).encode("ascii", errors="ignore").decode("ascii") or exc.__class__.__name__
            try:
                body = json.dumps({"error": "Tile fetch failed", "detail": error_text}).encode("utf-8")
                self.send_response(500, "Tile fetch failed")
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except ConnectionAbortedError:
                return

    def log_message(self, format: str, *args: Any) -> None:
        return


class TileProxyServer:
    _instance: Optional["TileProxyServer"] = None

    def __init__(self) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _TileProxyHandler)
        self._server.tile_registry = {}
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        self.base_url = f"http://127.0.0.1:{self._server.server_address[1]}"

    @classmethod
    def get_instance(cls) -> "TileProxyServer":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def register(self, layer_id: str, fetcher: Any) -> str:
        self._server.tile_registry[layer_id] = fetcher
        return f"{self.base_url}/ee-tiles/{layer_id}/{{z}}/{{x}}/{{y}}"


class GEETileService:
    def __init__(self, project_root: Path):
        self.project_root = project_root
        _bootstrap_env(self.project_root)
        self.project_id_source = "unset"
        if os.getenv("GEE_PROJECT_ID"):
            self.project_id = os.getenv("GEE_PROJECT_ID")
            self.project_id_source = "env:GEE_PROJECT_ID"
        elif os.getenv("PROJECT_ID"):
            self.project_id = os.getenv("PROJECT_ID")
            self.project_id_source = "env:PROJECT_ID"
        else:
            self.project_id = None
        self.credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        self.legacy_private_key_path = os.getenv("EE_PRIVATE_KEY_FILE")
        self.ee_account = os.getenv("EE_ACCOUNT")
        self.proxy = TileProxyServer.get_instance()
        self.initialized = False
        self.init_error: Optional[str] = None
        self.auth_summary: Dict[str, Any] = {
            "mode": "uninitialized",
            "project_id": self.project_id,
            "project_id_source": self.project_id_source,
            "account": self.ee_account,
            "credentials_path": self.credentials_path or self.legacy_private_key_path,
            "tile_proxy_base_url": self.proxy.base_url,
        }

    def initialize(self) -> None:
        if self.initialized:
            return
        try:
            credential_file = self._resolve_credentials_path()
            if self.project_id is None and credential_file is not None:
                inferred_project = self._resolve_service_account_project_id(credential_file)
                if inferred_project:
                    self.project_id = inferred_project
                    self.project_id_source = "service_account_json.project_id"
            if credential_file is not None:
                email = self._resolve_service_account_email(credential_file)
                credentials = ee.ServiceAccountCredentials(email=email, key_file=str(credential_file))
                ee.Initialize(credentials, project=self.project_id)
                self.auth_summary = {
                    "mode": "service_account",
                    "project_id": self.project_id,
                    "project_id_source": self.project_id_source,
                    "account": email,
                    "credentials_path": str(credential_file),
                    "tile_proxy_base_url": self.proxy.base_url,
                }
            else:
                ee.Initialize(project=self.project_id)
                self.auth_summary = {
                    "mode": "default_credentials",
                    "project_id": self.project_id,
                    "project_id_source": self.project_id_source,
                    "account": None,
                    "credentials_path": None,
                    "tile_proxy_base_url": self.proxy.base_url,
                }
            self.initialized = True
        except Exception as exc:  # pragma: no cover - external auth
            self.init_error = str(exc)
            self.auth_summary = {
                "mode": "failed",
                "project_id": self.project_id,
                "project_id_source": self.project_id_source,
                "account": self.ee_account,
                "credentials_path": self.credentials_path or self.legacy_private_key_path,
                "tile_proxy_base_url": self.proxy.base_url,
                "error": str(exc),
            }

    def _resolve_credentials_path(self) -> Optional[Path]:
        for raw_path in [self.legacy_private_key_path, self.credentials_path]:
            if not raw_path:
                continue
            path = Path(raw_path)
            if path.is_absolute() and path.exists():
                return path
            candidate = (self.project_root / path).resolve()
            if candidate.exists():
                return candidate
            if path.exists():
                return path.resolve()
        return None

    def _resolve_service_account_email(self, credential_file: Path) -> str:
        if self.ee_account:
            return self.ee_account
        payload = json.loads(credential_file.read_text(encoding="utf-8"))
        email = payload.get("client_email")
        if not email:
            raise ValueError(
                "Service account JSON is missing client_email. Set EE_ACCOUNT or provide a valid service account file."
            )
        return email

    def _resolve_service_account_project_id(self, credential_file: Path) -> Optional[str]:
        payload = json.loads(credential_file.read_text(encoding="utf-8"))
        return payload.get("project_id")

    def geocode_location(self, location: str) -> Optional[Dict[str, Any]]:
        response = requests.get(
            "https://nominatim.openstreetmap.org/search",
            headers={"User-Agent": "SatGPT-Water-Asset-Agent/0.1"},
            params={"q": location, "format": "jsonv2", "limit": 1},
            timeout=20,
        )
        response.raise_for_status()
        items = response.json()
        if not items:
            return None
        item = items[0]
        south, north, west, east = map(float, item["boundingbox"])
        return {
            "location": item.get("display_name", location),
            "center": ((south + north) / 2, (west + east) / 2),
            "bounds": {"south": south, "north": north, "west": west, "east": east},
        }

    def get_asset_tile_url(
        self,
        asset: AssetRecord,
        location_hint: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> Dict[str, Any]:
        self.initialize()
        if not self.initialized:
            raise RuntimeError(self.init_error or "Earth Engine initialization failed")

        region_info = self.geocode_location(location_hint) if location_hint else None
        bounds = region_info["bounds"] if region_info else None
        center = self._resolve_map_center(asset, region_info)
        region = self._bounds_to_geometry(bounds) if bounds else None
        layer_id = re.sub(r"[^a-zA-Z0-9_-]", "-", asset.slug.lower())

        validator_notes: List[str] = []
        if asset.asset_type == "FeatureCollection":
            collection = ee.FeatureCollection(asset.asset_id)
            if region is not None:
                collection = collection.filterBounds(region)
            style = (
                asset.official_example_vis.get("style")
                or asset.default_vis_params.get("style", {})
            )
            image = collection.style(
                color=style.get("color", "#00bcd4"),
                fillColor=style.get("fillColor", "00000000"),
                width=style.get("width", 2),
            )
            map_id = image.getMapId({})
            vis_used = {"style": style}
            available_bands: List[str] = []
            vis_recipe_source = "vector_style"
            collection_strategy = "feature_collection"
            collection_filter_notes: List[str] = []
        else:
            image, collection_strategy, collection_filter_notes = self._prepare_image(asset, region, start_date, end_date)
            available_bands = image.bandNames().getInfo()
            vis_used, vis_recipe_source, validator_notes = self._derive_vis_params(asset, available_bands)
            map_id = image.getMapId(vis_used)

        proxy_tile_url = self.proxy.register(layer_id, map_id["tile_fetcher"])
        earth_engine_tile_url = map_id["tile_fetcher"].url_format
        browser_tile_url = earth_engine_tile_url
        sample_zoom = int(asset.default_map_view.get("zoom", 6) or 6)
        sample_x, sample_y = lon_lat_to_tile(center[1], center[0], sample_zoom)

        return {
            "layer_id": layer_id,
            "asset_id": asset.asset_id,
            "asset_type": asset.asset_type,
            "title": asset.title,
            "browser_tile_url": browser_tile_url,
            "proxy_tile_url": proxy_tile_url,
            "earth_engine_tile_url": earth_engine_tile_url,
            "sample_browser_tile_url": resolve_tile_template(browser_tile_url, sample_x, sample_y, sample_zoom),
            "sample_proxy_tile_url": resolve_tile_template(proxy_tile_url, sample_x, sample_y, sample_zoom),
            "sample_earth_engine_tile_url": resolve_tile_template(earth_engine_tile_url, sample_x, sample_y, sample_zoom),
            "sample_zoom": sample_zoom,
            "sample_x": sample_x,
            "sample_y": sample_y,
            "center": center,
            "bounds": bounds,
            "vis_params_used": vis_used,
            "vis_recipe_source": vis_recipe_source,
            "validator_notes": validator_notes,
            "collection_strategy": collection_strategy,
            "collection_filter_notes": collection_filter_notes,
            "available_bands": available_bands,
            "official_example_vis": asset.official_example_vis,
            "tile_loading_mode": "proxy_tiles",
            "official_url": asset.official_url,
        }

    def build_layer(
        self,
        asset: AssetRecord,
        location_hint: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.get_asset_tile_url(
            asset=asset,
            location_hint=location_hint,
            start_date=start_date,
            end_date=end_date,
        )

    def _resolve_map_center(
        self, asset: AssetRecord, region_info: Optional[Dict[str, Any]]
    ) -> Tuple[float, float]:
        if region_info:
            return region_info["center"]
        if asset.default_map_view.get("lat") is not None and asset.default_map_view.get("lon") is not None:
            return (float(asset.default_map_view["lat"]), float(asset.default_map_view["lon"]))
        return (20.0, 0.0)

    def _prepare_image(
        self,
        asset: AssetRecord,
        region: Optional[ee.Geometry],
        start_date: Optional[str],
        end_date: Optional[str],
    ) -> Tuple[ee.Image, str, List[str]]:
        if asset.asset_type == "Image":
            image = ee.Image(asset.asset_id)
            return (image.clip(region) if region is not None else image, "single_image", [])

        filter_candidates = self._collection_filter_candidates(region, start_date, end_date)
        selected_collection: Optional[ee.ImageCollection] = None
        selected_strategy = "unfiltered"
        filter_notes: List[str] = []
        tried_labels: List[str] = []
        for label, use_region, date_mode in filter_candidates:
            collection = ee.ImageCollection(asset.asset_id)
            notes: List[str] = []
            if use_region and region is not None:
                collection = collection.filterBounds(region)
                notes.append("filter_bounds_applied")
            if date_mode == "between" and start_date and end_date:
                collection = collection.filterDate(start_date, end_date)
                notes.append("filter_date_between_applied")
            elif date_mode == "open_end" and start_date:
                open_end = ee.Date(start_date).advance(5, "year").format("YYYY-MM-dd").getInfo()
                collection = collection.filterDate(start_date, open_end)
                notes.append("filter_date_open_end_applied")
            elif date_mode == "single_day_window" and start_date:
                next_day = ee.Date(start_date).advance(1, "day").format("YYYY-MM-dd").getInfo()
                collection = collection.filterDate(start_date, next_day)
                notes.append("filter_date_single_day_window_applied")

            tried_labels.append(label)
            if int(collection.size().getInfo()) > 0:
                selected_collection = collection
                selected_strategy = label
                filter_notes = notes
                if label != "region_and_date":
                    filter_notes.append(f"fallback_strategy:{label}")
                break

        if selected_collection is None:
            raise ValueError(
                f"No imagery found after applying filters for {asset.asset_id}. tried={', '.join(tried_labels)}"
            )

        reducer = (asset.collection_processing_hints or {}).get("reducer", "median")
        if reducer == "mosaic":
            image = selected_collection.sort("system:time_start", False).mosaic()
        elif reducer == "mean":
            image = selected_collection.mean()
        elif reducer == "first":
            image = ee.Image(selected_collection.sort("system:time_start", False).first())
        elif reducer == "max":
            image = selected_collection.max()
        elif reducer == "min":
            image = selected_collection.min()
        elif reducer == "sum":
            image = selected_collection.sum()
        else:
            image = selected_collection.sort("system:time_start", False).median()
        return (image.clip(region) if region is not None else image, selected_strategy, filter_notes)

    @staticmethod
    def _collection_filter_candidates(
        region: Optional[ee.Geometry],
        start_date: Optional[str],
        end_date: Optional[str],
    ) -> List[Tuple[str, bool, str]]:
        candidates: List[Tuple[str, bool, str]] = []
        has_region = region is not None
        has_start = bool(start_date)
        has_end = bool(end_date)

        if has_region and has_start and has_end:
            candidates.extend(
                [
                    ("region_and_date", True, "between"),
                    ("region_and_open_end_date", True, "open_end"),
                    ("region_only", True, "none"),
                    ("date_only", False, "between"),
                    ("open_end_date_only", False, "open_end"),
                    ("unfiltered", False, "none"),
                ]
            )
        elif has_region and has_start:
            candidates.extend(
                [
                    ("region_and_single_day_window", True, "single_day_window"),
                    ("region_and_open_end_date", True, "open_end"),
                    ("region_only", True, "none"),
                    ("open_end_date_only", False, "open_end"),
                    ("unfiltered", False, "none"),
                ]
            )
        elif has_region:
            candidates.extend([("region_only", True, "none"), ("unfiltered", False, "none")])
        elif has_start and has_end:
            candidates.extend(
                [
                    ("date_only", False, "between"),
                    ("open_end_date_only", False, "open_end"),
                    ("unfiltered", False, "none"),
                ]
            )
        elif has_start:
            candidates.extend(
                [
                    ("single_day_window_only", False, "single_day_window"),
                    ("open_end_date_only", False, "open_end"),
                    ("unfiltered", False, "none"),
                ]
            )
        else:
            candidates.append(("unfiltered", False, "none"))

        seen: set[Tuple[str, bool, str]] = set()
        ordered: List[Tuple[str, bool, str]] = []
        for candidate in candidates:
            if candidate in seen:
                continue
            seen.add(candidate)
            ordered.append(candidate)
        return ordered

    @staticmethod
    def _bounds_to_geometry(bounds: Dict[str, float]) -> ee.Geometry:
        return ee.Geometry.Rectangle([bounds["west"], bounds["south"], bounds["east"], bounds["north"]])

    def _derive_vis_params(self, asset: AssetRecord, band_names: List[str]) -> Tuple[Dict[str, Any], str, List[str]]:
        validator_notes: List[str] = []
        recipe_source = "fallback"

        if asset.official_example_vis:
            candidate = dict(asset.official_example_vis)
            recipe_source = "official_example"
        elif asset.default_vis_params:
            candidate = dict(asset.default_vis_params)
            recipe_source = "catalog_default"
        else:
            candidate = {}

        vis = self._normalize_vis_params(candidate, band_names, asset.band_metadata, validator_notes)
        if vis:
            return vis, recipe_source, validator_notes

        fallback = self._fallback_vis_params(band_names, asset.band_metadata, validator_notes)
        return fallback, "dynamic_fallback", validator_notes

    def _normalize_vis_params(
        self,
        candidate: Dict[str, Any],
        band_names: List[str],
        band_metadata: List[Dict[str, Any]],
        validator_notes: List[str],
    ) -> Dict[str, Any]:
        vis = dict(candidate)
        vis.pop("style", None)

        raw_bands = vis.get("bands")
        if isinstance(raw_bands, str):
            bands = [raw_bands]
        elif isinstance(raw_bands, list):
            bands = [str(item) for item in raw_bands]
        else:
            bands = []

        bands = [band for band in bands if band in band_names]
        if raw_bands and not bands:
            validator_notes.append("recipe_bands_not_found_replaced")

        palette = vis.get("palette")
        if isinstance(palette, str):
            palette = [item.strip() for item in palette.split(",") if item.strip()] or [palette]
        if not bands and palette:
            bands = self._prefer_single_band(band_names, band_metadata)
            if bands:
                validator_notes.append("palette_requires_single_band_auto_selected")

        if not bands and len(band_names) == 1:
            bands = [band_names[0]]
        elif not bands and len(band_names) >= 3 and not palette:
            bands = band_names[:3]
        elif not bands and band_names:
            bands = [band_names[0]]

        normalized: Dict[str, Any] = {"bands": bands}
        if "min" in vis:
            normalized["min"] = vis["min"]
        if "max" in vis:
            normalized["max"] = vis["max"]
        if palette:
            normalized["palette"] = palette
        if "gamma" in vis:
            normalized["gamma"] = vis["gamma"]

        if "min" not in normalized or "max" not in normalized:
            min_max = self._infer_min_max(bands, band_metadata)
            normalized.setdefault("min", min_max[0])
            normalized.setdefault("max", min_max[1])
        return normalized

    def _fallback_vis_params(
        self,
        band_names: List[str],
        band_metadata: List[Dict[str, Any]],
        validator_notes: List[str],
    ) -> Dict[str, Any]:
        if not band_names:
            return {}
        if len(band_names) >= 3:
            bands = band_names[:3]
        else:
            bands = [band_names[0]]
        min_value, max_value = self._infer_min_max(bands, band_metadata)
        if len(bands) == 1:
            validator_notes.append("single_band_fallback")
        else:
            validator_notes.append("rgb_fallback")
        return {"bands": bands, "min": min_value, "max": max_value}

    @staticmethod
    def _prefer_single_band(band_names: List[str], band_metadata: List[Dict[str, Any]]) -> List[str]:
        preferred_tokens = ["water", "extent", "class", "occurrence", "recurrence", "seasonality", "change"]
        metadata_map = {item.get("id"): item for item in band_metadata if item.get("id")}
        for token in preferred_tokens:
            for band in band_names:
                metadata = metadata_map.get(band, {})
                text = " ".join(
                    [
                        str(band).lower(),
                        str(metadata.get("description", "")).lower(),
                        str(metadata.get("gee_type", "")).lower(),
                    ]
                )
                if token in text:
                    return [band]
        return [band_names[0]] if band_names else []

    @staticmethod
    def _infer_min_max(bands: List[str], band_metadata: List[Dict[str, Any]]) -> Tuple[float, float]:
        metadata_map = {item.get("id"): item for item in band_metadata if item.get("id")}
        mins: List[float] = []
        maxs: List[float] = []
        for band in bands:
            metadata = metadata_map.get(band, {})
            band_min = metadata.get("min")
            band_max = metadata.get("max")
            if isinstance(band_min, (int, float)):
                mins.append(float(band_min))
            if isinstance(band_max, (int, float)):
                maxs.append(float(band_max))
        if mins and maxs:
            return (min(mins), max(maxs))

        joined = " ".join(bands).lower()
        if any(token in joined for token in ["water", "class", "occurrence", "recurrence", "seasonality", "change"]):
            return (0.0, 1.0)
        if any(token in joined for token in ["vv", "vh", "hh", "hv", "backscatter"]):
            return (-25.0, 5.0)
        return (0.0, 3000.0)

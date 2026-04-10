from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class AssetRecord:
    slug: str
    title: str
    asset_id: str
    asset_type: str
    summary: str
    official_url: str
    themes: List[str]
    spatial_scope: str
    temporal_type: str
    query_keywords: List[str]
    default_vis_params: Dict[str, Any]
    constraints: List[str]
    priority: int
    status: str = "active"
    band_metadata: List[Dict[str, Any]] = field(default_factory=list)
    official_example_code: str = ""
    official_example_vis: Dict[str, Any] = field(default_factory=dict)
    default_map_view: Dict[str, Any] = field(default_factory=dict)
    collection_processing_hints: Dict[str, Any] = field(default_factory=dict)
    notes: str = ""


class WaterAssetCatalog:
    def __init__(
        self,
        project_root: Optional[Path] = None,
        manifest_path: Optional[Path] = None,
        cache_path: Optional[Path] = None,
    ) -> None:
        self.project_root = (project_root or Path(__file__).resolve().parents[1]).resolve()
        self.manifest_path = manifest_path or self.project_root / "agent" / "config" / "water_asset_manifest.json"
        self.cache_path = (
            cache_path
            or self.project_root / "experiments" / "water_asset_agent" / "cache" / "water_asset_catalog.json"
        )
        self._assets: Optional[List[AssetRecord]] = None

    def load(self) -> List[AssetRecord]:
        if self._assets is not None:
            return self._assets

        manifest_payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        manifest_assets = {
            item["asset_id"]: item
            for item in manifest_payload.get("assets", [])
            if item.get("enabled")
        }

        source_payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
        source_assets = source_payload.get("assets", [])

        curated_assets: List[AssetRecord] = []
        for source_asset in source_assets:
            asset_id = source_asset.get("asset_id")
            manifest_item = manifest_assets.get(asset_id)
            if manifest_item is None:
                continue

            merged_themes = list(manifest_item.get("themes") or source_asset.get("themes") or [])
            merged_keywords = list(
                dict.fromkeys(
                    [*manifest_item.get("keywords", []), *source_asset.get("query_keywords", [])]
                )
            )
            summary = manifest_item.get("summary") or source_asset.get("summary", "")
            notes = manifest_item.get("notes", "")
            constraints = list(source_asset.get("constraints") or [])
            if notes:
                constraints = [*constraints, notes]
            merged_example_vis = self._merge_example_vis(
                source_asset.get("official_example_vis") or {},
                self._extract_vis_from_example_code(source_asset.get("official_example_code", "")),
            )

            curated_assets.append(
                AssetRecord(
                    slug=source_asset.get("slug", asset_id.replace("/", "_")),
                    title=manifest_item.get("title") or source_asset.get("title") or asset_id,
                    asset_id=asset_id,
                    asset_type=source_asset.get("asset_type", "Image"),
                    summary=summary,
                    official_url=source_asset.get("official_url", ""),
                    themes=merged_themes,
                    spatial_scope=source_asset.get("spatial_scope", "global"),
                    temporal_type=source_asset.get("temporal_type", "static"),
                    query_keywords=merged_keywords,
                    default_vis_params=source_asset.get("default_vis_params") or {},
                    constraints=constraints,
                    priority=int(manifest_item.get("priority", source_asset.get("priority", 1) or 1)),
                    status="active",
                    band_metadata=source_asset.get("band_metadata") or [],
                    official_example_code=source_asset.get("official_example_code", ""),
                    official_example_vis=merged_example_vis,
                    default_map_view=source_asset.get("default_map_view") or {},
                    collection_processing_hints=source_asset.get("collection_processing_hints") or {},
                    notes=notes,
                )
            )

        curated_assets.sort(key=lambda item: (-item.priority, item.title.lower()))
        self._assets = curated_assets
        return curated_assets

    @staticmethod
    def _merge_example_vis(
        primary: Dict[str, Any],
        fallback: Dict[str, Any],
    ) -> Dict[str, Any]:
        merged = dict(fallback or {})
        merged.update(primary or {})
        return merged

    @classmethod
    def _extract_vis_from_example_code(cls, code: str) -> Dict[str, Any]:
        if not code:
            return {}

        stripped = cls._strip_js_comments(code)
        named_object = (
            cls._extract_named_object(stripped, "visualization")
            or cls._extract_named_object(stripped, "visParams")
            or cls._extract_named_object(stripped, "vis")
        )
        inline_object = cls._extract_first_map_layer_object(stripped)
        result = dict(named_object or inline_object or {})

        selected_band = cls._extract_selected_band(stripped)
        if selected_band and "bands" not in result:
            result["bands"] = [selected_band]

        if "palette" in result and isinstance(result["palette"], str):
            palette_text = result["palette"].strip()
            if "," in palette_text:
                result["palette"] = [item.strip() for item in palette_text.split(",") if item.strip()]
            else:
                result["palette"] = [palette_text]

        if "strokeWidth" in result or "color" in result or "fillColor" in result:
            result["style"] = {
                "color": result.get("color", "#808080"),
                "width": result.get("strokeWidth", result.get("width", 1)),
                "fillColor": result.get("fillColor", "00000000"),
            }

        return result

    @staticmethod
    def _strip_js_comments(code: str) -> str:
        code = re.sub(r"//.*?$", "", code, flags=re.MULTILINE)
        code = re.sub(r"/\*.*?\*/", "", code, flags=re.DOTALL)
        return code

    @classmethod
    def _extract_named_object(cls, code: str, name: str) -> Dict[str, Any]:
        pattern = rf"(?:var|let|const)\s+{re.escape(name)}\s*=\s*\{{(?P<body>.*?)\}};"
        match = re.search(pattern, code, flags=re.DOTALL)
        if not match:
            return {}
        return cls._parse_js_object(match.group("body"))

    @classmethod
    def _extract_first_map_layer_object(cls, code: str) -> Dict[str, Any]:
        pattern = r"Map\.addLayer\([\s\S]*?,\s*\{(?P<body>.*?)\}\s*,"
        match = re.search(pattern, code, flags=re.DOTALL)
        if not match:
            return {}
        return cls._parse_js_object(match.group("body"))

    @staticmethod
    def _extract_selected_band(code: str) -> Optional[str]:
        match = re.search(r"\.select\(\s*['\"]([^'\"]+)['\"]\s*\)", code)
        if match:
            return match.group(1)
        return None

    @staticmethod
    def _parse_js_object(body: str) -> Dict[str, Any]:
        wrapped = "{%s}" % body
        wrapped = wrapped.replace("'", '"')
        wrapped = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', wrapped)
        wrapped = re.sub(r",(\s*[}\]])", r"\1", wrapped)
        try:
            return json.loads(wrapped)
        except json.JSONDecodeError:
            return {}

    def get_by_ids(self, asset_ids: List[str]) -> List[AssetRecord]:
        asset_map = {asset.asset_id: asset for asset in self.load()}
        return [asset_map[asset_id] for asset_id in asset_ids if asset_id in asset_map]

    @staticmethod
    def serialize(asset: AssetRecord, score: Optional[float] = None) -> Dict[str, Any]:
        payload = {
            "asset_id": asset.asset_id,
            "slug": asset.slug,
            "title": asset.title,
            "asset_type": asset.asset_type,
            "summary": asset.summary,
            "official_url": asset.official_url,
            "themes": asset.themes,
            "temporal_type": asset.temporal_type,
            "spatial_scope": asset.spatial_scope,
            "priority": asset.priority,
            "notes": asset.notes,
            "keywords": asset.query_keywords[:12],
        }
        if score is not None:
            payload["score"] = round(score, 3)
        return payload

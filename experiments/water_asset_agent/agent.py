from __future__ import annotations

import json
import os
import re
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    import tiktoken
except ImportError:  # pragma: no cover
    tiktoken = None

try:
    from dotenv import dotenv_values, load_dotenv
except ImportError:  # pragma: no cover
    dotenv_values = None
    load_dotenv = None

import requests

from .catalog import AssetRecord, WaterAssetCatalogBuilder
from .tile_service import GEETileService


@dataclass
class StructuredQuery:
    raw_question: str
    need_visualization: bool
    intent: str
    themes: List[str]
    location_hint: Optional[str]
    start_date: Optional[str]
    end_date: Optional[str]
    answer: str
    used_llm: bool


@dataclass
class TokenUsage:
    stage: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    source: str
    note: str


@dataclass
class PrototypeResult:
    structured_query: StructuredQuery
    candidates: List[AssetRecord]
    selected_assets: List[AssetRecord]
    rendered_layers: List[Dict[str, Any]]
    gee_auth: Dict[str, Any]
    token_usage: List[TokenUsage]
    map_error: Optional[str]


def _discover_project_root(start_path: Optional[Path] = None) -> Path:
    current = (start_path or Path.cwd()).resolve()
    for candidate in [current, *current.parents]:
        if (candidate / ".env.example").exists() or (candidate / ".git").exists():
            return candidate
    return current


def _load_env(project_root: Path) -> None:
    env_path = project_root / ".env"
    if not env_path.exists():
        return
    if load_dotenv:
        load_dotenv(env_path, override=True)
    if not dotenv_values:
        return

    values = dotenv_values(env_path)
    desired_project = values.get("GEE_PROJECT_ID")
    if desired_project:
        os.environ["GEE_PROJECT_ID"] = desired_project
    for key in ["GOOGLE_APPLICATION_CREDENTIALS"]:
        if values.get(key):
            os.environ[key] = values[key]


def _normalize_api_base(base_url: Optional[str]) -> str:
    base = (base_url or "https://api.openai.com/v1").rstrip("/")
    return base if base.endswith("/v1") else f"{base}/v1"


def _token_count(text: str, model: Optional[str]) -> int:
    if tiktoken is None:
        return 0
    try:
        encoding = tiktoken.encoding_for_model(model or "gpt-4o-mini")
    except KeyError:
        encoding = tiktoken.get_encoding("cl100k_base")
    return len(encoding.encode(text or ""))


def _extract_json(text: str) -> Dict[str, Any]:
    cleaned = text.strip()
    if "```json" in cleaned:
        cleaned = cleaned.split("```json", 1)[1].split("```", 1)[0]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found")
    return json.loads(cleaned[start : end + 1])


class WaterAssetAgentSystem:
    def __init__(self, project_root: Optional[Path] = None):
        self.project_root = _discover_project_root(project_root)
        _load_env(self.project_root)
        self.prototype_root = self.project_root / "experiments" / "water_asset_agent"
        self.catalog_builder = WaterAssetCatalogBuilder(self.prototype_root / "cache" / "water_asset_catalog.json")
        self.tile_service = GEETileService(self.project_root)
        self.model = os.getenv("LLM_MODEL", "gpt-4o-mini")
        self.api_key = os.getenv("OPENAI_API_KEY")
        self.api_base = _normalize_api_base(os.getenv("OPENAI_API_BASE"))
        self._last_map = None

    @property
    def last_map(self):
        return self._last_map

    def build_catalog(self, force_refresh: bool = False) -> List[AssetRecord]:
        return self.catalog_builder.load(force_refresh=force_refresh)

    def ask(self, question: str, force_refresh_catalog: bool = False) -> PrototypeResult:
        assets = self.build_catalog(force_refresh=force_refresh_catalog)
        structured_query, token_usage = self._parse_query(question)
        candidates = self._rank_assets(structured_query, assets, top_k=12)
        selected_assets = self._select_assets(structured_query, candidates, top_k=3)
        rendered_layers: List[Dict[str, Any]] = []
        map_error: Optional[str] = None

        if structured_query.need_visualization and selected_assets:
            try:
                rendered_layers = [
                    self.tile_service.get_asset_tile_url(
                        asset=asset,
                        location_hint=structured_query.location_hint,
                        start_date=structured_query.start_date,
                        end_date=structured_query.end_date,
                    )
                    for asset in selected_assets
                ]
                self._last_map = self.tile_service.build_map(rendered_layers)
            except Exception as exc:
                map_error = str(exc)
                self._last_map = None
        else:
            self._last_map = None

        token_usage.extend(
            [
                TokenUsage(
                    stage="asset_rank",
                    prompt_tokens=0,
                    completion_tokens=0,
                    total_tokens=0,
                    source="none",
                    note="根据结构化资产表做规则排序，不使用额外 LLM。",
                ),
                TokenUsage(
                    stage="tile_build",
                    prompt_tokens=0,
                    completion_tokens=0,
                    total_tokens=0,
                    source="none",
                    note="GEE tile URL 构建与地图渲染不经过 LLM。",
                ),
            ]
        )

        return PrototypeResult(
            structured_query=structured_query,
            candidates=candidates,
            selected_assets=selected_assets,
            rendered_layers=rendered_layers,
            gee_auth=self.tile_service.auth_summary,
            token_usage=token_usage,
            map_error=map_error,
        )

    def _parse_query(self, question: str) -> Tuple[StructuredQuery, List[TokenUsage]]:
        heuristic = self._heuristic_parse(question)
        if not self.api_key:
            return heuristic, [
                TokenUsage(
                    stage="query_parse",
                    prompt_tokens=_token_count(question, self.model),
                    completion_tokens=0,
                    total_tokens=_token_count(question, self.model),
                    source="tiktoken_estimate" if tiktoken is not None else "unavailable",
                    note="未配置 LLM，使用本地启发式解析。",
                )
            ]

        system_prompt = textwrap.dedent(
            """
            你是一个简化的 water 数据选图助手。
            只需要把用户问题转成严格 JSON：
            {
              "need_visualization": true,
              "intent": "visualize|compare|explain|discover",
              "themes": ["flood", "surface_water"],
              "location_hint": "string or null",
              "start_date": "YYYY-MM-DD or null",
              "end_date": "YYYY-MM-DD or null",
              "answer": "简短中文说明"
            }
            不要输出任何额外文本。
            """
        ).strip()
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": question}]
        response = requests.post(
            f"{self.api_base}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json={"model": self.model, "temperature": 0.2, "messages": messages},
            timeout=60,
        )
        response.raise_for_status()
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        data = _extract_json(content)
        usage = payload.get("usage") or {}
        if usage:
            token_usage = [
                TokenUsage(
                    stage="query_parse",
                    prompt_tokens=int(usage.get("prompt_tokens", 0) or 0),
                    completion_tokens=int(usage.get("completion_tokens", 0) or 0),
                    total_tokens=int(usage.get("total_tokens", 0) or 0),
                    source="api_usage",
                    note="来自兼容 Chat Completions 的 usage 字段。",
                )
            ]
        else:
            prompt_tokens = sum(_token_count(message["content"], self.model) for message in messages)
            completion_tokens = _token_count(content, self.model)
            token_usage = [
                TokenUsage(
                    stage="query_parse",
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=prompt_tokens + completion_tokens,
                    source="tiktoken_estimate",
                    note="接口未返回 usage，使用 tiktoken 估算。",
                )
            ]

        structured = StructuredQuery(
            raw_question=question,
            need_visualization=bool(data.get("need_visualization")),
            intent=data.get("intent", "discover"),
            themes=list(data.get("themes", []) or ["surface_water"]),
            location_hint=data.get("location_hint"),
            start_date=data.get("start_date"),
            end_date=data.get("end_date"),
            answer=data.get("answer", ""),
            used_llm=True,
        )
        if heuristic.need_visualization and not structured.need_visualization:
            structured.need_visualization = True
            if structured.intent == "discover":
                structured.intent = "visualize"
            if not structured.themes:
                structured.themes = heuristic.themes
            if not structured.location_hint:
                structured.location_hint = heuristic.location_hint
            structured.answer = structured.answer or "LLM 未明确要求上图，已按启发式规则回退到可视化路径。"
        return structured, token_usage

    def _heuristic_parse(self, question: str) -> StructuredQuery:
        lowered = question.lower()
        need_visualization = any(
            keyword in lowered for keyword in ["map", "layer", "show", "distribution", "洪水", "水体", "上图", "可视化"]
        )
        themes: List[str] = []
        if any(keyword in lowered for keyword in ["flood", "洪水", "inundation"]):
            themes.append("flood")
        if any(keyword in lowered for keyword in ["water", "surface water", "湖", "河", "水体"]):
            themes.append("surface_water")
        if any(keyword in lowered for keyword in ["basin", "watershed", "流域"]):
            themes.append("watershed")
        if not themes:
            themes.append("surface_water")
        location_match = re.search(r"(洞庭湖|鄱阳湖|长江|黄河|Dongting Lake|Poyang Lake)", question, re.IGNORECASE)
        return StructuredQuery(
            raw_question=question,
            need_visualization=need_visualization,
            intent="visualize" if need_visualization else "explain",
            themes=themes,
            location_hint=location_match.group(1) if location_match else None,
            start_date=None,
            end_date=None,
            answer="已使用启发式规则解析查询。",
            used_llm=False,
        )

    def _rank_assets(self, query: StructuredQuery, assets: Sequence[AssetRecord], top_k: int = 12) -> List[AssetRecord]:
        question_tokens = set(re.findall(r"[\w\u4e00-\u9fff]+", query.raw_question.lower()))
        scored: List[Tuple[int, AssetRecord]] = []
        for asset in assets:
            score = 0
            theme_overlap = len(set(query.themes) & set(asset.themes))
            score += theme_overlap * 8
            score += len(question_tokens & set(asset.query_keywords)) * 2
            score += max(0, 10 - asset.priority)
            if "deprecated" in asset.title.lower() or "deprecated" in asset.summary.lower():
                score -= 6
            if query.need_visualization:
                score += 2
                if asset.official_example_vis:
                    score += 3
                if asset.band_metadata:
                    score += 2
            if query.location_hint and asset.spatial_scope == "global":
                score += 1
            if query.intent == "compare" and asset.asset_type == "FeatureCollection":
                score -= 1
            scored.append((score, asset))
        scored.sort(key=lambda item: (-item[0], item[1].title.lower()))
        positive = [asset for score, asset in scored if score > 0]
        return positive[:top_k] if positive else list(assets[: min(top_k, len(assets))])

    def _select_assets(self, query: StructuredQuery, candidates: Sequence[AssetRecord], top_k: int = 3) -> List[AssetRecord]:
        if not query.need_visualization:
            return []
        preferred = [asset for asset in candidates if asset.official_example_vis]
        if len(preferred) >= top_k:
            return preferred[:top_k]
        fallback = preferred + [asset for asset in candidates if asset not in preferred]
        return list(fallback[:top_k])

    def get_inventory_summary(self) -> Dict[str, Any]:
        summary_path = self.prototype_root / "cache" / "water_asset_inventory_summary.json"
        if summary_path.exists():
            return json.loads(summary_path.read_text(encoding="utf-8"))
        assets = self.build_catalog(force_refresh=False)
        return {
            "total_assets": len(assets),
            "assets_with_official_recipe": sum(1 for asset in assets if asset.official_example_vis),
            "assets_with_band_metadata": sum(1 for asset in assets if asset.band_metadata),
        }


def review_question(question: str, force_refresh_catalog: bool = False):
    system = WaterAssetAgentSystem()
    result = system.ask(question=question, force_refresh_catalog=force_refresh_catalog)
    return result, system.last_map

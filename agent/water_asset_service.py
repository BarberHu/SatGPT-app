from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    import tiktoken
except ImportError:  # pragma: no cover
    tiktoken = None

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from gee_tile_service import GEETileService
from water_asset_catalog import AssetRecord, WaterAssetCatalog


PROJECT_ROOT = Path(__file__).resolve().parents[1]


MODEL_PRICING_USD_PER_MILLION = {
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-4.1-mini": {"input": 0.40, "output": 1.60},
}


@dataclass
class TokenUsageEntry:
    stage: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    estimated_cost_usd: float
    source: str
    note: str


@dataclass
class ParsedAssetQuery:
    raw_question: str
    answer: str
    agent_intent: str
    need_visualization: bool
    themes: List[str]
    location: Optional[str]
    start_date: Optional[str]
    end_date: Optional[str]
    coordinates: Optional[List[float]]
    bounds: Optional[Dict[str, float]]
    geojson: Optional[Dict[str, Any]]


def _token_count(text: str, model: str) -> int:
    if tiktoken is None:
        return 0
    try:
        encoding = tiktoken.encoding_for_model(model)
    except KeyError:
        encoding = tiktoken.get_encoding("cl100k_base")
    return len(encoding.encode(text or ""))


def _extract_json(text: str) -> Dict[str, Any]:
    cleaned = (text or "").strip()
    if "```json" in cleaned:
        cleaned = cleaned.split("```json", 1)[1].split("```", 1)[0]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in model output")
    return json.loads(cleaned[start : end + 1])


def _safe_float_pair(values: Any) -> Optional[List[float]]:
    if not isinstance(values, list) or len(values) < 2:
        return None
    try:
        return [float(values[0]), float(values[1])]
    except (TypeError, ValueError):
        return None


def _safe_bounds(value: Any) -> Optional[Dict[str, float]]:
    if not isinstance(value, dict):
        return None
    keys = ["west", "south", "east", "north"]
    try:
        return {key: float(value[key]) for key in keys}
    except (KeyError, TypeError, ValueError):
        return None


def _compute_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    pricing = MODEL_PRICING_USD_PER_MILLION.get(model)
    if not pricing:
        return 0.0
    input_cost = prompt_tokens * pricing["input"] / 1_000_000
    output_cost = completion_tokens * pricing["output"] / 1_000_000
    return round(input_cost + output_cost, 8)


def _usage_entry(
    *,
    stage: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    source: str,
    note: str,
) -> TokenUsageEntry:
    total_tokens = int(prompt_tokens) + int(completion_tokens)
    return TokenUsageEntry(
        stage=stage,
        model=model,
        prompt_tokens=int(prompt_tokens),
        completion_tokens=int(completion_tokens),
        total_tokens=total_tokens,
        estimated_cost_usd=_compute_cost(model, int(prompt_tokens), int(completion_tokens)),
        source=source,
        note=note,
    )


class WaterAssetService:
    def __init__(self, project_root: Optional[Path] = None) -> None:
        self.project_root = (project_root or PROJECT_ROOT).resolve()
        self.catalog = WaterAssetCatalog(project_root=self.project_root)
        self.tile_service = GEETileService(self.project_root)
        self.model_name = os.getenv("LLM_MODEL", "gpt-4o-mini")
        self.api_key = os.getenv("OPENAI_API_KEY", "")
        self.api_base = os.getenv("OPENAI_API_BASE")
        self._model = None
        self._llm_disabled_reason: Optional[str] = None

    @property
    def model(self) -> ChatOpenAI:
        if self._model is None:
            self._model = ChatOpenAI(
                model=self.model_name,
                api_key=self.api_key,
                base_url=self.api_base,
                temperature=0.2,
            )
        return self._model

    async def parse_query(self, question: str) -> Tuple[ParsedAssetQuery, List[TokenUsageEntry]]:
        if not self.api_key or self._llm_disabled_reason:
            return self._heuristic_parse_with_usage(question)

        system_prompt = SystemMessage(
            content=(
                "You are the SatGPT water dataset query parser. "
                "Parse the user question into strict JSON and do not output any extra text. "
                'JSON structure: {"answer": "...", "agent_intent": "discover|compare|visualize|watershed", '
                '"need_visualization": true, "themes": ["surface_water"], '
                '"location": null, "start_date": null, "end_date": null, '
                '"coordinates": null, "bounds": null, "geojson": null}. '
                "The answer field must be a short English sentence. "
                "Keep location as a plain place string and never invent coordinates."
            )
        )
        user_message = HumanMessage(content=question)

        try:
            response = await self.model.ainvoke([system_prompt, user_message])
            parsed_json = _extract_json(str(response.content))
            usage = self._extract_usage(response, [system_prompt.content, question], str(response.content))
            parsed = ParsedAssetQuery(
                raw_question=question,
                answer=parsed_json.get("answer")
                or "I'll recommend the most relevant water datasets first, then let you choose which layers to display.",
                agent_intent=parsed_json.get("agent_intent") or "discover",
                need_visualization=bool(parsed_json.get("need_visualization", True)),
                themes=list(parsed_json.get("themes") or ["surface_water"]),
                location=parsed_json.get("location"),
                start_date=parsed_json.get("start_date"),
                end_date=parsed_json.get("end_date"),
                coordinates=_safe_float_pair(parsed_json.get("coordinates")),
                bounds=_safe_bounds(parsed_json.get("bounds")),
                geojson=parsed_json.get("geojson") if isinstance(parsed_json.get("geojson"), dict) else None,
            )
            return parsed, [
                _usage_entry(
                    stage="asset_parse",
                    model=self.model_name,
                    prompt_tokens=usage["prompt_tokens"],
                    completion_tokens=usage["completion_tokens"],
                    source=usage["source"],
                    note="LLM completed the user intent parsing step.",
                )
            ]
        except Exception as exc:
            error_text = str(exc)
            if "401" in error_text or "Invalid token" in error_text or "AuthenticationError" in exc.__class__.__name__:
                self._llm_disabled_reason = "llm_auth_failed"
                self._model = None
            return self._heuristic_parse_with_usage(
                question,
                note=f"LLM parsing failed, fallback to local heuristic parsing. {error_text[:120]}",
            )

    def recommend_assets(
        self, parsed_query: ParsedAssetQuery, top_k: int = 5
    ) -> Tuple[List[AssetRecord], List[TokenUsageEntry]]:
        assets = self.catalog.load()
        scored_assets = sorted(
            ((self._score_asset(parsed_query, asset), asset) for asset in assets),
            key=lambda item: (-item[0], -item[1].priority, item[1].title.lower()),
        )
        recommended = [asset for score, asset in scored_assets if score > 0][:top_k]
        return recommended, [
            _usage_entry(
                stage="asset_recommend",
                model=self.model_name,
                prompt_tokens=0,
                completion_tokens=0,
                source="rule_based",
                note="Rule-based ranking using the curated manifest, theme matching, keyword hits, and temporal properties.",
            )
        ]

    def render_assets(
        self,
        asset_ids: Sequence[str],
        *,
        location_hint: Optional[str],
        start_date: Optional[str],
        end_date: Optional[str],
    ) -> List[Dict[str, Any]]:
        layers: List[Dict[str, Any]] = []
        for asset in self.catalog.get_by_ids(list(asset_ids)):
            rendered = self.tile_service.get_asset_tile_url(
                asset=asset,
                location_hint=location_hint,
                start_date=start_date,
                end_date=end_date,
            )
            layers.append(
                {
                    "layer_id": rendered.get("layer_id"),
                    "asset_id": rendered.get("asset_id"),
                    "title": rendered.get("title"),
                    "tile_url": rendered.get("proxy_tile_url") or rendered.get("browser_tile_url"),
                    "layer_type": "raster",
                    "vis_params_used": rendered.get("vis_params_used") or {},
                    "official_url": rendered.get("official_url"),
                    "location": rendered.get("location"),
                    "map_center": rendered.get("center"),
                    "map_zoom": rendered.get("sample_zoom"),
                    "bounds": rendered.get("bounds"),
                    "notes": rendered.get("validator_notes") or [],
                }
            )
        return layers

    def summarize_usage(self, entries: Sequence[TokenUsageEntry]) -> Dict[str, Any]:
        prompt_tokens = sum(entry.prompt_tokens for entry in entries)
        completion_tokens = sum(entry.completion_tokens for entry in entries)
        total_tokens = sum(entry.total_tokens for entry in entries)
        total_cost = round(sum(entry.estimated_cost_usd for entry in entries), 8)
        return {
            "model": self.model_name,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "estimated_cost_usd": total_cost,
            "entries": [asdict(entry) for entry in entries],
        }

    def serialize_assets(self, assets: Sequence[AssetRecord], parsed_query: ParsedAssetQuery) -> List[Dict[str, Any]]:
        return [self.catalog.serialize(asset, score=self._score_asset(parsed_query, asset)) for asset in assets]

    def build_usage_log(
        self,
        *,
        thread_id: Optional[str],
        agent_intent: str,
        usage_entries: Sequence[TokenUsageEntry],
    ) -> Dict[str, Any]:
        summary = self.summarize_usage(usage_entries)
        return {
            "thread_id": thread_id,
            "agent_intent": agent_intent,
            "model": summary["model"],
            "prompt_tokens": summary["prompt_tokens"],
            "completion_tokens": summary["completion_tokens"],
            "total_tokens": summary["total_tokens"],
            "estimated_cost_usd": summary["estimated_cost_usd"],
            "stages": summary["entries"],
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }

    def _heuristic_parse_with_usage(
        self,
        question: str,
        note: Optional[str] = None,
    ) -> Tuple[ParsedAssetQuery, List[TokenUsageEntry]]:
        parsed = self._heuristic_parse(question)
        prompt_tokens = _token_count(question, self.model_name)
        return parsed, [
            _usage_entry(
                stage="asset_parse",
                model=self.model_name,
                prompt_tokens=prompt_tokens,
                completion_tokens=0,
                source="heuristic",
                note=note or "No available LLM configuration. Local heuristic parsing was used instead.",
            )
        ]

    def _heuristic_parse(self, question: str) -> ParsedAssetQuery:
        lowered = question.lower()
        themes: List[str] = []
        if any(keyword in lowered for keyword in ["flood", "洪水", "积水", "淹没", "inundation"]):
            themes.append("flood")
        if any(keyword in lowered for keyword in ["watershed", "basin", "流域", "huc"]):
            themes.append("watershed")
        if not themes:
            themes.append("surface_water")

        date_matches = re.findall(r"\d{4}-\d{2}-\d{2}", question)
        location_match = re.search(r"(?:in|at|around|near|在|位于)([^,，。]{2,40})", question, flags=re.IGNORECASE)
        location = location_match.group(1).strip() if location_match else None

        return ParsedAssetQuery(
            raw_question=question,
            answer="I'll recommend the most relevant water datasets first, then let you choose which layers to display.",
            agent_intent="watershed" if "watershed" in themes else "visualize",
            need_visualization=True,
            themes=themes,
            location=location,
            start_date=date_matches[0] if date_matches else None,
            end_date=date_matches[1] if len(date_matches) > 1 else None,
            coordinates=None,
            bounds=None,
            geojson=None,
        )

    def _extract_usage(
        self,
        response: Any,
        prompt_parts: Sequence[str],
        response_text: str,
    ) -> Dict[str, Any]:
        usage_metadata = getattr(response, "usage_metadata", None) or {}
        response_metadata = getattr(response, "response_metadata", None) or {}
        token_usage = response_metadata.get("token_usage") or {}

        prompt_tokens = (
            usage_metadata.get("input_tokens")
            or token_usage.get("prompt_tokens")
            or token_usage.get("input_tokens")
        )
        completion_tokens = (
            usage_metadata.get("output_tokens")
            or token_usage.get("completion_tokens")
            or token_usage.get("output_tokens")
        )

        if prompt_tokens is not None and completion_tokens is not None:
            return {
                "prompt_tokens": int(prompt_tokens),
                "completion_tokens": int(completion_tokens),
                "source": "model_usage",
            }

        prompt_tokens = sum(_token_count(part, self.model_name) for part in prompt_parts)
        completion_tokens = _token_count(response_text, self.model_name)
        return {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "source": "tiktoken_estimate" if tiktoken is not None else "unknown",
        }

    def _score_asset(self, parsed_query: ParsedAssetQuery, asset: AssetRecord) -> float:
        score = float(asset.priority)
        question_tokens = set(re.findall(r"[\w\u4e00-\u9fff-]+", parsed_query.raw_question.lower()))
        asset_keywords = {keyword.lower() for keyword in asset.query_keywords}
        theme_set = set(asset.themes)
        requested_themes = set(parsed_query.themes)

        score += 12 * len(theme_set & requested_themes)
        score += 1.5 * len(question_tokens & asset_keywords)

        if "flood" in requested_themes and "flood" in theme_set:
            score += 8
        if "watershed" in requested_themes and "watershed" in theme_set:
            score += 8

        if parsed_query.start_date or parsed_query.end_date:
            if asset.temporal_type in {"time_series", "monthly", "yearly", "daily"}:
                score += 4
            else:
                score -= 2

        if asset.asset_type == "FeatureCollection" and "watershed" not in requested_themes:
            score -= 8
        if asset.asset_type != "FeatureCollection" and "watershed" in requested_themes:
            score -= 3

        if parsed_query.agent_intent == "compare" and asset.temporal_type in {"monthly", "yearly", "time_series"}:
            score += 3

        if parsed_query.location and re.search(r"\b(us|usa|united states|美国)\b", parsed_query.location.lower()):
            if asset.asset_id.startswith("USGS/WBD/2017/HUC"):
                score += 5
        elif asset.asset_id.startswith("USGS/WBD/2017/HUC"):
            score -= 4

        return score

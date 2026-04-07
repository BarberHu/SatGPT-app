from __future__ import annotations

import json
import os
import re
import threading
import textwrap
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from html import unescape
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

import ee
import requests

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional dependency in this prototype
    load_dotenv = None

try:
    import folium
except ImportError:  # pragma: no cover - optional dependency in this prototype
    folium = None

try:
    import tiktoken
except ImportError:  # pragma: no cover - optional dependency in this prototype
    tiktoken = None


OFFICIAL_WATER_TAG_URL = "https://developers.google.com/earth-engine/datasets/tags/water?hl=zh-cn"
OFFICIAL_DATASET_URL_TEMPLATE = "https://developers.google.com/earth-engine/datasets/catalog/{slug}?hl=zh-cn"
USER_AGENT = "SatGPT-Water-Layer-Agent/0.1"


@dataclass
class DatasetInfo:
    slug: str
    title: str
    asset_id: str
    asset_type: str
    summary: str
    url: str


@dataclass
class LayerDecision:
    slug: str
    title: str
    asset_id: str
    asset_type: str
    why: str
    url: str


@dataclass
class AgentPlan:
    need_visualization: bool
    reason: str
    answer: str
    location_hint: Optional[str]
    start_date: Optional[str]
    end_date: Optional[str]
    selected_layers: List[LayerDecision]
    used_llm: bool


@dataclass
class TokenUsageRecord:
    stage: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    source: str
    note: str


@dataclass
class AgentResult:
    question: str
    plan: AgentPlan
    shortlist: List[DatasetInfo]
    map_center: Optional[Tuple[float, float]]
    region_bounds: Optional[Dict[str, float]]
    map_ready: bool
    map_error: Optional[str]
    rendered_layers: List[Dict[str, Any]]
    token_usage: List[TokenUsageRecord]
    gee_auth: Dict[str, Any]


class _TileProxyRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # pragma: no cover - exercised manually in notebook
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) != 5 or parts[0] != "ee-tiles":
            self.send_error(404, "Unknown tile path")
            return

        _, layer_id, z_value, x_value, y_value = parts
        registry = getattr(self.server, "tile_registry", {})
        fetcher = registry.get(layer_id)
        if fetcher is None:
            self.send_error(404, "Unknown layer id")
            return

        try:
            tile_bytes = fetcher.fetch_tile(int(x_value), int(y_value), int(z_value))
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(tile_bytes)
        except Exception as exc:  # pragma: no cover - depends on EE auth/runtime
            self.send_error(500, f"Tile fetch failed: {exc}")

    def log_message(self, format: str, *args: Any) -> None:  # pragma: no cover - noisy in notebook
        return


class TileProxyServer:
    _instance: Optional["TileProxyServer"] = None

    def __init__(self) -> None:
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _TileProxyRequestHandler)
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


def _strip_tags(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", unescape(text)).strip()


def _extract_json(text: str) -> Dict[str, Any]:
    cleaned = text.strip()
    if "```json" in cleaned:
        cleaned = cleaned.split("```json", 1)[1].split("```", 1)[0]
    elif "```" in cleaned:
        cleaned = cleaned.split("```", 1)[1].split("```", 1)[0]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in model response")
    return json.loads(cleaned[start : end + 1])


def _normalize_api_base(base_url: Optional[str]) -> str:
    base = (base_url or "https://api.openai.com/v1").rstrip("/")
    if not base.endswith("/v1"):
        return f"{base}/v1"
    return base


def _discover_project_root(start_path: Optional[Path] = None) -> Path:
    current = (start_path or Path.cwd()).resolve()
    for candidate in [current, *current.parents]:
        if (candidate / ".env.example").exists() or (candidate / ".git").exists():
            return candidate
    return current


def _load_satgpt_env(project_root: Optional[Path] = None) -> Path:
    root = _discover_project_root(project_root)
    env_path = root / ".env"
    if load_dotenv and env_path.exists():
        load_dotenv(env_path, override=False)
    return root


def _http_get(url: str, **kwargs: Any) -> requests.Response:
    headers = kwargs.pop("headers", {})
    merged_headers = {"User-Agent": USER_AGENT, **headers}
    timeout = kwargs.pop("timeout", 30)
    last_error: Optional[Exception] = None
    for attempt in range(3):
        try:
            response = requests.get(url, headers=merged_headers, timeout=timeout, **kwargs)
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(1.0 + attempt)
    raise last_error if last_error else RuntimeError(f"GET failed: {url}")


def _safe_date(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        return None


def _encoding_for_model(model: Optional[str]):
    if tiktoken is None:
        return None
    try:
        return tiktoken.encoding_for_model(model or "gpt-4o-mini")
    except KeyError:
        return tiktoken.get_encoding("cl100k_base")


def _count_text_tokens(text: str, model: Optional[str]) -> int:
    encoding = _encoding_for_model(model)
    if encoding is None:
        return 0
    return len(encoding.encode(text or ""))


def _count_message_tokens(messages: Sequence[Dict[str, str]], model: Optional[str]) -> int:
    return sum(_count_text_tokens(message.get("content", ""), model) for message in messages)


def _extend_end_date(value: str) -> str:
    base = datetime.strptime(value, "%Y-%m-%d")
    return (base + timedelta(days=1)).strftime("%Y-%m-%d")


def _lon_lat_to_tile(lon: float, lat: float, zoom: int) -> Tuple[int, int]:
    lat_rad = math.radians(max(min(lat, 85.05112878), -85.05112878))
    scale = 2 ** zoom
    x_tile = int((lon + 180.0) / 360.0 * scale)
    y_tile = int((1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * scale)
    return x_tile, y_tile


def _resolve_tile_template(url_template: str, x_tile: int, y_tile: int, zoom: int) -> str:
    return (
        (url_template or "")
        .replace("{x}", str(x_tile))
        .replace("{y}", str(y_tile))
        .replace("{z}", str(zoom))
    )


def _tokenize(text: str) -> List[str]:
    lowered = text.lower()
    lowered = lowered.replace("/", " ").replace("-", " ")
    tokens = re.findall(r"[\w\u4e00-\u9fff]+", lowered)
    stopwords = {
        "the",
        "and",
        "for",
        "with",
        "show",
        "what",
        "where",
        "is",
        "are",
        "of",
        "to",
        "帮我",
        "看看",
        "一下",
        "一个",
        "哪些",
        "什么",
        "是否",
        "需要",
        "图层",
        "数据",
    }
    return [token for token in tokens if token not in stopwords and len(token) > 1]


class WaterDatasetCatalog:
    def __init__(self, cache_path: Path):
        self.cache_path = cache_path
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)

    def load(self, force_refresh: bool = False) -> List[DatasetInfo]:
        if not force_refresh and self.cache_path.exists():
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
            return [DatasetInfo(**item) for item in payload.get("datasets", [])]

        datasets = self.refresh()
        payload = {
            "source": OFFICIAL_WATER_TAG_URL,
            "refreshed_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "datasets": [asdict(item) for item in datasets],
        }
        self.cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return datasets

    def refresh(self) -> List[DatasetInfo]:
        html = _http_get(OFFICIAL_WATER_TAG_URL).text
        raw_slugs = re.findall(r"/earth-engine/datasets/catalog/([^\"#?]+)", html)
        seen: set[str] = set()
        datasets: List[DatasetInfo] = []
        for slug in raw_slugs:
            if slug in seen:
                continue
            seen.add(slug)
            info = self._fetch_dataset(slug)
            if info:
                datasets.append(info)
        datasets.sort(key=lambda item: item.title.lower())
        return datasets

    def _fetch_dataset(self, slug: str) -> Optional[DatasetInfo]:
        url = OFFICIAL_DATASET_URL_TEMPLATE.format(slug=slug)
        try:
            html = _http_get(url).text
        except requests.RequestException:
            return None

        match = re.search(
            r"ee\.(ImageCollection|Image|FeatureCollection)\([\"']([^\"']+)[\"']\)",
            html,
        )
        if not match:
            return None

        asset_type, asset_id = match.group(1), match.group(2)

        title_match = re.search(r'<meta property="og:title" content="([^"]+)"', html)
        title = _strip_tags(title_match.group(1)) if title_match else slug

        desc_match = re.search(r'<meta name="description" content="([^"]+)"', html)
        summary = _strip_tags(desc_match.group(1)) if desc_match else title

        return DatasetInfo(
            slug=slug,
            title=title.replace(" | Google Earth Engine", "").strip(),
            asset_id=asset_id,
            asset_type=asset_type,
            summary=summary,
            url=url,
        )

    @staticmethod
    def shortlist(question: str, datasets: Sequence[DatasetInfo], top_k: int = 12) -> List[DatasetInfo]:
        tokens = _tokenize(question)
        scored: List[Tuple[int, DatasetInfo]] = []
        for dataset in datasets:
            haystack = " ".join([dataset.slug, dataset.title, dataset.asset_id, dataset.summary]).lower()
            score = 0
            for token in tokens:
                if token in haystack:
                    score += 3 if token in dataset.slug.lower() or token in dataset.asset_id.lower() else 1
            water_keywords = {
                "flood": 4,
                "water": 3,
                "surface": 2,
                "river": 3,
                "lake": 3,
                "basin": 3,
                "ocean": 2,
                "evapotranspiration": 2,
                "hydro": 3,
                "reservoir": 3,
                "salinity": 2,
                "sea": 2,
            }
            for keyword, bonus in water_keywords.items():
                if keyword in haystack:
                    score += bonus
            scored.append((score, dataset))

        scored.sort(key=lambda pair: (-pair[0], pair[1].title.lower()))
        shortlisted = [item for score, item in scored if score > 0][:top_k]
        if shortlisted:
            return shortlisted
        return list(datasets[: min(top_k, len(datasets))])


class OpenAICompatiblePlanner:
    def __init__(self, api_key: Optional[str], api_base: Optional[str], model: Optional[str]):
        self.api_key = api_key
        self.api_base = _normalize_api_base(api_base)
        self.model = model or "gpt-4o-mini"

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def plan(
        self,
        question: str,
        shortlist: Sequence[DatasetInfo],
        location_hint: Optional[str],
        start_date: Optional[str],
        end_date: Optional[str],
    ) -> Tuple[Optional[AgentPlan], List[TokenUsageRecord]]:
        if not self.enabled:
            return None, []

        dataset_text = "\n".join(
            f"- slug: {item.slug}\n"
            f"  title: {item.title}\n"
            f"  asset_id: {item.asset_id}\n"
            f"  asset_type: {item.asset_type}\n"
            f"  summary: {item.summary}\n"
            f"  official_url: {item.url}"
            for item in shortlist
        )
        system_prompt = textwrap.dedent(
            """
            你是一个 Google Earth Engine water 数据图层规划助手。
            你的任务是：
            1. 结合用户问题，判断是否真的需要“可视化图层”。
            2. 如果需要，可只从候选数据集中选择 1-4 个最相关图层。
            3. 输出严格 JSON，不要输出额外解释。

            输出结构：
            {
              "need_visualization": true,
              "reason": "为什么需要或不需要可视化",
              "answer": "给用户的简短中文回答",
              "location_hint": "从问题中推断的位置，没有则为 null",
              "start_date": "YYYY-MM-DD 或 null",
              "end_date": "YYYY-MM-DD 或 null",
              "selected_layers": [
                {
                  "slug": "catalog slug",
                  "why": "为什么选它"
                }
              ]
            }

            规则：
            - 如果问题主要是解释、对比、背景知识、原理介绍，通常不需要可视化。
            - 如果问题涉及空间分布、范围、变化、洪水/水体位置、流域范围、上图查看，则倾向需要可视化。
            - 日期不明确时可以返回 null。
            - 只能从候选清单里选 slug。
            """
        ).strip()

        user_prompt = textwrap.dedent(
            f"""
            用户问题：{question}
            预设位置提示：{location_hint or "null"}
            预设开始日期：{start_date or "null"}
            预设结束日期：{end_date or "null"}

            候选数据集：
            {dataset_text}
            """
        ).strip()

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        response = requests.post(
            f"{self.api_base}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.model,
                "temperature": 0.2,
                "messages": messages,
            },
            timeout=60,
        )
        response.raise_for_status()
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        data = _extract_json(content)
        usage = payload.get("usage") or {}

        if usage:
            prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
            completion_tokens = int(usage.get("completion_tokens", 0) or 0)
            total_tokens = int(usage.get("total_tokens", prompt_tokens + completion_tokens) or 0)
            token_records = [
                TokenUsageRecord(
                    stage="planner_llm",
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    source="api_usage",
                    note="来自兼容 Chat Completions 响应的 usage 字段。",
                )
            ]
        else:
            prompt_tokens = _count_message_tokens(messages, self.model)
            completion_tokens = _count_text_tokens(content, self.model)
            token_records = [
                TokenUsageRecord(
                    stage="planner_llm",
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=prompt_tokens + completion_tokens,
                    source="tiktoken_estimate",
                    note="接口未返回 usage，使用 tiktoken 对请求与回复文本估算。",
                )
            ]

        selected_map = {item.slug: item for item in shortlist}
        selected_layers: List[LayerDecision] = []
        for raw_layer in data.get("selected_layers", []):
            slug = raw_layer.get("slug")
            if slug not in selected_map:
                continue
            dataset = selected_map[slug]
            selected_layers.append(
                LayerDecision(
                    slug=dataset.slug,
                    title=dataset.title,
                    asset_id=dataset.asset_id,
                    asset_type=dataset.asset_type,
                    why=raw_layer.get("why", ""),
                    url=dataset.url,
                )
            )

        return (
            AgentPlan(
                need_visualization=bool(data.get("need_visualization")),
                reason=data.get("reason", ""),
                answer=data.get("answer", ""),
                location_hint=data.get("location_hint") or location_hint,
                start_date=_safe_date(data.get("start_date")) or start_date,
                end_date=_safe_date(data.get("end_date")) or end_date,
                selected_layers=selected_layers,
                used_llm=True,
            ),
            token_records,
        )


def _heuristic_plan(
    question: str,
    shortlist: Sequence[DatasetInfo],
    location_hint: Optional[str],
    start_date: Optional[str],
    end_date: Optional[str],
) -> AgentPlan:
    lowered = question.lower()
    visual_keywords = [
        "map",
        "layer",
        "visual",
        "show",
        "where",
        "extent",
        "distribution",
        "变化",
        "范围",
        "分布",
        "位置",
        "洪水",
        "上图",
        "可视化",
        "流域",
    ]
    matched_keywords = [keyword for keyword in visual_keywords if keyword in lowered]
    need_visualization = len(matched_keywords) > 0
    selected = [
        LayerDecision(
            slug=item.slug,
            title=item.title,
            asset_id=item.asset_id,
            asset_type=item.asset_type,
            why="基于问题关键词与数据集摘要的启发式匹配。",
            url=item.url,
        )
        for item in shortlist[: min(3, len(shortlist))]
    ]
    answer = "已根据问题匹配候选 water 数据集。"
    if not need_visualization:
        answer += " 当前更像解释型问题，默认先不给地图。"
    return AgentPlan(
        need_visualization=need_visualization,
        reason=f"未检测到可用 LLM 凭证，使用启发式规则判断。命中的可视化关键词: {matched_keywords or '无'}。",
        answer=answer,
        location_hint=location_hint,
        start_date=start_date,
        end_date=end_date,
        selected_layers=selected if need_visualization else [],
        used_llm=False,
    )


def _heuristic_token_usage(
    question: str,
    shortlist: Sequence[DatasetInfo],
    plan: AgentPlan,
    model: Optional[str],
) -> TokenUsageRecord:
    shortlist_text = "\n".join(
        f"{item.slug} | {item.title} | {item.asset_id} | {item.asset_type} | {item.summary}"
        for item in shortlist
    )
    output_text = json.dumps(
        {
            "need_visualization": plan.need_visualization,
            "reason": plan.reason,
            "answer": plan.answer,
            "location_hint": plan.location_hint,
            "start_date": plan.start_date,
            "end_date": plan.end_date,
            "selected_layers": [asdict(layer) for layer in plan.selected_layers],
        },
        ensure_ascii=False,
    )
    prompt_tokens = _count_text_tokens(question, model) + _count_text_tokens(shortlist_text, model)
    completion_tokens = _count_text_tokens(output_text, model)
    source = "tiktoken_estimate" if tiktoken is not None else "unavailable"
    note = "启发式模式无官方 usage，使用 tiktoken 估算输入/输出文本。" if tiktoken is not None else "未安装 tiktoken，无法估算。"
    return TokenUsageRecord(
        stage="planner_heuristic",
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=prompt_tokens + completion_tokens,
        source=source,
        note=note,
    )


class EarthEngineLayerRenderer:
    def __init__(self, project_id: Optional[str], credentials_path: Optional[str], project_root: Path):
        self.project_id = project_id or os.getenv("GEE_PROJECT_ID") or os.getenv("PROJECT_ID")
        self.credentials_path = credentials_path or os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        self.legacy_private_key_path = os.getenv("EE_PRIVATE_KEY_FILE")
        self.ee_account = os.getenv("EE_ACCOUNT")
        self.project_root = project_root
        self.initialized = False
        self.init_error: Optional[str] = None
        self.proxy_server = TileProxyServer.get_instance()
        self.auth_summary: Dict[str, Any] = {
            "mode": "uninitialized",
            "project_id": self.project_id,
            "account": self.ee_account,
            "credentials_path": self.credentials_path,
            "tile_proxy_base_url": self.proxy_server.base_url,
        }

    def initialize(self) -> None:
        if self.initialized:
            return
        try:
            credential_file = self._resolve_credentials_path()
            if credential_file is not None:
                service_account_email = self._resolve_service_account_email(credential_file)
                credentials = ee.ServiceAccountCredentials(email=service_account_email, key_file=str(credential_file))
                ee.Initialize(credentials, project=self.project_id)
                self.auth_summary = {
                    "mode": "service_account",
                    "project_id": self.project_id,
                    "account": service_account_email,
                    "credentials_path": str(credential_file),
                    "tile_proxy_base_url": self.proxy_server.base_url,
                }
            else:
                ee.Initialize(project=self.project_id)
                self.auth_summary = {
                    "mode": "default_credentials",
                    "project_id": self.project_id,
                    "account": None,
                    "credentials_path": None,
                    "tile_proxy_base_url": self.proxy_server.base_url,
                }
            self.initialized = True
        except Exception as exc:  # pragma: no cover - external auth
            self.init_error = str(exc)
            self.auth_summary = {
                "mode": "failed",
                "project_id": self.project_id,
                "account": self.ee_account,
                "credentials_path": self.credentials_path or self.legacy_private_key_path,
                "tile_proxy_base_url": self.proxy_server.base_url,
                "error": str(exc),
            }
            self.initialized = False

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
        service_account_email = payload.get("client_email")
        if not service_account_email:
            raise ValueError("Service account JSON 缺少 client_email，请在 .env 中显式设置 EE_ACCOUNT。")
        return service_account_email

    def geocode_location(self, location: str) -> Optional[Dict[str, Any]]:
        if not location:
            return None
        response = _http_get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": location,
                "format": "jsonv2",
                "limit": 1,
            },
            timeout=20,
        )
        items = response.json()
        if not items:
            return None
        item = items[0]
        south, north, west, east = map(float, item["boundingbox"])
        return {
            "location": item.get("display_name", location),
            "center": ((south + north) / 2, (west + east) / 2),
            "bounds": {
                "south": south,
                "north": north,
                "west": west,
                "east": east,
            },
        }

    def create_map(
        self,
        layers: Sequence[LayerDecision],
        location_hint: Optional[str],
        start_date: Optional[str],
        end_date: Optional[str],
    ) -> Tuple[Optional[Any], Optional[Tuple[float, float]], Optional[Dict[str, float]], List[Dict[str, Any]], Optional[str]]:
        if folium is None:
            return None, None, None, [], "缺少 folium，请先安装 experiments/gee_water_layer_agent/requirements.txt。"

        self.initialize()
        if not self.initialized:
            return None, None, None, [], self.init_error or "Earth Engine 初始化失败。"

        region = self.geocode_location(location_hint) if location_hint else None
        center = region["center"] if region else (20.0, 0.0)
        bounds = region["bounds"] if region else None
        sample_zoom = 6
        sample_x, sample_y = _lon_lat_to_tile(center[1], center[0], sample_zoom)
        fmap = folium.Map(location=[center[0], center[1]], zoom_start=6, tiles=None)
        folium.TileLayer(
            tiles="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            attr="Esri World Imagery",
            name="Base Satellite",
            overlay=False,
            control=True,
        ).add_to(fmap)
        folium.TileLayer(
            tiles="OpenStreetMap",
            name="Base Streets",
            overlay=False,
            control=True,
        ).add_to(fmap)
        rendered_layers: List[Dict[str, Any]] = []

        for layer in layers:
            try:
                browser_tile_url, earth_engine_tile_url, vis_meta = self._build_tile_url(layer, bounds, start_date, end_date)
                folium.TileLayer(
                    tiles=browser_tile_url,
                    attr="Google Earth Engine",
                    name=layer.title,
                    overlay=True,
                    control=True,
                    opacity=0.8,
                ).add_to(fmap)
                rendered_layers.append(
                    {
                        "slug": layer.slug,
                        "title": layer.title,
                        "asset_id": layer.asset_id,
                        "asset_type": layer.asset_type,
                        "tile_url": browser_tile_url,
                        "earth_engine_tile_url": earth_engine_tile_url,
                        "sample_zoom": sample_zoom,
                        "sample_x": sample_x,
                        "sample_y": sample_y,
                        "sample_browser_tile_url": _resolve_tile_template(browser_tile_url, sample_x, sample_y, sample_zoom),
                        "sample_earth_engine_tile_url": _resolve_tile_template(earth_engine_tile_url, sample_x, sample_y, sample_zoom),
                        "vis_meta": vis_meta,
                        "tile_loading_mode": "authenticated_proxy_tiles",
                        "official_url": layer.url,
                    }
                )
            except Exception as exc:  # pragma: no cover - external GEE behavior
                rendered_layers.append(
                    {
                        "slug": layer.slug,
                        "title": layer.title,
                        "asset_id": layer.asset_id,
                        "asset_type": layer.asset_type,
                        "error": str(exc),
                        "official_url": layer.url,
                    }
                )

        folium.LayerControl(collapsed=False).add_to(fmap)
        return fmap, center, bounds, rendered_layers, None

    def _build_tile_url(
        self,
        layer: LayerDecision,
        bounds: Optional[Dict[str, float]],
        start_date: Optional[str],
        end_date: Optional[str],
    ) -> Tuple[str, str, Dict[str, Any]]:
        region = self._bounds_to_geometry(bounds) if bounds else None

        if layer.asset_type == "FeatureCollection":
            collection = ee.FeatureCollection(layer.asset_id)
            if region is not None:
                collection = collection.filterBounds(region)
            styled = collection.style(color="#00bcd4", fillColor="00000000", width=2)
            map_id = styled.getMapId({})
            return self._register_tile_fetcher(layer, map_id, {"style": "feature-outline"})

        if layer.asset_type == "ImageCollection":
            collection = ee.ImageCollection(layer.asset_id)
            if region is not None:
                collection = collection.filterBounds(region)
            if start_date and end_date:
                collection = collection.filterDate(start_date, _extend_end_date(end_date))
            elif start_date:
                collection = collection.filterDate(start_date, _extend_end_date(start_date))
            image = self._compose_collection(collection, region)
        else:
            image = ee.Image(layer.asset_id)
            if region is not None:
                image = image.clip(region)

        vis = self._derive_vis_params(layer.asset_id, image, region)
        map_id = image.getMapId(vis)
        return self._register_tile_fetcher(layer, map_id, vis)

    def _register_tile_fetcher(
        self,
        layer: LayerDecision,
        map_id: Dict[str, Any],
        vis_meta: Dict[str, Any],
    ) -> Tuple[str, str, Dict[str, Any]]:
        earth_engine_tile_url = self._to_earth_engine_tile_url(map_id["tile_fetcher"].url_format, map_id.get("mapid"))
        layer_id = re.sub(r"[^a-zA-Z0-9_-]", "-", layer.slug.lower())
        browser_tile_url = self.proxy_server.register(layer_id, map_id["tile_fetcher"])
        return browser_tile_url, earth_engine_tile_url, vis_meta

    @staticmethod
    def _to_earth_engine_tile_url(url_format: str, map_name: Optional[str]) -> str:
        if url_format:
            return url_format
        if map_name:
            return f"https://earthengine.googleapis.com/v1alpha/{map_name}/tiles/{{z}}/{{x}}/{{y}}"
        return ""

    @staticmethod
    def _compose_collection(collection: ee.ImageCollection, region: Optional[ee.Geometry]) -> ee.Image:
        size = int(collection.size().getInfo())
        if size == 0:
            raise ValueError("筛选后没有可用影像，请尝试补充地点或时间。")
        image = collection.sort("system:time_start", False).median()
        if region is not None:
            image = image.clip(region)
        return image

    @staticmethod
    def _bounds_to_geometry(bounds: Dict[str, float]) -> ee.Geometry:
        return ee.Geometry.Rectangle([bounds["west"], bounds["south"], bounds["east"], bounds["north"]])

    def _derive_vis_params(
        self,
        asset_id: str,
        image: ee.Image,
        region: Optional[ee.Geometry],
    ) -> Dict[str, Any]:
        lower_id = asset_id.lower()
        band_names = image.bandNames().getInfo()

        if "globalsurfacewater" in lower_id and "occurrence" in band_names:
            return {"bands": ["occurrence"], "min": 0, "max": 100, "palette": ["ffffff", "9ecae1", "2171b5"]}
        if "monthlyhistory" in lower_id and "water" in band_names:
            return {"bands": ["water"], "min": 0, "max": 2, "palette": ["000000", "9ecae1", "08306b"]}
        if "yearlyhistory" in lower_id and "waterClass" in band_names:
            return {"bands": ["waterClass"], "min": 0, "max": 3, "palette": ["000000", "ffffcc", "41b6c4", "253494"]}
        if "opera_dswx" in lower_id:
            return {"min": 0, "max": 9, "palette": ["000000", "9ecae1", "08306b", "fed976", "e31a1c", "7a0177"]}
        if "global_flood_db" in lower_id:
            if "flooded" in band_names:
                return {"bands": ["flooded"], "min": 0, "max": 1, "palette": ["000000", "ff0000"]}
            if "jrc_perm_water" in band_names:
                return {"bands": ["jrc_perm_water"], "min": 0, "max": 1, "palette": ["000000", "0000ff"]}
        if any(token in lower_id for token in ["hydroatlas", "hydrosheds", "usgs_wbd"]):
            return {"palette": ["00bcd4"]}
        if {"B4", "B3", "B2"}.issubset(set(band_names)):
            return {"bands": ["B4", "B3", "B2"], "min": 0, "max": 3000}
        if len(band_names) == 1:
            band = band_names[0]
            stats = self._estimate_range(image.select([band]), region, band)
            return {
                "bands": [band],
                "min": stats["min"],
                "max": stats["max"],
                "palette": ["f7fbff", "6baed6", "08306b"],
            }
        if len(band_names) >= 3:
            return {"bands": band_names[:3], "min": 0, "max": 1}
        return {"min": 0, "max": 1, "palette": ["f7fbff", "6baed6", "08306b"]}

    @staticmethod
    def _estimate_range(image: ee.Image, region: Optional[ee.Geometry], band_name: str) -> Dict[str, float]:
        geometry = region or ee.Geometry.Rectangle([-180, -60, 180, 80])
        stats = image.reduceRegion(
            reducer=ee.Reducer.percentile([2, 98]),
            geometry=geometry,
            scale=5000,
            bestEffort=True,
            maxPixels=1e7,
        ).getInfo()
        min_value = stats.get(f"{band_name}_p2")
        max_value = stats.get(f"{band_name}_p98")
        if min_value is None or max_value is None or min_value == max_value:
            return {"min": 0.0, "max": 1.0}
        return {"min": float(min_value), "max": float(max_value)}


class WaterLayerAgent:
    def __init__(self, project_root: Optional[Path] = None):
        self.project_root = _load_satgpt_env(project_root)
        self.prototype_root = self.project_root / "experiments" / "gee_water_layer_agent"
        self.catalog = WaterDatasetCatalog(self.prototype_root / "cache" / "water_catalog.json")
        self.planner = OpenAICompatiblePlanner(
            api_key=os.getenv("OPENAI_API_KEY"),
            api_base=os.getenv("OPENAI_API_BASE"),
            model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        )
        self.renderer = EarthEngineLayerRenderer(
            project_id=os.getenv("GEE_PROJECT_ID"),
            credentials_path=os.getenv("GOOGLE_APPLICATION_CREDENTIALS"),
            project_root=self.project_root,
        )

    def run(
        self,
        question: str,
        location_hint: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        force_refresh_catalog: bool = False,
    ) -> AgentResult:
        token_usage: List[TokenUsageRecord] = [
            TokenUsageRecord(
                stage="catalog_lookup",
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                source="none",
                note="官方 water 标签页抓取与本地缓存读取，不涉及 LLM token。",
            )
        ]
        datasets = self.catalog.load(force_refresh=force_refresh_catalog)
        shortlist = WaterDatasetCatalog.shortlist(question, datasets)
        token_usage.append(
            TokenUsageRecord(
                stage="shortlist_ranking",
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                source="none",
                note="本地关键词排序，不涉及 LLM token。",
            )
        )

        llm_plan: Optional[AgentPlan] = None
        llm_error: Optional[str] = None
        if self.planner.enabled:
            try:
                llm_plan, llm_usage = self.planner.plan(
                    question,
                    shortlist,
                    location_hint,
                    _safe_date(start_date),
                    _safe_date(end_date),
                )
                token_usage.extend(llm_usage)
            except Exception as exc:
                llm_error = str(exc)

        plan = llm_plan or _heuristic_plan(question, shortlist, location_hint, _safe_date(start_date), _safe_date(end_date))
        if not llm_plan:
            token_usage.append(_heuristic_token_usage(question, shortlist, plan, self.planner.model))
        if llm_error:
            plan.reason = f"{plan.reason} LLM 规划失败原因: {llm_error}"
            plan.answer = f"{plan.answer} 已自动退回启发式匹配。"

        fmap = None
        map_center = None
        region_bounds = None
        rendered_layers: List[Dict[str, Any]] = []
        map_error: Optional[str] = None
        if plan.need_visualization and plan.selected_layers:
            fmap, map_center, region_bounds, rendered_layers, map_error = self.renderer.create_map(
                layers=plan.selected_layers,
                location_hint=plan.location_hint,
                start_date=plan.start_date,
                end_date=plan.end_date,
            )
        token_usage.append(
            TokenUsageRecord(
                stage="map_render",
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                source="none",
                note="GEE 地图渲染与瓦片请求不经过 LLM，不产生模型 token。",
            )
        )

        self._last_map = fmap
        return AgentResult(
            question=question,
            plan=plan,
            shortlist=list(shortlist),
            map_center=map_center,
            region_bounds=region_bounds,
            map_ready=fmap is not None and map_error is None,
            map_error=map_error,
            rendered_layers=rendered_layers,
            token_usage=token_usage,
            gee_auth=self.renderer.auth_summary,
        )

    @property
    def last_map(self) -> Optional[Any]:
        return getattr(self, "_last_map", None)


def review_question(
    question: str,
    location_hint: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    force_refresh_catalog: bool = False,
) -> Tuple[AgentResult, Optional[Any]]:
    agent = WaterLayerAgent()
    result = agent.run(
        question=question,
        location_hint=location_hint,
        start_date=start_date,
        end_date=end_date,
        force_refresh_catalog=force_refresh_catalog,
    )
    return result, agent.last_map

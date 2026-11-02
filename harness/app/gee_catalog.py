"""Search the public Earth Engine STAC catalog (adapted from dsh-gee, MIT)."""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import urlopen


STAC_BASE = "https://earthengine-stac.storage.googleapis.com/catalog"
STAC_TTL_SECONDS = 7 * 24 * 3600


def _get_json(url: str) -> dict | None:
    try:
        with urlopen(url, timeout=45) as response:
            return json.load(response)
    except Exception:
        return None


def _build_index() -> dict:
    root = _get_json(f"{STAC_BASE}/catalog.json")
    if not root:
        raise RuntimeError("无法访问 Earth Engine 公共 STAC 数据目录")
    children = [link["href"] for link in root.get("links", [])
                if link.get("rel") == "child" and link.get("href")]
    with ThreadPoolExecutor(max_workers=24) as pool:
        catalogs = list(pool.map(_get_json, children))
    dataset_links = [link["href"] for catalog in catalogs if catalog
                     for link in catalog.get("links", [])
                     if link.get("rel") == "child" and link.get("href")]
    with ThreadPoolExecutor(max_workers=24) as pool:
        documents = list(pool.map(_get_json, dataset_links))
    items = []
    for document in documents:
        if not document or not document.get("id"):
            continue
        items.append({
            "id": document["id"],
            "title": document.get("title") or document["id"],
            "type": document.get("gee:type") or "",
            "keywords": [str(key) for key in (document.get("keywords") or [])][:12],
            "summary": " ".join((document.get("description") or "").split())[:240],
            "text": " ".join((document.get("description") or "").split()).lower()[:2000],
            "deprecated": bool(document.get("deprecated")),
        })
    if not items:
        raise RuntimeError("Earth Engine 数据目录未返回数据集")
    return {"fetched_at": int(time.time()), "count": len(items), "items": items}


def search(query: str = "", limit: int = 20, dataset_type: str | None = None,
           refresh: bool = False, cache_dir: Path | None = None) -> dict:
    cache_dir = cache_dir or Path(__file__).resolve().parent.parent / "state" / "catalog"
    cache_file = cache_dir / "stac-index.json"
    index = None
    if not refresh and cache_file.is_file():
        try:
            candidate = json.loads(cache_file.read_text(encoding="utf-8"))
            if (int(time.time()) - int(candidate.get("fetched_at", 0)) < STAC_TTL_SECONDS
                    and candidate.get("items") and "text" in candidate["items"][0]):
                index = candidate
        except (OSError, ValueError, KeyError, TypeError):
            pass
    rebuilt = index is None
    if rebuilt:
        index = _build_index()
        cache_dir.mkdir(parents=True, exist_ok=True)
        temporary = cache_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
        temporary.replace(cache_file)
    terms = [term for term in str(query).lower().replace(",", " ").split() if term]
    scored = []
    for item in index["items"]:
        if dataset_type and item.get("type") != dataset_type:
            continue
        identifier = item["id"].lower()
        title = item["title"].lower()
        keywords = " ".join(item["keywords"]).lower()
        description = item.get("text", "")
        matches = [(term in identifier, term in title, term in keywords, term in description)
                   for term in terms]
        if terms and not any(any(row) for row in matches):
            continue
        score = sum((4 if a else 0) + (3 if b else 0) + (2 if c else 0) + (1 if d else 0)
                    for a, b, c, d in matches)
        if terms and all(any(row) for row in matches):
            score += 10
        scored.append((score, item))
    scored.sort(key=lambda pair: (-pair[0], len(pair[1]["id"])))
    limit = max(1, min(50, int(limit)))
    result = [{key: value for key, value in item.items() if key != "text"}
              for _, item in scored[:limit]]
    return {"total": len(scored), "returned": len(result), "catalog_size": index["count"],
            "rebuilt": rebuilt, "matches": result}

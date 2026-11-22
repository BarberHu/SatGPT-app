"""Search the public Earth Engine STAC catalog (adapted from dsh-gee, MIT)."""

from __future__ import annotations

import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import urlopen


STAC_BASE = "https://earthengine-stac.storage.googleapis.com/catalog"
STAC_TTL_SECONDS = 7 * 24 * 3600
STAC_MAX_AGE_SECONDS = 30 * 24 * 3600


def _get_json(url: str) -> dict | None:
    try:
        with urlopen(url, timeout=45) as response:
            return json.load(response)
    except Exception:
        return None


def _get_documents(pool, links, valid):
    documents = list(pool.map(_get_json, links))
    missing = [index for index, document in enumerate(documents) if not valid(document)]
    for index, document in zip(missing, pool.map(_get_json, (links[index] for index in missing))):
        documents[index] = document
    if any(not valid(document) for document in documents):
        raise RuntimeError('The public Earth Engine catalog returned an incomplete index')
    return documents


def _build_index() -> dict:
    root = _get_json(f"{STAC_BASE}/catalog.json")
    if not root:
        raise RuntimeError("Unable to access the public Earth Engine STAC catalog")
    children = [link["href"] for link in root.get("links", [])
                if link.get("rel") == "child" and link.get("href")]
    with ThreadPoolExecutor(max_workers=24) as pool:
        catalogs = _get_documents(pool, children, lambda value: isinstance(value, dict) and isinstance(value.get('links'), list))
        dataset_links = [link["href"] for catalog in catalogs for link in catalog["links"]
                         if link.get("rel") == "child" and link.get("href")]
        documents = _get_documents(pool, dataset_links, lambda value: isinstance(value, dict) and bool(value.get('id')))
    items = []
    for document in documents:
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
        raise RuntimeError("The Earth Engine catalog returned no datasets")
    return {"fetched_at": int(time.time()), "count": len(items), "items": items}


def index_path(cache_dir):
    cache_dir = cache_dir or Path(__file__).resolve().parent.parent / "state" / "catalog"
    return cache_dir / "stac-index.json"


def valid_index(index):
    if not isinstance(index, dict):
        return False
    rows = index.get('items')
    return (type(index.get('fetched_at')) is int and isinstance(rows, list) and bool(rows)
            and index.get('count') == len(rows) and all(
                isinstance(item, dict) and all(isinstance(item.get(key), str) for key in ('id', 'title'))
                and isinstance(item.get('text', ''), str)
                and isinstance(item.get('keywords'), list) and all(isinstance(word, str) for word in item['keywords'])
                for item in rows))


def rebuild(cache_dir=None):
    index = _build_index()
    if not valid_index(index):
        raise ValueError('The rebuilt Earth Engine catalog is invalid')
    cache_file = index_path(cache_dir)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache_file.parent / f"stac-index-{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
        temporary.replace(cache_file)
    finally:
        temporary.unlink(missing_ok=True)
    return {'fetched_at': index['fetched_at'], 'catalog_size': index['count']}


def read_cached(query='', limit=20, dataset_type=None, cache_dir=None):
    try:
        index = json.loads(index_path(cache_dir).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {'cache_state': 'missing'}
    if not valid_index(index):
        return {'cache_state': 'missing'}
    age = max(0, int(time.time()) - index['fetched_at'])
    if age >= STAC_MAX_AGE_SECONDS:
        return {'cache_state': 'missing'}
    return {**search_index(index, query, limit, dataset_type), 'rebuilt': False,
            'cache_state': 'stale' if age >= STAC_TTL_SECONDS else 'fresh', 'cache_age_seconds': age}


def search(query: str = "", limit: int = 20, dataset_type: str | None = None,
           refresh: bool = False, cache_dir: Path | None = None) -> dict:
    result = read_cached(query, limit, dataset_type, cache_dir)
    if refresh or result['cache_state'] != 'fresh':
        rebuild(cache_dir)
        result = {**read_cached(query, limit, dataset_type, cache_dir), 'rebuilt': True}
    return result


def search_index(index, query, limit, dataset_type):
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
            "matches": result}

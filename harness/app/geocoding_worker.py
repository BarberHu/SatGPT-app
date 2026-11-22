"""Resolve named places through a configured Nominatim-compatible search endpoint."""

from collections import OrderedDict
from contextlib import closing, contextmanager, nullcontext
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
from time import monotonic, sleep
from urllib.parse import urlsplit

import httpx


ATTRIBUTION = '© OpenStreetMap contributors (Nominatim)'
MAX_RESPONSE_BYTES = 256 * 1024
MAX_CACHE_ENTRIES = 256
PUBLIC_HOST = 'nominatim.openstreetmap.org'
PUBLIC_REQUEST_INTERVAL = 1.1
PUBLIC_LOCK_TIMEOUT = 3
ADMINISTRATIVE_FIELDS = (
    'country', 'country_code', 'state', 'region', 'state_district', 'county',
    'municipality', 'city', 'town', 'village', 'city_district', 'district',
    'borough', 'suburb', 'neighbourhood',
)


def search_params(payload):
    query = payload.get('query')
    country = payload.get('country_code')
    language = payload.get('language')
    limit = payload.get('limit', 3)
    if not isinstance(query, str) or not (1 <= len(query) <= 200) or not query.strip():
        raise ValueError('Provide a place name with at most 200 characters.')
    if country is not None and (not isinstance(country, str) or not re.fullmatch(r'[A-Za-z]{2}', country)):
        raise ValueError('country_code must be a two-letter country code.')
    if language is not None and (not isinstance(language, str) or len(language) > 35
                                 or not re.fullmatch(r'[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*', language)):
        raise ValueError('language must be a single language tag, such as zh-CN.')
    if type(limit) is not int or not 1 <= limit <= 5:
        raise ValueError('limit must be an integer between 1 and 5.')
    params = {'q': ' '.join(query.split()), 'limit': limit, 'format': 'jsonv2', 'addressdetails': 1}
    if country:
        params['countrycodes'] = country.lower()
    if language:
        params['accept-language'] = language.lower()
    return params


def coordinate(value, magnitude):
    if type(value) not in (int, float, str):
        raise ValueError('Invalid coordinate')
    number = float(value)
    if not math.isfinite(number) or abs(number) > magnitude:
        raise ValueError('Invalid coordinate')
    return number


def bounds_for(value):
    if not isinstance(value, list) or len(value) != 4:
        return None
    try:
        south, north = (coordinate(item, 90) for item in value[:2])
        west, east = (coordinate(item, 180) for item in value[2:])
    except (ValueError, OverflowError):
        return None
    if west < east and south < north:
        return [west, south, east, north]
    return None


def normalize_candidate(row):
    if not isinstance(row, dict):
        return None
    label = row.get('display_name')
    if not isinstance(label, str) or not label.strip():
        return None
    try:
        position = [coordinate(row.get('lon'), 180), coordinate(row.get('lat'), 90)]
    except (ValueError, OverflowError):
        return None
    kind = row.get('addresstype') or row.get('type')
    candidate = {'label': label.strip()[:500], 'type': kind[:80] if isinstance(kind, str) and kind else 'unknown',
                 'position': position}
    bounds = bounds_for(row.get('boundingbox'))
    if bounds is not None:
        candidate['bounds'] = bounds
    address = row.get('address')
    if isinstance(address, dict):
        administrative = {field: address[field].strip()[:200] for field in ADMINISTRATIVE_FIELDS
                          if isinstance(address.get(field), str) and address[field].strip()}
        if administrative:
            candidate['administrative'] = administrative
    kind, identifier = row.get('osm_type'), row.get('osm_id')
    if kind in ('node', 'way', 'relation') and type(identifier) is int and identifier > 0:
        candidate['osm_ref'] = f'{kind}/{identifier}'
    return candidate


def result(status, candidates=(), message=None):
    value = {'status': status, 'attribution': ATTRIBUTION, 'candidates': list(candidates)}
    if message:
        value['message'] = message
    return value


@contextmanager
def public_request_slot(lock_file):
    if not lock_file:
        raise OSError('Public geocoding requires a shared rate limit file')
    path = Path(lock_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=PUBLIC_LOCK_TIMEOUT, isolation_level=None)) as connection:
        connection.execute('BEGIN IMMEDIATE')
        # Wait even when the last holder was killed mid-request. Closing releases the lock.
        sleep(PUBLIC_REQUEST_INTERVAL)
        yield


class Geocoder:
    def __init__(self, client, endpoint, public_lock_file=None):
        self.client = client
        self.endpoint = endpoint
        self.public = (urlsplit(endpoint).hostname or '').rstrip('.') == PUBLIC_HOST
        self.public_lock_file = public_lock_file
        self.cache = OrderedDict()

    def search(self, payload):
        try:
            params = search_params(payload)
        except ValueError as exc:
            return result('invalid_query', message=str(exc))
        key = tuple(params.items())
        cached = self.cache.get(key)
        if cached and cached[0] > monotonic():
            self.cache.move_to_end(key)
            return cached[1]
        slot = public_request_slot(self.public_lock_file) if self.public else nullcontext()
        try:
            with slot, self.client.stream('GET', self.endpoint, params=params) as response:
                if response.status_code == 429:
                    return result('rate_limited', message='The geocoding service is rate limiting requests.')
                response.raise_for_status()
                body = bytearray()
                for chunk in response.iter_bytes(chunk_size=8192):
                    body.extend(chunk)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise ValueError('Geocoding response too large')
                rows = json.loads(body)
            if not isinstance(rows, list):
                raise ValueError('Expected a list of geocoding candidates')
            candidates = []
            seen = set()
            for row in rows[:5]:
                candidate = normalize_candidate(row)
                if candidate is None:
                    continue
                identity = candidate.get('osm_ref') or (candidate['label'].casefold(), *candidate['position'])
                if identity not in seen:
                    seen.add(identity)
                    candidates.append(candidate)
                if len(candidates) == params['limit']:
                    break
            if rows and not candidates:
                raise ValueError('No valid geocoding candidates in response')
        except httpx.TimeoutException:
            return result('upstream_timeout', message='The geocoding service timed out.')
        except sqlite3.Error as exc:
            if getattr(exc, 'sqlite_errorcode', None) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                return result('rate_limited', message='Public geocoding is busy. Try again later.')
            return result('upstream_error', message='The public geocoding rate limiter is unavailable.')
        except OSError:
            return result('upstream_error', message='The public geocoding rate limiter is unavailable.')
        except (httpx.HTTPError, httpx.InvalidURL, ValueError, RecursionError):
            return result('upstream_error', message='The geocoding service could not return valid results.')

        value = result('ok' if candidates else 'no_match', candidates)
        self.cache[key] = (monotonic() + (900 if candidates else 60), value)
        self.cache.move_to_end(key)
        if len(self.cache) > MAX_CACHE_ENTRIES:
            self.cache.popitem(last=False)
        return value


def main():
    with httpx.Client(headers={'User-Agent': 'SatGPT/Geocoding (place search)'},
                      timeout=httpx.Timeout(6, connect=3)) as client:
        geocoder = Geocoder(client, os.environ['SATGPT_GEOCODING_URL'],
                            os.environ.get('SATGPT_GEOCODING_LOCK_FILE'))
        for line in sys.stdin:
            request = json.loads(line)
            value = geocoder.search(request['payload'])
            print(json.dumps({'id': request['id'], 'ok': True, 'data': value},
                             ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()

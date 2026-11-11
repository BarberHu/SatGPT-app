"""Opt-in serial replay of saved legacy layers through the daily frontend.

Reports contain no tile URLs or code. Private snapshots/backups stay in outputs.
An interrupted POST is reconciled through history, never automatically repeated.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from harness.app.controller import layer_code_bounds
from harness.app.trace import clean_text

PROJECT = Path(__file__).resolve().parents[2]


def safe_error(error):
    text = clean_text(str(error), limit=1500)
    text = re.sub(r'https?://\S+', '[service URL]', text)
    return re.sub(r'(?:projects|users)/[\w./-]+', '[asset path]', text)


def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def request(base, path, method='GET'):
    try:
        with urlopen(Request(base + path, method=method), timeout=180 if method == 'POST' else 15) as response:
            return json.load(response)
    except HTTPError as exc:
        try:
            detail = json.loads(exc.read()).get('detail', f'HTTP {exc.code}')
        except (ValueError, AttributeError):
            detail = f'HTTP {exc.code}'
        raise ValueError(f'HTTP {exc.code}: {safe_error(detail)}') from None


def find_layer(conversation, layer_id):
    for message in conversation['messages']:
        for index, layer in enumerate(message.get('layers') or []):
            if f"{message.get('job_id')}-{index}" == layer_id:
                return layer
    raise ValueError('Layer no longer exists in its original conversation')


def tile_format(data, content_type):
    media = content_type.split(';')[0].strip().lower()
    if media == 'image/png' and data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'PNG'
    if media == 'image/jpeg' and data.startswith(b'\xff\xd8\xff'):
        return 'JPEG'
    if media == 'image/webp' and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'WebP'
    raise ValueError('Tile response has an unsupported or mismatched image format')


def probe_tile(layer):
    bounds = layer.get('bounds')
    source = 'saved_layer_bounds'
    if not bounds:
        bounds = layer_code_bounds(layer.get('code', ''))
        source = 'literal_code_rectangle'
    if bounds:
        west, south, east, north = bounds
        z = 8
        longitude, latitude = (west + east) / 2, max(-85, min(85, (south + north) / 2))
        n = 2 ** z
        x = min(n - 1, max(0, int((longitude + 180) / 360 * n)))
        y = min(n - 1, max(0, int((1 - math.asinh(math.tan(math.radians(latitude))) / math.pi) / 2 * n)))
    else:
        z = x = y = 0
        source = 'global_low_zoom_no_known_extent'
    url = layer['url'].replace('{z}', str(z)).replace('{x}', str(x)).replace('{y}', str(y))
    errors = []
    for _ in range(2):
        try:
            with urlopen(url, timeout=25) as response:
                data = response.read(3_000_001)
                media = response.headers.get('Content-Type', '')
            if len(data) > 3_000_000:
                raise ValueError('Tile exceeds the verification size limit')
            return {'ok': True, 'format': tile_format(data, media), 'bytes': len(data),
                    'sampling': source, 'transient_errors': errors}
        except HTTPError as exc:
            try:
                detail = json.loads(exc.read()).get('error', {}).get('message', f'HTTP {exc.code}')
            except (ValueError, AttributeError):
                detail = f'HTTP {exc.code}'
            errors.append(safe_error(f'HTTP {exc.code}: {detail}'))
        except Exception as exc:
            errors.append(safe_error(f'{type(exc).__name__}: {exc}'))
    return {'ok': False, 'sampling': source, 'errors': errors}


def message_content(conversation):
    return [{key: value for key, value in message.items() if key != 'layers'} for message in conversation['messages']]


def export_csv(directory, journal):
    with (directory / 'results.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['Index', 'Conversation ID', 'Layer ID', 'Layer name', 'Result', 'Reason',
                         'Reload seconds', 'Tile format', 'Tile bytes', 'Sampling extent', 'Thumbnail',
                         'Original parameters and messages preserved', 'Persisted reload version'])
        for index, row in enumerate(journal['layers'], 1):
            tile = row.get('tile', {})
            writer.writerow([index, row['conversation_id'], row['layer_id'], row['name'], row['status'],
                             row.get('reason', ''), (row.get('attempts') or [{}])[-1].get('seconds', ''),
                             tile.get('format', ''), tile.get('bytes', ''), tile.get('sampling', ''),
                             row.get('thumbnail_status', ''), row.get('parameters_and_messages_preserved', ''),
                             row.get('persisted_reload_version', '')])


def verify_saved(before, after, layer_id):
    old, new = find_layer(before, layer_id), find_layer(after, layer_id)
    assert message_content(before) == message_content(after), 'Chat messages changed during reload'
    assert new.get('reload_version', 0) == old.get('reload_version', 0) + 1, 'Unexpected reload version'
    for key in ('generation', 'code', 'bounds'):
        assert old.get(key) == new.get(key), f'Original {key} changed'
    visualization = (old.get('generation') or {}).get('visualization') or {}
    expected = {key: visualization[key] for key in ('bands', 'min', 'max', 'palette') if key in visualization}
    assert (new.get('visualization') or {}) == expected, 'Replayed visualization differs from the original recipe'
    for message in before['messages']:
        for index, layer in enumerate(message.get('layers') or []):
            other_id = f"{message.get('job_id')}-{index}"
            if other_id != layer_id:
                assert layer == find_layer(after, other_id), 'Another layer changed during reload'
    return new


def initialize(base, directory, excluded, expected):
    current = request(base, '/api/harness/conversation')
    assert not current.get('active_task'), 'An Agent task is running'
    snapshots, targets = {}, []
    for row in request(base, '/api/harness/conversations')['conversations']:
        cid = row.get('conversation_id') or row['id']
        conversation = request(base, '/api/harness/conversations/' + cid)
        assert not conversation.get('active_task'), 'An Agent task is running'
        snapshots[cid] = conversation
        for message in conversation['messages']:
            for index, layer in enumerate(message.get('layers') or []):
                lid = f"{message['job_id']}-{index}"
                if f'{cid}/{lid}' == excluded:
                    continue
                targets.append({'conversation_id': cid, 'layer_id': lid, 'name': layer['name'],
                                'status': 'pending', 'attempts': []})
    assert len(targets) == expected, f'Expected {expected} remaining layers, found {len(targets)}'
    backup = directory / 'history-backup'
    backup.mkdir()
    state = PROJECT / 'harness' / 'state'
    files = [state / 'chat-history.json', *sorted((state / 'conversations').glob('webgis-*.json'))]
    for source in files:
        if source.is_file():
            target = backup / source.relative_to(state)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    save(directory / 'private-initial-snapshots.json', snapshots)
    journal = {'started_at': datetime.now(timezone.utc).isoformat(), 'base': base,
               'original_current_conversation': current['conversation_id'], 'excluded_layer': excluded, 'layers': targets}
    save(directory / 'results.json', journal)
    return journal


def run_one(base, directory, row, persist):
    cid, lid = row['conversation_id'], row['layer_id']
    route = '/api/harness/conversations/' + cid
    snapshot_path = directory / f"private-before-{cid}-{lid}.json"
    if row['status'] == 'pending':
        before = request(base, route)
        assert not before.get('active_task'), 'An Agent task is running in this conversation'
        save(snapshot_path, before)
        row['status'] = 'submitting'
        row['attempts'].append({'started_at': datetime.now(timezone.utc).isoformat(), 'post_sent': True})
        persist()
        started = time.monotonic()
        try:
            result = request(base, route + '/layers/' + lid + '/reload', 'POST')
            assert result['conversation_id'] == cid and result['layer_id'] == lid
            row['attempts'][-1]['http_reload'] = 'success'
        except Exception as exc:
            row['attempts'][-1]['error'] = safe_error(f'{type(exc).__name__}: {exc}')
        row['attempts'][-1]['seconds'] = round(time.monotonic() - started, 2)
        persist()
    before = json.loads(snapshot_path.read_text(encoding='utf-8'))
    after = request(base, route)
    old, new = find_layer(before, lid), find_layer(after, lid)
    if new.get('reload_version', 0) == old.get('reload_version', 0):
        row['status'] = 'reload_failed_or_unresolved'
        row['reason'] = row['attempts'][-1].get('error', 'No persisted new version; POST not repeated automatically')
        return
    new = verify_saved(before, after, lid)
    row['parameters_and_messages_preserved'] = True
    row['persisted_reload_version'] = new['reload_version']
    row['thumbnail_status'] = 'available' if new.get('thumbnail') else new.get('thumbnail_status', 'unavailable')
    row['code_sha256'] = hashlib.sha256(new['code'].encode()).hexdigest()
    row['tile'] = probe_tile(new)
    row['status'] = 'passed' if row['tile']['ok'] else 'tile_failed'
    row['reason'] = 'Reload, persistence and sampled tile succeeded' if row['tile']['ok'] else '; '.join(row['tile']['errors'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://127.0.0.1:3000')
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--exclude', default='webgis-2cee544b109d4ca2/d0bbdf3594f8-0')
    parser.add_argument('--expect', type=int, default=18)
    args = parser.parse_args()
    assert re.fullmatch(r'http://127\.0\.0\.1:\d+', args.base), 'Only the local verification service is allowed'
    args.directory.mkdir(parents=True, exist_ok=True)
    target = args.directory / 'results.json'
    journal = json.loads(target.read_text(encoding='utf-8')) if target.exists() else initialize(args.base, args.directory, args.exclude, args.expect)
    assert journal['base'] == args.base and journal['excluded_layer'] == args.exclude
    persist = lambda: save(target, journal)
    for index, row in enumerate(journal['layers'], 1):
        if row['status'] not in {'pending', 'submitting'}:
            continue
        try:
            run_one(args.base, args.directory, row, persist)
        except Exception as exc:
            row['status'] = 'verification_failed'
            row['reason'] = safe_error(f'{type(exc).__name__}: {exc}')
        persist()
        print(json.dumps({'index': index, **row}, ensure_ascii=True), flush=True)
    current = request(args.base, '/api/harness/conversation')
    journal['current_conversation_unchanged'] = current['conversation_id'] == journal['original_current_conversation']
    journal['finished_at'] = datetime.now(timezone.utc).isoformat()
    journal['summary'] = {status: sum(row['status'] == status for row in journal['layers']) for status in sorted({row['status'] for row in journal['layers']})}
    persist()
    export_csv(args.directory, journal)
    print(json.dumps({'summary': journal['summary'], 'current_conversation_unchanged': journal['current_conversation_unchanged']}), flush=True)


if __name__ == '__main__':
    main()

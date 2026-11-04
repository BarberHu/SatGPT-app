"""Opt-in real-model HTTP/SSE check, using isolated state under harness/state.

Run from root: harness/.venv/Scripts/python -m harness.tests.live_stream_smoke
Uses the project's configured model/GEE credentials; never prints keys or answers.
"""
import http.client
import json
import os
import shutil
import socket
import sys
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('DSH_MAX_TOKENS', '4096')
os.environ.setdefault('DSH_REASONING_EFFORT', 'low')

import uvicorn
from harness.app import server as api
from satgpt_backend import app as unified_app


def main():
    isolated = ROOT / 'state' / 'stream-smoke' / uuid.uuid4().hex
    shutil.copytree(ROOT / 'app', isolated / 'app', ignore=shutil.ignore_patterns('__pycache__'))
    api.ROOT = isolated
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    service = uvicorn.Server(uvicorn.Config(unified_app, log_level='warning'))
    thread = threading.Thread(target=lambda: service.run(sockets=[sock]), daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not service.started:
        if time.monotonic() > deadline:
            raise TimeoutError('API did not start')
        time.sleep(.05)

    def request(method, path, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=180)
        connection.request(method, path, json.dumps(body) if body else None,
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        assert response.status < 300, data
        return data

    connections = []
    def stream(job, cursor=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=180)
        connections.append(connection)
        connection.request('GET', f'/api/harness/tasks/{job}/events',
                           headers={'Last-Event-ID': str(cursor)} if cursor is not None else {})
        response = connection.getresponse()
        assert response.status == 200
        return connection, response

    def read(response):
        while True:
            line = response.readline().decode('utf-8').strip()
            if not line:
                if response.isclosed():
                    return None
                continue
            if line.startswith('data: '):
                return json.loads(line[6:])

    started = time.monotonic()
    try:
        job = request('POST', '/api/harness/tasks', {
            'prompt': "图层卡片接口验证。先简短说明要生成高程图，然后只调用一次 gee_layer：区域 [119.5,30.3,120.1,30.8]，代码 region = ee.Geometry.Rectangle([119.5,30.3,120.1,30.8]); result = ee.Image('USGS/SRTMGL1_003').clip(region)。名称为 地形高程，bounds 同上，min=0，max=600，palette=['ffffff','87ba9a','355949']。metadata 填 source=NASA SRTM、dataset_id=USGS/SRTMGL1_003、unit=m；观测日期未知就省略，不要编造。Tool返回后简短报告结果，不调用其他Tool。",
            'bounds': [119.5, 30.3, 120.1, 30.8],
        })
        connection, response = stream(job['id'])
        seen = []
        reconnected = False
        first_delta = None
        live_reasoning = False
        snapshot_answer = False
        while True:
            event = read(response)
            if event is None:
                raise AssertionError('SSE ended before completion')
            seen.append(event)
            if event['type'] == 'reasoning.delta' and not live_reasoning:
                fresh_connection, fresh_response = stream(job['id'])
                fresh = read(fresh_response)
                live_reasoning = fresh['task']['status'] == 'running' and any(
                    row['kind'] == 'reasoning' and not row['committed'] for row in fresh['task']['timeline'])
                fresh_response.close()
                fresh_connection.close()
            if event['type'] == 'answer.delta' and first_delta is None:
                first_delta = time.monotonic() - started
                current = request('GET', '/api/harness/conversation')
                assert not any(x['role'] == 'assistant' for x in current['messages']), 'draft persisted in history'
                fresh_connection, fresh_response = stream(job['id'])
                fresh = read(fresh_response)
                snapshot_answer = bool(fresh['type'] == 'snapshot' and fresh['answer'] and fresh['answer']['text'])
                fresh_response.close()
                fresh_connection.close()
                response.close()
                connection.close()
                connection, response = stream(job['id'], event['id'])
                reconnected = True
            if event['type'] == 'task' and event['patch'].get('status') in {'completed', 'failed'}:
                assert event['patch']['status'] == 'completed', event['patch'].get('error')
                break
            if event['type'] == 'snapshot' and event['task']['status'] in {'completed', 'failed'}:
                raise AssertionError('Model completed before live text could be observed')
        result = request('GET', f"/api/harness/tasks/{job['id']}")
        layer = result['output']['layers'][0]
        assert layer['metadata']['unit'] == 'm'
        assert layer['visualization']['palette'] == ['ffffff', '87ba9a', '355949']
        assert layer['bounds'] == [119.5, 30.3, 120.1, 30.8]
        assert layer.get('thumbnail'), 'worker did not generate thumbnail'
        preview_conn = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
        preview_conn.request('GET', layer['thumbnail']['url'])
        preview_response = preview_conn.getresponse()
        png = preview_response.read()
        assert preview_response.status == 200 and png.startswith(b'\x89PNG\r\n\x1a\n')
        preview_conn.close()
        (isolated / 'preview.png').write_bytes(png)
        print('Preview artifact: ' + str(isolated / 'preview.png'))
        history = request('GET', '/api/harness/conversation')['messages']
        assert history[-1]['layers'][0]['thumbnail'] == layer['thumbnail']
        replies = [x for x in history if x['role'] == 'assistant']
        assert len(replies) == 1 and replies[0]['content'] == result['output']['message']
        timeline = replies[0]['timeline']
        assert timeline and all(row['committed'] for row in timeline)
        assert [row['seq'] for row in timeline] == sorted(set(row['seq'] for row in timeline))
        assert any(row['kind'] == 'tool' and row['status'] == 'done' for row in timeline)
        assert not any(row['kind'] == 'text' and row.get('text') == replies[0]['content'] for row in timeline)
        assert any(event.get('timeline_ops') for event in seen), 'missing live timeline operations'
        deltas = [x for x in seen if x['type'] == 'answer.delta']
        assert len(deltas) >= 2 and snapshot_answer and reconnected
        # This layer contract does not require the provider to emit reasoning.
        assert all('task' not in x and 'trace' not in x for x in deltas)
        ids = [x['id'] for x in seen]
        assert ids == sorted(set(ids)), 'reconnect duplicated or reordered events'
        report = {'model': os.getenv('DSH_MODEL'), 'delta_events': len(deltas), 'reasoning_events': sum(e['type'] == 'reasoning.delta' for e in seen),
                  'live_reasoning_before_settlement': live_reasoning,
                  'first_delta_seconds': round(first_delta, 2),
                  'completion_seconds': round(time.monotonic() - started, 2),
                  'reconnect_passed': reconnected, 'refresh_snapshot_passed': snapshot_answer,
                  'one_final_history_message': True, 'timeline_rows': len(timeline), 'timeline_order_and_settlement': True,
                  'final_characters': len(replies[0]['content']), 'thumbnail_bytes': len(png), 'thumbnail_width': layer['thumbnail']['width'], 'metadata_and_history_preserved': True}
        (isolated / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=True))
    finally:
        for connection in connections:
            connection.close()
        service.should_exit = True
        thread.join(timeout=15)


if __name__ == '__main__':
    main()

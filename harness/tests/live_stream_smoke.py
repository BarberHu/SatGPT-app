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
            'prompt': '先调用 gee_status 检查连接，然后用中文分六个短段落解释如何正确理解遥感降雨、土壤湿度和洪水图层。正文约500字，不要再调用其他Tool。',
            'bounds': [100, 10, 101, 11],
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
        history = request('GET', '/api/harness/conversation')['messages']
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
        assert live_reasoning, 'no provisional reasoning observed before settlement'
        assert all('task' not in x and 'trace' not in x for x in deltas)
        ids = [x['id'] for x in seen]
        assert ids == sorted(set(ids)), 'reconnect duplicated or reordered events'
        report = {'model': os.getenv('DSH_MODEL'), 'delta_events': len(deltas), 'reasoning_events': sum(e['type'] == 'reasoning.delta' for e in seen),
                  'live_reasoning_before_settlement': live_reasoning,
                  'first_delta_seconds': round(first_delta, 2),
                  'completion_seconds': round(time.monotonic() - started, 2),
                  'reconnect_passed': reconnected, 'refresh_snapshot_passed': snapshot_answer,
                  'one_final_history_message': True, 'timeline_rows': len(timeline), 'timeline_order_and_settlement': True,
                  'final_characters': len(replies[0]['content'])}
        (isolated / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=True))
    finally:
        for connection in connections:
            connection.close()
        service.should_exit = True
        thread.join(timeout=15)


if __name__ == '__main__':
    main()

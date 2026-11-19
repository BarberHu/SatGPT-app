"""Opt-in real Agent/GEE + SSE verification against region_page_server.

Run with AGENT_PORT set to the isolated server's port. Never prints answers,
credentials, tool payloads or layer URLs. Writes only a compact safe report.
"""
import json
import math
import re
import time
from pathlib import Path
from urllib.request import urlopen

from satgpt_config import load_project_env, integer
from harness.tests.test_analysis_region import TRIANGLE
from harness.tests.live_http import BrowserHttp


def verify_layer_reload(browser, conversation_id, task_id):
    path = f'/api/harness/conversations/{conversation_id}'
    before = browser.request('GET', path)['messages']
    original = next(message for message in before if message['job_id'] == task_id and message.get('layers'))
    original_layer = original['layers'][0]
    assert original_layer['reloadable'] and original_layer['code'], 'The test layer has no saved recipe'
    reloaded = browser.request('POST', f'{path}/layers/{task_id}-0/reload')['layer']
    assert all(reloaded[field] == original_layer[field] for field in ('code', 'generation', 'bounds', 'visualization'))
    assert reloaded['reload_version'] == original_layer.get('reload_version', 0) + 1

    after = browser.request('GET', path)['messages']
    assert [message['id'] for message in before] == [message['id'] for message in after]
    saved = next(message for message in after if message['id'] == original['id'])
    assert saved['layers'][0] == reloaded
    assert saved['layers'][1:] == original['layers'][1:]

    west, south, east, north = reloaded['bounds']
    zoom = 13
    tiles = 2 ** zoom
    x = int(((west + east) / 2 + 180) / 360 * tiles)
    latitude = math.radians((south + north) / 2)
    y = int((1 - math.asinh(math.tan(latitude)) / math.pi) / 2 * tiles)
    tile = reloaded['url'].replace('{z}', str(zoom)).replace('{x}', str(x)).replace('{y}', str(y))
    try:
        with urlopen(tile, timeout=30) as response:
            media = response.headers.get_content_type()
            header = response.read(12)
    except OSError:
        raise RuntimeError('Could not read the reloaded Earth Engine tile') from None
    is_image = (
        (media == 'image/png' and header.startswith(b'\x89PNG\r\n\x1a\n'))
        or (media == 'image/jpeg' and header.startswith(b'\xff\xd8\xff'))
        or (media == 'image/webp' and header.startswith(b'RIFF') and header[8:] == b'WEBP')
    )
    assert is_image, 'Reloaded tile was not a supported image'
    return {'reload_version': reloaded['reload_version'], 'tile_media_type': media}


def main():
    load_project_env()
    port = integer('AGENT_PORT')
    browser = BrowserHttp(port)
    request = browser.request

    cid = None
    assert request('GET', '/api/harness/conversations')['conversations'] == []
    report = {'conversation_isolated':True, 'cases':[]}
    def run(name, prompt, expect_tools, reconnect=False):
        nonlocal cid
        started = time.monotonic()
        job = request('POST', '/api/harness/tasks', {'prompt':prompt, 'bounds':[0,0,1,1],
                      'analysis_region':TRIANGLE, 'conversation_id':cid}, expected=202)
        assert job['conversation_id'] and (cid is None or job['conversation_id'] == cid)
        cid = job['conversation_id']
        assert [row['id'] for row in request('GET', '/api/harness/conversations')['conversations']] == [cid]
        # Same conversation cannot start a duplicate while this job is active.
        request('POST', '/api/harness/tasks', {'prompt':prompt, 'bounds':[0,0,1,1],
                'conversation_id':cid}, expected=409)
        events, cursor, reconnected = [], None, False
        while True:
            connection, response = browser.stream(job['id'], cursor)
            try:
                terminal = False
                while True:
                    line = response.readline().decode().strip()
                    if not line:
                        if response.isclosed(): break
                        continue
                    if not line.startswith('data: '): continue
                    event = json.loads(line[6:]); events.append(event); cursor = event['id']
                    if event['type'] == 'task' and event['patch'].get('status') in {'completed','failed','cancelled'}:
                        terminal = True; break
                    if event['type'] == 'snapshot' and event['task']['status'] in {'completed','failed','cancelled'}:
                        terminal = True; break
                    if reconnect and not reconnected and event['type'] == 'answer.delta':
                        reconnected = True; break
                if terminal: break
                if not reconnected: raise AssertionError('Unexpected SSE EOF')
            finally: connection.close()
        final = request('GET', f"/api/harness/tasks/{job['id']}")
        assert final['status'] == 'completed', 'Agent run failed; inspect private local trace'
        assert final['analysis_region'] == TRIANGLE
        history = request('GET', f'/api/harness/conversations/{cid}')['messages']
        users = [m for m in history if m['role']=='user' and m['job_id']==job['id']]
        answers = [m for m in history if m['role']=='assistant' and m['job_id']==job['id']]
        assert len(users) == len(answers) == 1
        assert users[0]['analysis_region'] == TRIANGLE
        assert answers[0]['content'] == final['output']['message']
        tools = [row for row in final['trace'] if row['kind']=='tool']
        assert bool(tools) == expect_tools
        assert all(tool['status']=='done' for tool in tools)
        ids = [event['id'] for event in events]
        assert ids == sorted(set(ids)), 'Repeated/reordered SSE events'
        if expect_tools:
            assert any('analysis_region' in row['arguments'] for row in tools)
        case = {'name':name, 'completed':True, 'tool_names':[row['name'] for row in tools],
                'one_user_and_final_message':True, 'snapshot_preserved':True,
                'answer_deltas':sum(e['type']=='answer.delta' for e in events),
                'reconnected':reconnected, 'seconds':round(time.monotonic()-started,1)}
        report['cases'].append(case)
        print(json.dumps(case), flush=True)
        return final, tools

    run('knowledge_without_GEE', 'In two sentences, what is NDVI? This is a general knowledge question.', False)
    result, tools = run('drawn_polygon_GEE_statistics_and_layer',
        "For this selected area, use NASA SRTM USGS/SRTMGL1_003. With gee_eval return a dictionary containing "
        "the exact geometry, polygon area in square meters and mean elevation in meters. Use the exact "
        "dictionary keys analysis_region_geojson, area_sq_m, and mean_elevation_m. Use "
        "analysis_region for clip and reduceRegion at scale=90, maxPixels=1000000. Then create one gee_layer "
        "clipped to analysis_region with bounds=[113.6,34.7,113.64,34.74], name='Selected area elevation', "
        "min=0,max=300,palette=['ffffff','449977'], metadata dataset_id=USGS/SRTMGL1_003 and unit=m. "
        "Explain actual scope in at most 80 words.", True, reconnect=True)
    evaluations = [row for row in tools if row['name']=='gee_eval']
    assert evaluations
    statistics = json.loads(evaluations[0]['result'])
    assert statistics['analysis_region_geojson'] == TRIANGLE, 'Worker returned a different geometry'
    assert 7_000_000 < statistics['area_sq_m'] < 9_000_000, 'Expected triangle area, not bounding rectangle'
    assert 0 < statistics['mean_elevation_m'] < 500
    assert result['output']['layers'], 'No real GEE layer'
    report['real_layer_and_exact_polygon_result'] = True
    report['polygon_area_sq_m'] = statistics['area_sq_m']
    report['mean_elevation_m'] = statistics['mean_elevation_m']
    report['layer_reload'] = verify_layer_reload(browser, cid, result['id'])
    conflict, _ = run('obvious_place_conflict_asks_before_tools',
                     'Calculate the mean elevation of Tokyo, Japan.', False)
    scope_choice = r'[?？]|\bplease\s+(?:choose|confirm|specify)\b'
    assert re.search(scope_choice, conflict['output']['message'], re.I), 'Expected a request to choose the analysis scope'
    confirmed, _ = run('confirmation_continues_without_repeated_question',
        'Use the currently selected drawn polygon. I confirm this scope; calculate its mean elevation '
        'using analysis_region and SRTM at scale=90. Report which scope you used in under 80 words.', True)
    assert '?' not in confirmed['output']['message'], 'Confirmation unnecessarily asked again'
    target = Path(__file__).resolve().parents[2] / 'outputs' / 'agent-region-live-report.json'
    target.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'report':str(target), 'passed':True}), flush=True)


if __name__ == '__main__': main()

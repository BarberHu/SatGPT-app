"""Opt-in real replay of a saved test layer; prints no credentials or tile URLs.

Start region_page_server --seed-history <old-test-chat-history.json> on an unused
AGENT_PORT, then run this module with that port. No model call is made here.
"""
import http.client
import json
import math
from pathlib import Path
from urllib.request import urlopen

from satgpt_config import load_project_env, integer


def main():
    load_project_env(); port = integer('AGENT_PORT')
    def request(method,path):
        connection = http.client.HTTPConnection('127.0.0.1',port,timeout=180)
        try:
            connection.request(method,path)
            response = connection.getresponse(); data = json.loads(response.read())
            assert response.status == 200, f'Unexpected HTTP status {response.status}'
            return data
        finally: connection.close()
    original = request('GET','/api/harness/conversation')
    cid = original['conversation_id']
    message = next(m for m in original['messages'] if m.get('layers'))
    layer = message['layers'][0]; layer_id = f"{message['job_id']}-0"
    assert layer['reloadable'] and layer['code']
    fresh = request('POST',f'/api/harness/conversations/{cid}/layers/{layer_id}/reload')['layer']
    assert fresh['generation'] == layer['generation']
    assert fresh['code'] == layer['code']
    assert fresh['bounds'] == layer['bounds']
    assert fresh['reload_version'] == layer.get('reload_version',0)+1
    history = request('GET',f'/api/harness/conversations/{cid}')
    assert len(history['messages']) == len(original['messages'])
    stored = next(m for m in history['messages'] if m['id']==message['id'])['layers'][0]
    assert stored['url'] == fresh['url']
    west,south,east,north = fresh['bounds']; z=13; n=2**z
    x = int(((west+east)/2+180)/360*n)
    latitude = math.radians((south+north)/2)
    y = int((1-math.asinh(math.tan(latitude))/math.pi)/2*n)
    tile = fresh['url'].replace('{z}',str(z)).replace('{x}',str(x)).replace('{y}',str(y))
    with urlopen(tile,timeout=30) as response: png=response.read(3_000_000)
    assert png.startswith(b'\x89PNG\r\n\x1a\n')
    report = {'real_gee_reload':True,'tile_png_received':True,'tile_bytes':len(png),
              'exact_original_code':True,'original_scope_and_visualization_preserved':True,
              'history_count_unchanged':True,'reload_version':fresh['reload_version'],
              'thumbnail_received':bool(fresh.get('thumbnail'))}
    target = Path(__file__).resolve().parents[2]/'outputs'/'layer-reload-live-report.json'
    target.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report),flush=True)


if __name__ == '__main__': main()

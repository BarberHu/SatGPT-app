"""复验 Ask Enter 提示与栅格参数错误码；要求真实服务已启动。"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.2:13000')
    parser.add_argument('--output', default='outputs/regression/ask-raster')
    args = parser.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='chrome')
        page = browser.new_page(viewport={'width': 1600, 'height': 1000}, timezone_id='Asia/Shanghai')
        page.goto(args.base_url, wait_until='domcontentloaded')
        field = page.get_by_placeholder('Type your prompt here')
        field.fill('Tell me about the 2021 Zhengzhou floods')
        field.press('Enter')
        dialog = page.get_by_role('dialog', name='Select Grid for Flood Data Visualization')
        expect(dialog).to_be_visible()
        page.wait_for_timeout(600)
        expect(dialog).to_be_visible()
        page.screenshot(path=str(out / 'enter-prompt-stays-open.png'))
        page.get_by_role('button', name='OK', exact=True).click()
        expect(dialog).to_have_count(0)
        results.append({'id': 'F01', 'status': 'PASS', 'title': 'Enter 提交后的 AOI 提示保持显示，可用 OK 正常关闭'})

        page.locator('.send-btn-gemini').click()
        expect(dialog).to_be_visible()
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        results.append({'id': 'F02', 'status': 'PASS', 'title': '鼠标发送与 Escape 关闭正常'})

        field.dispatch_event('keydown', {'key': 'Enter', 'isComposing': True})
        expect(dialog).to_have_count(0)
        results.append({'id': 'F03', 'status': 'PASS', 'title': '输入法确认 Enter 不触发提交'})

        for payload, message in [
            ({'layer_keys': ['NOT_A_LAYER']}, 'Unsupported agent raster layer'),
            ({}, 'at least one layer key'),
        ]:
            response = page.request.post(args.base_url + '/api/agent-raster-layers', data=payload)
            assert response.status == 400, f'{response.status}: {response.text()}'
            assert message in response.json()['detail'], response.text()
            results.append({'id': f'F0{len(results)+1}', 'status': 'PASS', 'title': '非法图层参数返回 400', 'detail': response.json()['detail']})

        geometry = {'type': 'Polygon', 'coordinates': [[[118.72, 31.98], [118.82, 31.98], [118.82, 32.08], [118.72, 32.08], [118.72, 31.98]]]}
        response = page.request.post(args.base_url + '/api/agent-raster-layers', data={
            'layer_keys': ['slopeSteepness'],
            'aoi': {'geojson': geometry},
        }, timeout=90000)
        assert response.status == 200, f'{response.status}: {response.text()}'
        assert response.json().get('eeMapURLSlopeSteepness')
        results.append({'id': 'F06', 'status': 'PASS', 'title': '错误请求后真实 GEE 坡度图层仍能返回 200'})
        browser.close()
    (out / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

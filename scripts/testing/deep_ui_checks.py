"""深层 UI/状态测试。故障注入项单独标注，不修改应用源码。"""
import argparse
import io
import json
import os
import re
import time
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

os.environ.setdefault('PW_TEST_SCREENSHOT_NO_FONTS_READY', '1')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.2:13000')
    parser.add_argument('--output', default='outputs/regression/ui')
    parser.add_argument('--only', nargs='*', help='只运行指定用例 ID')
    args = parser.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    fixture_dir = out/'fixtures'
    fixture_dir.mkdir(exist_ok=True)
    valid = {'type': 'Polygon', 'coordinates': [[[118.72,31.98],[118.82,31.98],[118.82,32.08],[118.72,32.08],[118.72,31.98]]]}
    second = {'type':'Polygon','coordinates':[[[118.9,32.1],[118.95,32.1],[118.95,32.15],[118.9,32.15],[118.9,32.1]]]}
    geometries = {
        'deep_a': valid, 'deep_b': second,
        'one_point': {'type':'Polygon','coordinates':[[[118.8,32.0]]]},
        'zero_area': {'type':'Polygon','coordinates':[[[118.8,32],[118.8,32],[118.8,32],[118.8,32]]]},
        'projected_meters': {'type':'Polygon','coordinates':[[[13200000,3750000],[13201000,3750000],[13201000,3751000],[13200000,3751000],[13200000,3750000]]]},
        'null_coords': {'type':'Polygon','coordinates':[[[None,None],[118.8,32],[118.9,32],[None,None]]]},
        'multi': {'type':'MultiPolygon','coordinates':[valid['coordinates'],second['coordinates']]},
    }
    for name, geometry in geometries.items():
        (fixture_dir/f'{name}.geojson').write_text(json.dumps(geometry), encoding='utf-8')
    with zipfile.ZipFile(fixture_dir/'not_a_shapefile.zip','w') as archive:
        archive.writestr('readme.txt','not a shape file')
    results = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='chrome')

        def setup():
            context = browser.new_context(viewport={'width':1600,'height':1000},timezone_id='Asia/Shanghai',accept_downloads=True)
            page = context.new_page()
            page.set_default_timeout(12000)
            page.set_default_navigation_timeout(60000)
            errors = []
            page.on('pageerror',lambda e: errors.append(str(e)))
            page.goto(args.base_url,wait_until='commit')
            page.get_by_role('button',name='Switch to Agent mode').wait_for(timeout=60000)
            page.get_by_role('button',name='Switch to Agent mode').click()
            expect(page.locator('.agent-chat-textarea')).to_be_enabled(timeout=45000)
            return context,page,errors

        def module(page,title):
            page.get_by_title(title,exact=True).click()
            expect(page.get_by_title(title,exact=True)).to_have_attribute('aria-pressed','true')

        def upload(page,name):
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button',name='Upload spatial scope',exact=True).click()
            chooser.value.set_files(str(fixture_dir/name))
            page.wait_for_timeout(300)

        def item(page,name):
            return page.locator('.layer-manager-item').filter(has=page.locator('.layer-manager-item-title',has_text=re.compile('^'+re.escape(name)+'$')))

        def run(ident,title,fn,kind='REAL UI'):
            if args.only and ident not in args.only:
                return
            start=time.monotonic()
            record={'id':ident,'title':title,'kind':kind}
            context=page=None
            try:
                context,page,errors=setup()
                record['details']=fn(page,context,errors) or {}
                record['page_errors']=errors
                record['status']='PASS'
            except Exception as exc:
                record['status']='FAIL'
                record['error']=str(exc)[:3000]
                if page:
                    record['page_errors']=errors
            finally:
                if page:
                    try:
                        page.screenshot(path=str(out/f'{ident}.png'),timeout=12000)
                        (out/f'{ident}-dom.txt').write_text(page.locator('body').inner_text(),encoding='utf-8')
                    except Exception as artifact_error:
                        record['evidence_error']=str(artifact_error)[:500]
                if context:
                    context.close()
            record['seconds']=round(time.monotonic()-start,2)
            results.append(record)
            (out/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
            print(f'{ident} {record["status"]} {title}: {str(record.get("details",record.get("error","")))[:350]}',flush=True)

        def persistence(page,context,errors):
            module(page,'Vector Layers')
            upload(page,'deep_a.geojson')
            upload(page,'deep_b.geojson')
            page.get_by_role('checkbox',name='Toggle deep_a',exact=True).uncheck()
            page.wait_for_timeout(900)
            page.reload(wait_until='commit')
            page.get_by_role('button',name='Switch to Agent mode').wait_for(timeout=60000)
            page.wait_for_timeout(700)
            page.get_by_role('button',name='Switch to Agent mode').click()
            module(page,'Vector Layers')
            expect(item(page,'deep_a')).to_be_visible()
            expect(item(page,'deep_b')).to_contain_text('Active analysis scope')
            expect(page.get_by_role('checkbox',name='Toggle deep_a',exact=True)).not_to_be_checked()
            module(page,'Landslide Analysis')
            expect(page.get_by_role('checkbox',name='Toggle Slope Steepness',exact=True)).to_be_enabled()
            return {'restored_layers':2,'active_aoi_enabled_for_analysis':True}
        run('D01','刷新后 AOI 与可见性恢复',persistence)

        def deletion(page,context,errors):
            module(page,'Vector Layers')
            upload(page,'deep_a.geojson')
            upload(page,'deep_b.geojson')
            item(page,'deep_b').get_by_role('button',name='Delete',exact=True).click()
            expect(item(page,'deep_a')).to_contain_text('Active analysis scope')
            item(page,'deep_a').get_by_role('button',name='Delete',exact=True).click()
            module(page,'Landslide Analysis')
            expect(page.get_by_role('checkbox',name='Toggle Slope Steepness',exact=True)).to_be_disabled()
        run('D02','删除活动 AOI 的回退与全部删除',deletion)

        for ident,name in [('D03','one_point'),('D04','zero_area'),('D05','projected_meters'),('D06','null_coords')]:
            def invalid(page,context,errors,name=name):
                module(page,'Vector Layers')
                upload(page,'deep_a.geojson')
                upload(page,name+'.geojson')
                page.wait_for_timeout(500)
                observations={'invalid_layer_added':item(page,name).count()>0,'warning':page.locator('.warnings').inner_text() if page.locator('.warnings').count() else None,'page_errors':list(errors)}
                assert not observations['invalid_layer_added'],json.dumps(observations,ensure_ascii=False)
                expect(item(page,'deep_a')).to_contain_text('Active analysis scope')
                assert not errors,errors
                return observations
            run(ident,'异常 GeoJSON 应拒绝：'+name,invalid)

        def multipolygon(page,context,errors):
            module(page,'Vector Layers')
            upload(page,'multi.geojson')
            expect(item(page,'multi')).to_contain_text('Active analysis scope')
            assert not errors,errors
            return {'multi_polygon_accepted':True}
        run('D07','合法 MultiPolygon 上传',multipolygon)

        def zip_recovery(page,context,errors):
            module(page,'Vector Layers')
            upload(page,'not_a_shapefile.zip')
            expect(page.locator('.warnings')).to_be_visible()
            upload(page,'deep_a.geojson')
            expect(item(page,'deep_a')).to_contain_text('Active analysis scope')
            expect(page.locator('.warnings')).to_have_count(0)
        run('D08','错误 ZIP 后重新上传恢复',zip_recovery)

        def draw_save(page,context,errors):
            module(page,'Vector Layers')
            upload(page,'deep_a.geojson')
            page.wait_for_timeout(1200)
            page.get_by_title('Polygon tool (3)',exact=True).wait_for(timeout=60000)
            page.get_by_title('Polygon tool (3)',exact=True).click()
            for x,y in [(600,400),(800,400),(800,600),(600,400)]:
                page.mouse.move(x,y,steps=10)
                page.mouse.down()
                page.wait_for_timeout(75)
                page.mouse.up()
                page.wait_for_timeout(350)
            page.get_by_role('button',name='Save',exact=True).click()
            expect(page.locator('.layer-manager-item-title').filter(has_text='draw_scope_')).to_be_visible()
            page.get_by_role('button',name='Start a new agent conversation').click()
            module(page,'Vector Layers')
            expect(page.locator('.layer-manager-item-title').filter(has_text='draw_scope_')).to_be_visible()
            return {'draw_scope_preserved_in_new_chat':True}
        run('D09','绘制保存与新会话保留范围',draw_save)

        def reorder(page,context,errors):
            upload(page,'deep_a.geojson')
            module(page,'Landslide Analysis')
            first=page.get_by_role('button',name='Drag to reorder Landslide Risk',exact=True)
            target=page.locator('.layer-manager-item').filter(has=page.get_by_role('button',name='Drag to reorder Slope Steepness',exact=True))
            box=target.bounding_box()
            first.drag_to(target,target_position={'x':box['width']/2,'y':box['height']-8})
            titles=page.locator('.layer-manager-item-title').all_text_contents()
            assert titles.index('Slope Steepness')<titles.index('Landslide Risk'),titles
            return {'order':titles}
        run('D10','图层拖动排序',reorder)

        def raster_retry(page,context,errors):
            upload(page,'deep_a.geojson')
            module(page,'Landslide Analysis')
            page.route('**/api/agent-raster-layers',lambda route:route.fulfill(status=503,json={'detail':'Injected temporary raster failure'}))
            toggle=page.get_by_role('checkbox',name='Toggle Slope Steepness',exact=True)
            toggle.check()
            expect(page.locator('.warnings')).to_contain_text('Injected temporary raster failure')
            expect(page.locator('.layer-manager-item').filter(has=toggle)).to_have_attribute('aria-busy','false')
            toggle.uncheck()
            page.unroute('**/api/agent-raster-layers')
            with page.expect_response(lambda r:'/api/agent-raster-layers' in r.url,timeout=90000) as pending:
                toggle.check()
            assert pending.value.status==200,pending.value.text()[:400]
            expect(page.locator('.warnings')).to_have_count(0)
            return {'injected_status':503,'retry_live_status':200}
        run('D11','栅格请求失败后重试',raster_retry,'FAULT INJECTION + LIVE RECOVERY')

        def no_auto_reload(page,context,errors):
            upload(page,'deep_a.geojson')
            upload(page,'deep_b.geojson')
            module(page,'Vector Layers')
            item(page,'deep_a').locator('.layer-manager-item-trigger').click()
            page.wait_for_timeout(800)
            module(page,'Landslide Analysis')
            with page.expect_response(lambda r:'/api/agent-raster-layers' in r.url,timeout=90000) as pending:
                page.get_by_role('checkbox',name='Toggle Slope Steepness',exact=True).check()
            assert pending.value.status==200
            module(page,'Vector Layers')
            with page.expect_response(lambda r:'/api/agent-raster-layers' in r.url,timeout=90000) as next_response:
                item(page,'deep_b').locator('.layer-manager-item-trigger').click()
                module(page,'Landslide Analysis')
            assert next_response.value.status==200,next_response.value.text()[:400]
            request_aoi=json.loads(next_response.value.request.post_data_json['aoi'])
            assert request_aoi['label']=='deep_b',request_aoi['label']
            checkbox=page.get_by_role('checkbox',name='Toggle Slope Steepness',exact=True)
            expect(checkbox).to_be_checked()
            expect(checkbox).to_have_class(re.compile(r'is-ready'),timeout=60000)
            detail_button=page.get_by_role('button',name='Layer information: Slope Steepness',exact=True)
            detail_button.click()
            details=page.get_by_role('dialog').inner_text()
            observation={'checkbox_checked':True,'new_aoi_response':next_response.value.status,'requested_scope':request_aoi['label'],'detail_text':details[:1000]}
            assert 'Visible' in details,details
            return observation
        run('D12','切换 AOI 后已勾选的坡度图层更新',no_auto_reload)

        def download_retry(page,context,errors):
            upload(page,'deep_a.geojson')
            module(page,'Landslide Analysis')
            page.get_by_role('button',name='Layer information: Slope Steepness',exact=True).click()
            page.route('**/api/agent-raster-download-file',lambda route:route.fulfill(status=503,json={'detail':'Injected download failure'}))
            page.get_by_role('button',name='Download AOI GeoTIFF',exact=True).click()
            expect(page.get_by_role('dialog')).to_contain_text('Injected download failure')
            expect(page.get_by_role('button',name='Download AOI GeoTIFF',exact=True)).to_be_enabled()
            page.unroute('**/api/agent-raster-download-file')
            with page.expect_download(timeout=90000) as pending:
                page.get_by_role('button',name='Download AOI GeoTIFF',exact=True).click()
            pending.value.save_as(str(out/'retry-slope.tif'))
            assert (out/'retry-slope.tif').read_bytes()[:4] in (b'MM\x00*',b'II*\x00')
            return {'recovered_download_bytes':(out/'retry-slope.tif').stat().st_size}
        run('D13','GeoTIFF 下载失败后重试',download_retry,'FAULT INJECTION + LIVE RECOVERY')

        def search_retry(page,context,errors):
            page.route('**/api/location-search',lambda route:route.fulfill(status=503,json={'detail':'Injected location failure'}))
            field=page.get_by_placeholder('e.g. Guangxi, China')
            field.fill('Nanjing, China')
            page.get_by_role('button',name='Search places',exact=True).click()
            expect(page.locator('.location-scope-picker-feedback')).to_contain_text('Injected location failure')
            page.unroute('**/api/location-search')
            with page.expect_response(lambda r:'/api/location-search' in r.url,timeout=90000) as pending:
                page.get_by_role('button',name='Search places',exact=True).click()
            assert pending.value.status==200
            expect(page.locator('.location-scope-candidate').first).to_be_visible()
            return {'candidates':page.locator('.location-scope-candidate').count()}
        run('D14','地名搜索失败后重试',search_retry,'FAULT INJECTION + LIVE RECOVERY')

        def catalog_retry(page,context,errors):
            upload(page,'deep_a.geojson')
            page.route('**/api/recommended-layer-render',lambda route:route.fulfill(status=503,json={'detail':'Injected catalog failure'}))
            checkbox=page.get_by_role('checkbox',name='Toggle JRC Yearly Water Classification',exact=True)
            checkbox.check()
            expect(page.locator('.warnings')).to_contain_text('Injected catalog failure')
            checkbox.uncheck()
            page.unroute('**/api/recommended-layer-render')
            with page.expect_response(lambda r:'/api/recommended-layer-render' in r.url,timeout=90000) as pending:
                checkbox.check()
            assert pending.value.status==200,pending.value.text()[:300]
            expect(checkbox).to_have_class(re.compile(r'is-ready'),timeout=30000)
            warning=page.locator('.warnings').inner_text() if page.locator('.warnings').count() else ''
            assert 'Injected catalog failure' not in warning, '重试已成功、复选框已 Ready，但仍显示上一次失败警告：'+warning
            return {'retry_status':200,'old_error_cleared':True}
        run('D15','目录图层重试成功后清除失败状态',catalog_retry,'FAULT INJECTION + LIVE RECOVERY')

        def stop_chat(page,context,errors):
            field=page.locator('.agent-chat-textarea')
            field.fill('请介绍洪水遥感分析的基本方法。')
            page.get_by_role('button',name='Send message',exact=True).click()
            page.get_by_role('button',name='Stop generating',exact=True).click(timeout=15000)
            expect(page.get_by_role('button',name='Send message',exact=True)).to_be_visible(timeout=30000)
            expect(field).to_be_enabled()
            field.fill('请只回复一句：测试连接正常。')
            page.get_by_role('button',name='Send message',exact=True).click()
            expect(page.locator('.copilotKitAssistantMessage').last).to_contain_text(re.compile(r'测试连接正常|test connection.*(?:normal|success)',re.I),timeout=90000)
            expect(page.get_by_role('button',name='Stop generating',exact=True)).to_have_count(0,timeout=30000)
            return {'stop_and_next_message':'usable'}
        run('D16','Agent 停止生成后继续对话',stop_chat)

        def imagery_unmount(page,context,errors):
            upload(page,'deep_a.geojson')
            module(page,'Optical and SAR Imagery')
            page.locator('input[aria-label="Start"]:visible').fill('2024-07-01')
            page.locator('input[aria-label="End"]:visible').fill('2024-07-31')
            page.get_by_role('button',name='Apply imagery window',exact=True).click()
            module(page,'Vector Layers')
            module(page,'Optical and SAR Imagery')
            expect(page.get_by_role('button',name='Apply imagery window',exact=True)).to_be_enabled(timeout=20000)
            return {'loading_state_recovered_after_module_switch':True}
        run('D17','影像加载中切换模块后恢复操作',imagery_unmount)

        browser.close()
    print(json.dumps({'total':len(results),'passed':sum(r['status']=='PASS' for r in results),'failed':sum(r['status']=='FAIL' for r in results)},ensure_ascii=False))
    return int(any(r['status']=='FAIL' for r in results))


if __name__=='__main__':
    raise SystemExit(main())

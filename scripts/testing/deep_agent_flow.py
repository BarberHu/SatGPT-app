"""真实 Agent 事件确认、报告与导出流程探测；输出阶段进度和 DOM 证据。"""
import argparse
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.2:13000')
    parser.add_argument('--output', default='outputs/regression/agent-flow')
    parser.add_argument('--confirmation-only', action='store_true', help='仅验证确认日期与取消，不等待尚未接通的报告流程')
    args = parser.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    records = []
    started = time.monotonic()

    def save(phase, **data):
        records.append({'phase': phase, 'seconds': round(time.monotonic()-started, 2), **data})
        (out/'results.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(records[-1], ensure_ascii=False), flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel='chrome')
        context = browser.new_context(viewport={'width': 1600, 'height': 1000}, timezone_id='Asia/Shanghai', accept_downloads=True)
        page = context.new_page()
        page.set_default_timeout(15000)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        try:
            page.goto(args.base_url, wait_until='commit', timeout=60000)
            page.get_by_role('button', name='Switch to Agent mode').wait_for(timeout=60000)
            page.get_by_role('button', name='Switch to Agent mode').click()
            fixture = out/'deep_zhengzhou.geojson'
            fixture.write_text(json.dumps({'type':'Polygon','coordinates':[[[113.6,34.7],[113.7,34.7],[113.7,34.8],[113.6,34.8],[113.6,34.7]]]}), encoding='utf-8')
            with page.expect_file_chooser() as chooser:
                page.get_by_role('button', name='Upload spatial scope', exact=True).click()
            chooser.value.set_files(str(fixture))
            field = page.locator('.agent-chat-textarea')
            field.fill('@deep_zhengzhou')
            page.locator('.agent-mention-option').first.click()
            field.press('End')
            field.type(' 请分析2021年7月郑州洪水。灾前日期2021-07-10，洪峰2021-07-20，灾后2021-07-30。使用引用的空间范围进行分析，先让我确认事件和图层。', delay=1)
            page.get_by_role('button', name='Send message', exact=True).click()
            save('event-request-sent')
            modal = page.locator('.event-confirmation-modal')
            modal.wait_for(state='visible', timeout=180000)
            page.screenshot(path=str(out/'event-confirmation.png'))
            (out/'confirmation-text.txt').write_text(modal.inner_text(), encoding='utf-8')
            save('confirmation-open', checkboxes=modal.locator('input[type=checkbox]').count())

            page.get_by_title('Edit fields', exact=True).click()
            dates = modal.locator('input[type=date]')
            original = [d.input_value() for d in dates.all()]
            dates.nth(0).fill('2021-08-01')
            dates.nth(1).fill('2021-07-20')
            dates.nth(2).fill('2021-07-01')
            can_confirm_reversed = page.get_by_role('button', name='Confirm', exact=True).is_enabled()
            page.screenshot(path=str(out/'reversed-event-dates.png'))
            save('date-validation', expected='reversed dates must block confirmation', actual_confirm_enabled=can_confirm_reversed, status='FAIL' if can_confirm_reversed else 'PASS')
            assert not can_confirm_reversed,'Reversed event dates still allow confirmation'
            for field, value in zip(dates.all(), original):
                field.fill(value)
            selected = [c.is_checked() for c in modal.locator('input[type=checkbox]').all()]
            for checkbox in modal.locator('input[type=checkbox]').all():
                checkbox.uncheck()
            expect(page.get_by_role('button', name='Confirm', exact=True)).to_be_disabled()
            for checkbox, checked in zip(modal.locator('input[type=checkbox]').all(), selected):
                checkbox.set_checked(checked)
            save('empty-layer-selection', status='PASS')

            if args.confirmation_only:
                page.get_by_role('button', name='Cancel', exact=True).click()
                expect(modal).to_have_count(0)
                expect(page.get_by_role('button', name='Stop generating', exact=True)).to_have_count(0,timeout=60000)
                save('confirmation-cancel',status='PASS')
                return 0

            page.get_by_role('button', name='Confirm', exact=True).click()
            expect(modal).to_have_count(0)
            save('confirmed-normal-event')
            # 报告生成与数据加载并非同一阶段，分别等待最终消息与下载按钮。
            page.get_by_role('button', name='DOWNLOAD GEE CODE', exact=True).wait_for(state='visible')
            expect(page.get_by_role('button', name='DOWNLOAD GEE CODE', exact=True)).to_be_enabled(timeout=180000)
            expect(page.get_by_role('button', name='Stop generating', exact=True)).to_have_count(0, timeout=180000)
            page.screenshot(path=str(out/'completed-event.png'))
            (out/'completed-text.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
            with page.expect_download(timeout=30000) as pending:
                page.get_by_role('button', name='DOWNLOAD GEE CODE', exact=True).click()
            target = out/pending.value.suggested_filename
            pending.value.save_as(str(target))
            code = target.read_text(encoding='utf-8')
            save('agent-report-and-gee-export', status='PASS' if 'ee.' in code else 'FAIL', filename=target.name, bytes=target.stat().st_size, page_errors=errors)
            # 新会话应退出事件状态而保留空间范围。
            page.get_by_role('button', name='Start a new agent conversation').click()
            save('new-chat-after-analysis', status='PASS', text=page.locator('.agent-chat-pane__messages').inner_text()[:600])
        except Exception as exc:
            save('flow-error', status='FAIL', error=str(exc)[:3000], page_errors=errors)
            (out/'last-text.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
            page.screenshot(path=str(out/'failure.png'))
        finally:
            browser.close()
    return int(any(record.get('status')=='FAIL' for record in records))


if __name__ == '__main__':
    raise SystemExit(main())

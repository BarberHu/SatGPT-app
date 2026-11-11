import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harness.tests.live_legacy_layer_reloads import run_one, save, tile_format, verify_saved


def conversation():
    return {'conversation_id': 'webgis-old', 'messages': [
        {'id': 'question', 'content': 'Original question', 'analysis_region': {'type': 'Polygon'}},
        {'id': 'answer', 'job_id': 'job', 'content': 'Original answer', 'layers': [
            {'name': 'one', 'code': 'result = ee.Image(1)', 'generation': {'version': 1, 'code': 'result = ee.Image(1)'},
             'bounds': [100, 10, 101, 11], 'url': 'old', 'reload_version': 0},
            {'name': 'other', 'url': 'other'}]}]}


class LiveLegacyVerificationTests(unittest.TestCase):
    def test_jpeg_and_webp_are_valid_but_html_or_mismatched_media_are_not(self):
        self.assertEqual(tile_format(b'\xff\xd8\xff\xe0', 'image/jpeg'), 'JPEG')
        self.assertEqual(tile_format(b'RIFF0000WEBPdata', 'image/webp'), 'WebP')
        self.assertEqual(tile_format(b'\x89PNG\r\n\x1a\n', 'image/png'), 'PNG')
        for data, media in [(b'<html>error</html>', 'image/png'), (b'\xff\xd8\xff', 'image/png')]:
            with self.assertRaises(ValueError):
                tile_format(data, media)

    def test_interrupted_request_is_reconciled_without_second_post(self):
        before = conversation()
        after = copy.deepcopy(before)
        after['messages'][1]['layers'][0].update(url='new', reload_version=1)
        row = {'conversation_id': 'webgis-old', 'layer_id': 'job-0', 'status': 'submitting',
               'attempts': [{'error': 'Connection lost after submission'}]}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            save(directory / 'private-before-webgis-old-job-0.json', before)
            with patch('harness.tests.live_legacy_layer_reloads.request', return_value=after) as api, \
                 patch('harness.tests.live_legacy_layer_reloads.probe_tile', return_value={'ok': True, 'format': 'JPEG'}):
                run_one('http://127.0.0.1:3000', directory, row, lambda: None)
            self.assertEqual(api.call_count, 1)
            self.assertEqual(api.call_args.args, ('http://127.0.0.1:3000', '/api/harness/conversations/webgis-old'))
        self.assertEqual(row['status'], 'passed')

    def test_verification_rejects_changed_scope_messages_and_other_layers(self):
        before = conversation()
        after = copy.deepcopy(before)
        after['messages'][1]['layers'][0].update(url='new', reload_version=1)
        self.assertEqual(verify_saved(before, after, 'job-0')['url'], 'new')
        mutations = [lambda d: d['messages'][0].update(content='Another question'),
                     lambda d: d['messages'][1]['layers'][0].update(bounds=[0, 0, 1, 1]),
                     lambda d: d['messages'][1]['layers'][0].update(visualization={'min': 9}),
                     lambda d: d['messages'][1]['layers'][1].update(url='overwritten')]
        for mutate in mutations:
            broken = copy.deepcopy(after)
            mutate(broken)
            with self.assertRaises(AssertionError):
                verify_saved(before, broken, 'job-0')


if __name__ == '__main__':
    unittest.main()

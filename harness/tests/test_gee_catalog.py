import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

from harness.app import gee_catalog


class GeeCatalogTests(unittest.TestCase):
    def test_stale_budget_and_failed_rebuild_preserve_valid_snapshot(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = gee_catalog.index_path(root)
            row = {'id': 'SENTINEL', 'title': 'Sentinel', 'keywords': ['optical'], 'text': 'Earth imagery'}
            now = int(time.time())
            value = {'fetched_at': now - gee_catalog.STAC_TTL_SECONDS - 3, 'count': 1, 'items': [row]}
            path.write_text(json.dumps(value), encoding='utf8')
            cached = gee_catalog.read_cached('optical', cache_dir=root)
            self.assertEqual(cached['cache_state'], 'stale')
            self.assertEqual(cached['matches'], [{key: data for key, data in row.items() if key != 'text'}])
            with patch.object(gee_catalog, '_build_index', return_value={'items': []}):
                with self.assertRaisesRegex(ValueError, 'invalid'):
                    gee_catalog.rebuild(root)
            self.assertEqual(json.loads(path.read_text(encoding='utf8')), value)
            path.write_text(json.dumps({**value, 'fetched_at': now - gee_catalog.STAC_MAX_AGE_SECONDS}), encoding='utf8')
            self.assertEqual(gee_catalog.read_cached(cache_dir=root), {'cache_state': 'missing'})

    def test_retries_incomplete_upstream_documents_before_replacing_index(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            root_url = f"{gee_catalog.STAC_BASE}/catalog.json"
            index = gee_catalog.index_path(root)
            old = {'fetched_at': int(time.time()), 'count': 1,
                   'items': [{'id': 'old', 'title': 'Old', 'keywords': []}]}
            index.write_text(json.dumps(old), encoding='utf8')

            def upstream(url):
                return {root_url: {'links': [{'rel': 'child', 'href': 'publisher'}]},
                        'publisher': {'links': [{'rel': 'child', 'href': 'dataset'}]},
                        'dataset': None}[url]

            with patch.object(gee_catalog, '_get_json', side_effect=upstream) as requests:
                with self.assertRaisesRegex(RuntimeError, 'incomplete index'):
                    gee_catalog.rebuild(root)
                self.assertEqual([call.args[0] for call in requests.call_args_list].count('dataset'), 2)
            self.assertEqual(json.loads(index.read_text(encoding='utf8')), old)

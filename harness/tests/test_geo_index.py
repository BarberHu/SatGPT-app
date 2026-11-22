import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from harness.app.context_guard import recovery_summary, safe_text, summary
from harness.app.geo_index import artifact_directory, get, index_area, publish, search
from harness.app.session_store import SessionStore, encode


GEOMETRY = {'type': 'Polygon', 'coordinates': [[[106.74, -6.20], [106.86, -6.20], [106.83, -6.13],
                                              [106.74, -6.20]]]}
BOUNDS = [106.74, -6.20, 106.86, -6.13]


class SpatialIndexTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'sessions.sqlite3'
        self.store = SessionStore(self.path)
        with self.store.connect(write=True) as db:
            self.cid = self.store.new(db, 'owner')
            self.other = self.store.new(db, 'owner')
            self.outsider = self.store.new(db, 'someone_else')
        self.first = self.task('a' * 32)

    def task(self, task, cid=None, owner='owner'):
        cid = cid or self.cid
        job = {'id': task, 'conversation_id': cid, 'status': 'running', 'bounds': BOUNDS, 'analysis_region': GEOMETRY,
               'analysis_aoi': {'label': '雅加达测试研究区'}, 'created_at': '2026-01-01T00:00:00Z'}
        with self.store.connect(write=True) as db:
            db.execute('INSERT INTO tasks(id,conversation_id,owner,request_id,fingerprint,status,receipt) VALUES(?,?,?,?,?,?,?)',
                       (task, cid, owner, task, task, 'running', encode(job)))
            area_ref = index_area(db, owner, job)
            self.assertEqual(area_ref, index_area(db, owner, job))
        return {'db': str(self.path), 'owner': owner, 'conversation_id': cid, 'task_id': task, 'area_ref': area_ref}

    def flood(self, context, ref, date):
        folder = artifact_directory(context, context['task_id'])
        folder.mkdir(parents=True, exist_ok=True)
        for extension in ('json', 'npy'):
            (folder / f'flood-{ref}.{extension}').write_bytes(b'fixture')
        return publish(context, 'flood', ref, {'event': 'Jakarta New Year flood', 'observed_at': date,
            'crs': 'EPSG:32748', 'scale': 10, 'observed_fraction': 1},
            {'bounds': BOUNDS, 'analysis_region': GEOMETRY, 'area_ref': context['area_ref']})

    def complete(self, context, status='completed'):
        with self.store.connect(write=True) as db:
            db.execute('UPDATE tasks SET status=? WHERE id=?', (status, context['task_id']))

    def test_search_reuses_old_results_without_recent_messages(self):
        old = self.flood(self.first, '1' * 32, '2020-01-02')
        newer = self.flood(self.first, '2' * 32, '2021-01-02')
        self.assertEqual(len(search(self.first, {'kind': 'flood'})['results']), 2)
        self.complete(self.first)
        self.second = self.task('b' * 32)
        # The index is independent of the browser's recent message window.
        with self.store.connect(write=True) as db:
            self.store.save_messages(db, self.cid, [{'role': 'user', 'content': 'unrelated'}] * 110)
        with self.store.connect() as db:
            self.assertEqual(len(json.loads(self.store.owned(db, 'owner', self.cid)['messages'])), 100)
        found = search(self.second, {'kind': 'flood', 'query': '雅加达洪水',
                    'start': '2020-01-01', 'end': '2020-01-03', 'area_ref': self.second['area_ref']})['results']
        self.assertEqual([item['data_ref'] for item in found], [old])
        self.assertEqual(found[0]['spatial_match'], 'covers_area')
        self.assertNotIn('geometry', found[0])
        self.assertNotIn('legacy_ref', found[0])
        self.assertEqual(get(self.second, old, ('flood',))['geometry'], GEOMETRY)
        self.assertEqual(len(search(self.second, {'query': 'Jakarta flood'})['results']), 2)
        self.assertNotEqual(old, newer)

    def test_rejects_cancelled_missing_cross_conversation_and_wrong_kind(self):
        ref = self.flood(self.first, '1' * 32, '2020-01-02')
        self.complete(self.first)
        self.second = self.task('b' * 32)
        for context in (self.task('c' * 32, self.other), self.task('d' * 32, self.outsider, 'someone_else')):
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                get(context, ref)
        with self.assertRaisesRegex(ValueError, 'wrong type'):
            get(self.second, ref, ('area',))
        (artifact_directory(self.first, self.first['task_id']) / f"flood-{'1' * 32}.npy").unlink()
        self.assertEqual(search(self.second, {'kind': 'flood'})['results'][0]['status'], 'missing')
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            get(self.second, ref)
        self.complete(self.first, 'cancelled')
        self.assertEqual(search(self.second, {'kind': 'flood'})['results'], [])

    def test_building_and_poi_references_share_the_file_and_preserve_type_and_ownership(self):
        folder = artifact_directory(self.first, self.first['task_id'])
        folder.mkdir(parents=True)
        area = {'bounds': BOUNDS, 'analysis_region': GEOMETRY, 'label': '雅加达测试研究区'}
        refs = {}
        for kind, artifact in (('buildings', '1' * 32), ('pois', '2' * 32)):
            (folder / f'{artifact}.geojson').write_bytes(b'fixture')
            refs[kind] = publish(self.first, kind, artifact, {'count': 1, 'category': 'school' if kind == 'pois' else None,
                                'source_mode': 'overpass', 'osm_data_time': '2026-01-01'}, area)
        self.complete(self.first)
        second = self.task('b' * 32)
        buildings = search(second, {'kind': 'buildings', 'query': '雅加达建筑'})['results']
        self.assertEqual([item['data_ref'] for item in buildings], [refs['buildings']])
        self.assertNotIn('geometry', buildings[0])
        self.assertNotIn('legacy_ref', buildings[0])
        self.assertEqual(get(second, refs['pois'], ('pois',))['legacy_ref'], '2' * 32)
        for invalid_context, expected_kind in ((second, 'buildings'), (self.task('c' * 32, self.other), 'pois'),
                                               (self.task('d' * 32, self.outsider, 'someone_else'), 'pois')):
            with self.subTest(kind=expected_kind, task=invalid_context['task_id']), self.assertRaises(ValueError):
                get(invalid_context, refs['pois'], (expected_kind,))
        (folder / f"{'2' * 32}.geojson").unlink()
        self.assertEqual(search(second, {'kind': 'pois'})['results'][0]['status'], 'missing')
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            get(second, refs['pois'], ('pois',))

    def test_prompts_and_general_results_block_payloads_but_keep_metadata(self):
        raw = json.dumps(GEOMETRY)
        self.assertNotIn(raw, safe_text('Analyze: ' + raw))
        self.assertEqual(safe_text('Source: https://example.org/indonesia'), 'Source: https://example.org/indonesia')
        recovered = recovery_summary([{'role': 'user', 'content': raw}, {'role': 'user', 'content': 'Use data'}], 'unused')
        self.assertNotIn(raw, json.dumps(recovered))
        for result in (GEOMETRY, {'records': [{'type': 'Feature', 'geometry': GEOMETRY}]},
                       {'unlabeled_values': [[1, 0], [2, 1]]}, {'raw': raw}, {'file_path': 'x'}):
            with self.subTest(result=result), self.assertRaises(ValueError):
                summary(result)
        metadata = {'observed': ['2019-12-21', '2020-01-02'], 'areas_m2': [4800.0, 0.0], 'count': 2}
        self.assertEqual(summary(metadata), metadata)

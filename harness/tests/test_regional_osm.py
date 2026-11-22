import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from shapely.geometry import LineString, shape

from harness.app.osm_queries import OverpassQueries
from harness.app.osm_transport import RoadNetworkError
from harness.app.osm_worker import execute


@unittest.skipUnless(importlib.util.find_spec('osmium'), 'Offline importer requires osmium')
class RegionalOSMTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        import osmium
        from scripts.import_osm_snapshot import build

        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        osm = self.root / 'fixture.osm'
        nodes = [(10.001, 20.001), (10.008, 20.001), (10.008, 20.008), (10.001, 20.008),
                 (10.003, 20.003), (10.005, 20.003), (10.005, 20.005), (10.003, 20.005),
                 (9.998, 20.002), (10.018, 20.002), (10.012, 20.001), (10.013, 20.001),
                 (10.013, 20.002), (10.012, 20.002)]
        node_xml = [f'<node id="{index}" lon="{x}" lat="{y}"/>'
                    for index, (x, y) in enumerate(nodes, 1)]

        def way(identifier, refs, key='', value=''):
            members = ''.join(f'<nd ref="{ref}"/>' for ref in refs)
            tag = f'<tag k="{key}" v="{value}"/>' if key else ''
            return f'<way id="{identifier}">{members}{tag}</way>'

        # The relation and an unrelated building way share a numeric OSM ID.
        osm.write_text('<osm version="0.6">' + ''.join(node_xml) +
                       way(21, [1, 2, 3, 4, 1], 'building', 'yes') + way(22, [5, 6, 7, 8, 5]) +
                       way(23, [9, 10], 'highway', 'primary') +
                       way(30, [11, 12, 13, 14, 11], 'building', 'house') +
                       '<relation id="30"><member type="way" ref="21" role="outer"/>'
                       '<member type="way" ref="22" role="inner"/>'
                       '<tag k="type" v="multipolygon"/><tag k="building" v="yes"/></relation></osm>',
                       encoding='utf-8')
        pbf = self.root / 'fixture.osm.pbf'
        header = osmium.io.Header()
        header.set('osmosis_replication_timestamp', '2026-01-01T00:00:00Z')
        with osmium.SimpleWriter(str(pbf), header=header) as writer:
            for item in osmium.FileProcessor(str(osm)):
                writer.add(item)
        coverage = self.root / 'area.poly'
        coverage.write_text('test\n1\n9.99 19.99\n10.03 19.99\n10.03 20.03\n9.99 20.03\nEND\nEND\n',
                            encoding='utf-8')
        build(pbf, coverage, self.root / 'fixture.sqlite3', 'Test OSM', 'https://example.test/fixture.pbf')
        self.provider = AsyncMock()
        self.provider.query.side_effect = RoadNetworkError(504, 'osm_timeout', 'Online request timed out.')
        env = patch.dict('os.environ', {'SATGPT_OSM_SNAPSHOT_DIR': str(self.root), 'SATGPT_ROAD_SNAPSHOT': ''})
        env.start()
        self.addCleanup(env.stop)

    async def query(self, kind, bounds=None, *, offline=False, provider=None):
        category = {'roads': 'major', 'pois': 'hospital', 'buildings': None}[kind]
        return await execute(None if offline else (provider or self.provider), {'kind': kind, 'category': category,
                                             'bounds': bounds or [10, 20, 10.014, 20.01],
                                             'artifact_dir': str(self.root)})

    async def test_query_clips_roads_and_preserves_building_holes_and_ids(self):
        roads, buildings = await self.query('roads'), await self.query('buildings')
        self.assertEqual(self.provider.query.await_count, 2)
        self.assertEqual(roads['summary']['fallback_reason'], 'osm_timeout')
        self.assertEqual(buildings['summary']['source_mode'], 'regional_snapshot')
        self.assertEqual(roads['summary']['count'], 1)
        self.assertEqual(buildings['summary']['count'], 2)
        self.assertEqual(buildings['summary']['osm_data_time'], '2026-01-01T00:00:00Z')
        road, = self.read_features(roads)
        self.assertEqual(shape(road['geometry']).bounds, (10, 20.002, 10.014, 20.002))
        relation, way = sorted(self.read_features(buildings), key=lambda f: f['properties']['osm_type'])
        self.assertEqual([(f['properties']['osm_type'], f['properties']['osm_id']) for f in (relation, way)],
                         [('relation', '30'), ('way', '30')])
        self.assertEqual(len(shape(relation['geometry']).interiors), 1)

    async def test_snapshot_only_keeps_empty_outside_and_feature_limit_distinct(self):
        self.assertEqual((await self.query('buildings', [10.020, 20.020, 10.025, 20.025], offline=True))
                         ['summary']['status'], 'empty')
        with self.assertRaises(RoadNetworkError) as outside:
            await self.query('buildings', [10.025, 20.025, 10.035, 20.035], offline=True)
        self.assertEqual(outside.exception.code, 'osm_snapshot_outside_coverage')
        with patch('harness.app.regional_osm.MAX_BUILDINGS', 1), self.assertRaises(RoadNetworkError) as limit:
            await self.query('buildings', offline=True)
        self.assertEqual(limit.exception.code, 'feature_limit')
        self.provider.query.assert_not_called()

    async def test_online_success_and_empty_skip_snapshots(self):
        for count in (1, 0):
            with self.subTest(count=count), patch('harness.app.osm_worker.query_regional_snapshot') as snapshot:
                self.provider.query.side_effect = None
                self.provider.query.return_value = ({'status': 'ok' if count else 'empty', 'count': count}, b'{}')
                result = await self.query('buildings')
                self.assertEqual(result['summary']['source_mode'], 'overpass')
                self.assertEqual('artifact_ref' in result, bool(count))
                snapshot.assert_not_called()

    async def test_transport_deadline_still_allows_snapshot_fallback(self):
        async def slow(_request):
            await asyncio.sleep(1)
            return httpx.Response(200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(slow)) as client:
            provider = OverpassQueries(client, 'https://osm.test/interpreter', request_timeout=.03)
            try:
                result = await asyncio.wait_for(self.query('buildings', provider=provider), timeout=.8)
            finally:
                await provider.close()
        self.assertEqual(result['summary']['fallback_reason'], 'osm_timeout')
        self.assertEqual(result['summary']['count'], 2)

    async def test_limits_errors_and_unavailable_sources(self):
        for code in ('osm_rate_limited', 'osm_unavailable', 'feature_limit'):
            with self.subTest(code=code):
                self.provider.query.side_effect = RoadNetworkError(422, code, 'Online query failed.')
                self.assertEqual((await self.query('buildings'))['summary']['fallback_reason'], code)
                with self.assertRaises(RoadNetworkError) as outside:
                    await self.query('buildings', [10.025, 20.025, 10.035, 20.035])
                self.assertEqual(outside.exception.code, code)
                self.assertIn('covers the entire selection', str(outside.exception))
                with patch('harness.app.osm_worker.query_regional_snapshot', side_effect=OSError), \
                        self.assertRaises(RoadNetworkError) as broken:
                    await self.query('buildings')
                self.assertEqual(broken.exception.code, code)
                self.assertIn('could not be read', str(broken.exception))
        with self.assertRaises(RoadNetworkError) as empty:
            await self.query('buildings', [10.020, 20.020, 10.025, 20.025])
        self.assertEqual(empty.exception.code, 'feature_limit')
        self.provider.query.side_effect = RoadNetworkError(504, 'osm_timeout', 'Online timed out.')
        with patch('harness.app.osm_worker.query_regional_snapshot') as snapshot, self.assertRaises(RoadNetworkError) as poi:
            await self.query('pois')
        self.assertEqual(str(poi.exception), 'Online timed out.')
        snapshot.assert_not_called()

    async def test_legacy_road_fallback_after_regional_coverage_miss(self):
        path = self.root / 'legacy.geojson'
        path.write_text(json.dumps({'category': 'major', 'coverage': {'type': 'Polygon', 'coordinates': [[
            [10.02, 20.02], [10.04, 20.02], [10.04, 20.04], [10.02, 20.04], [10.02, 20.02]]]},
            'osm_data_time': '2026-01-01', 'source': 'Test OSM', 'source_sha256': 'fixture', 'skipped_geometry': 0,
            'features': [{'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [[10.03, 20.03], [10.04, 20.03]]},
                          'properties': {'osm_type': 'way', 'osm_id': '42', 'category': 'primary'}}]}), encoding='utf-8')
        with patch.dict('os.environ', {'SATGPT_ROAD_SNAPSHOT': str(path)}):
            result = await self.query('roads', [10.025, 20.025, 10.035, 20.035])
        self.assertEqual(result['summary']['source_mode'], 'road_snapshot')
        self.assertEqual(result['summary']['fallback_reason'], 'osm_timeout')

    def test_longitude_split_for_snapshot_line(self):
        from harness.app.osm_queries import _line_parts
        from scripts.import_osm_snapshot import normalize_longitude

        result = normalize_longitude(LineString([(179.5, -16), (-179.5, -16)]), _line_parts)
        self.assertEqual(len(result.geoms), 2)
        self.assertAlmostEqual(result.length, 1)

    def read_features(self, result):
        return json.loads((self.root / (result['artifact_ref'] + '.geojson')).read_bytes())['features']

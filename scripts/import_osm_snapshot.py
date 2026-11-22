"""Build a SatGPT regional SQLite snapshot from a Geofabrik PBF and .poly file."""

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime
from hashlib import file_digest
import json
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory

import osmium
from shapely import GEOSException, from_wkb, to_wkb
from shapely.affinity import translate
from shapely.geometry import Polygon, box, mapping
from shapely.ops import transform, unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness.app.osm_queries import BUILDING_TYPES, ROAD_FILTERS, _line_parts, _polygon_parts
from harness.app.regional_osm import SCHEMA_VERSION


def normalize_longitude(geometry, parts):
    result = []
    for part in parts(geometry):
        west, _, east, _ = part.bounds
        if east - west <= 180:
            result.append(part)
            continue
        shifted = transform(lambda x, y: (x + 360 if x < 0 else x, y), part)
        result.extend(parts(shifted.intersection(box(0, -90, 180, 90))))
        result.extend(parts(translate(shifted.intersection(box(180, -90, 360, 90)), xoff=-360)))
    return unary_union(result)


def read_coverage(path):
    lines = iter(line.strip() for line in path.read_text(encoding='utf-8').splitlines())
    next(lines)  # Geofabrik region name.
    rings = []
    for label in lines:
        if label == 'END':
            break
        points = []
        for line in lines:
            if line == 'END':
                break
            x, y = map(float, line.split())
            if not (-180 <= x <= 180 and -90 <= y <= 90):
                raise ValueError('Extract coverage does not use WGS84 coordinates')
            points.append((x, y))
        ring = normalize_longitude(Polygon(points), _polygon_parts)
        if not ring.is_valid or ring.is_empty:
            raise ValueError('Invalid extract coverage ring')
        rings.append((label.startswith('!'), ring))
    else:
        raise ValueError('Missing extract coverage terminator')
    coverage = unary_union([ring for hole, ring in rings if not hole]).difference(
        unary_union([ring for hole, ring in rings if hole]))
    if coverage.is_empty or not coverage.is_valid:
        raise ValueError('Invalid extract coverage')
    return coverage


class Importer(osmium.SimpleHandler):
    def __init__(self, db):
        super().__init__()
        self.db = db
        self.factory = osmium.geom.WKBFactory()
        self.road_classes = set().union(*ROAD_FILTERS.values())
        self.building_relations = {}
        self.skipped = Counter({'roads': 0, 'buildings': 0})

    def save(self, kind, osm_type, osm_id, category, name, geometry, parts):
        geometry = normalize_longitude(geometry, parts)
        if geometry.is_empty or not geometry.is_valid:
            raise ValueError('Invalid OSM geometry')
        row = self.db.execute('''INSERT INTO features(kind, osm_type, osm_id, category, name, geometry)
            VALUES(?, ?, ?, ?, ?, ?)''', (kind, osm_type, osm_id, category, ' '.join(name.split())[:100],
                                         to_wkb(geometry)))
        west, south, east, north = geometry.bounds
        self.db.execute('INSERT INTO feature_bounds VALUES(?, ?, ?, ?, ?)',
                        (row.lastrowid, west, east, south, north))

    def way(self, way):
        tags = way.tags
        highway, building = tags.get('highway'), tags.get('building')
        name = tags.get('name', '')
        if highway in self.road_classes and tags.get('area') != 'yes':
            try:
                line = from_wkb(self.factory.create_linestring(way))
                self.save('roads', 'way', way.id, highway, name, line, _line_parts)
            except (osmium.InvalidLocationError, RuntimeError, ValueError, GEOSException):
                self.skipped['roads'] += 1
        if building in (None, '', 'no'):
            return
        try:
            if not way.is_closed():
                raise ValueError('Open building way')
            polygon = Polygon(from_wkb(self.factory.create_linestring(way)).coords)
            self.save('buildings', 'way', way.id, building if building in BUILDING_TYPES else 'other',
                      name, polygon, _polygon_parts)
        except (osmium.InvalidLocationError, RuntimeError, ValueError, GEOSException):
            self.skipped['buildings'] += 1

    def relation(self, relation):
        if relation.tags.get('type') == 'multipolygon' and relation.tags.get('building') not in (None, '', 'no'):
            self.building_relations[relation.id] = [m.ref for m in relation.members
                                                   if m.type == 'w' and m.role in ('', 'outer')]

    def area(self, area):
        building = area.tags.get('building')
        if area.from_way() or building in (None, '', 'no'):
            return
        try:
            polygon = from_wkb(self.factory.create_multipolygon(area))
            self.save('buildings', 'relation', area.orig_id(), building if building in BUILDING_TYPES else 'other',
                      area.tags.get('name', ''), polygon, _polygon_parts)
        except (osmium.InvalidLocationError, RuntimeError, ValueError, GEOSException):
            pass  # finish() counts all relations that could not be assembled.

    def finish(self):
        rows = self.db.execute("SELECT id, osm_id, geometry FROM features WHERE osm_type='relation'").fetchall()
        self.skipped['buildings'] += len(self.building_relations.keys() - {row[1] for row in rows})
        for feature_id, relation_id, geometry in rows:
            members = self.building_relations.get(relation_id)
            if members is None:
                self.delete(feature_id)
                continue
            shells = [Polygon(polygon.exterior) for polygon in _polygon_parts(from_wkb(geometry))]
            for way_id in set(members):
                way = self.db.execute("SELECT id, geometry FROM features WHERE kind='buildings' AND osm_type='way' "
                                      'AND osm_id=?', (way_id,)).fetchone()
                if way and any(shell.equals(from_wkb(way[1])) for shell in shells):
                    self.delete(way[0])

    def delete(self, feature_id):
        self.db.execute('DELETE FROM feature_bounds WHERE id=?', (feature_id,))
        self.db.execute('DELETE FROM features WHERE id=?', (feature_id,))


def build(pbf, coverage_file, output, source, source_url):
    coverage = read_coverage(coverage_file)
    with osmium.io.Reader(str(pbf), osmium.osm.NOTHING) as reader:
        timestamp = reader.header().get('osmosis_replication_timestamp')
    if not timestamp or datetime.fromisoformat(timestamp.replace('Z', '+00:00')).tzinfo is None:
        raise ValueError('PBF has no timezone-aware OSM replication timestamp')
    with pbf.open('rb') as file:
        digest = file_digest(file, 'sha256').hexdigest()
    with coverage_file.open('rb') as file:
        coverage_digest = file_digest(file, 'sha256').hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as staging:
        candidate = Path(staging) / output.name
        with closing(sqlite3.connect(candidate)) as db, db:
            db.executescript(f'''PRAGMA user_version={SCHEMA_VERSION};
                CREATE TABLE snapshot(data TEXT NOT NULL);
                CREATE TABLE features(
                    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, osm_type TEXT NOT NULL, osm_id INTEGER NOT NULL,
                    category TEXT NOT NULL, name TEXT NOT NULL, geometry BLOB NOT NULL,
                    UNIQUE(kind, osm_type, osm_id));
                CREATE VIRTUAL TABLE feature_bounds USING rtree(id, min_x, max_x, min_y, max_y);
            ''')
            importer = Importer(db)
            importer.apply_file(str(pbf), locations=True)
            importer.finish()
            counts = dict(db.execute('SELECT kind, count(*) FROM features GROUP BY kind'))
            if not all(counts.get(kind, 0) for kind in ('roads', 'buildings')):
                raise ValueError('Snapshot must contain roads and buildings')
            metadata = {'source': source, 'source_url': source_url, 'source_sha256': digest,
                        'coverage_sha256': coverage_digest, 'osm_data_time': timestamp,
                        'coverage': mapping(coverage), 'skipped': importer.skipped, 'counts': counts}
            db.execute('INSERT INTO snapshot VALUES(?)', (json.dumps(metadata, ensure_ascii=False),))
        candidate.replace(output)
    print(json.dumps({key: value for key, value in metadata.items() if key != 'coverage'}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pbf', type=Path)
    parser.add_argument('coverage', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--source', required=True)
    parser.add_argument('--source-url', required=True)
    args = parser.parse_args()
    build(args.pbf, args.coverage, args.output, args.source, args.source_url)

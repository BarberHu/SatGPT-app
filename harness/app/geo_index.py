"""Conversation-owned spatial references. The public projection is metadata only."""

from contextlib import closing
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import unicodedata

from shapely.geometry import box, shape


REF = re.compile(r'g_[a-f0-9]{32}')
ARTIFACT = re.compile(r'[a-f0-9]{32}')
OSM_NAMES = {'roads': 'OSM roads', 'buildings': 'OSM buildings', 'pois': 'OSM points of interest'}
KINDS = ('area', 'flood', *OSM_NAMES)
ALIASES = {'area': 'AOI boundary 研究区 区域 边界', 'flood': 'flood inundation 洪水 淹没 掩膜',
           'roads': 'OSM road centerlines 道路 路网 交通', 'buildings': 'OSM building footprints 建筑 房屋',
           'pois': 'OSM POI points of interest 兴趣点 设施'}
USES = {'area': ['gee_eval', 'gee_layer'], 'flood': ['gee_eval', 'gee_layer', 'osm_roads', 'road_flood_exposure'],
        'roads': ['road_flood_exposure'], 'buildings': ['gee_osm_analyze'], 'pois': ['gee_osm_analyze']}
SCHEMA = '''
CREATE TABLE IF NOT EXISTS geo_data (
    ref TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    task_id TEXT REFERENCES tasks(id), kind TEXT NOT NULL, value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS geo_data_scope ON geo_data(owner, conversation_id, kind);
CREATE TABLE IF NOT EXISTS geo_index_migrations (name TEXT PRIMARY KEY);
'''


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False)


def put(db, owner, cid, kind, key, value, task_id=None):
    ref = 'g_' + hashlib.sha256(encode([owner, cid, kind, key]).encode()).hexdigest()[:32]
    record = {**value, 'data_ref': ref, 'kind': kind, 'version': ref[2:]}
    db.execute('INSERT OR IGNORE INTO geo_data(ref,owner,conversation_id,task_id,kind,value) VALUES(?,?,?,?,?,?)',
               (ref, owner, cid, task_id, kind, encode(record)))
    return ref


def index_area(db, owner, job):
    geometry = job.get('analysis_region')
    if not geometry:
        return None
    aoi = job.get('analysis_aoi') or {}
    label = aoi.get('label', 'Confirmed analysis area')
    return put(db, owner, job['conversation_id'], 'area', [aoi, geometry], {
        'name': label, 'geometry': geometry, 'bounds': job['bounds'], 'crs': 'EPSG:4326',
        'source': 'Confirmed study area', 'registered_at': job['created_at']})


def artifact_directory(context, job_id):
    return Path(context['db']).parent / 'artifacts' / context['owner'] / context['conversation_id'] / job_id


def index_artifact(db, context, kind, artifact, summary, scope):
    if not isinstance(artifact, str) or not ARTIFACT.fullmatch(artifact):
        raise ValueError('Invalid spatial artifact identifier')
    task_id = context['task_id']
    directory = artifact_directory(context, task_id)
    if kind == 'flood':
        value = {'name': summary['event'], 'observed_at': summary['observed_at'], 'crs': summary['crs'],
                 'scale': summary['scale'], 'coverage_fraction': summary['observed_fraction'],
                 'source': summary.get('source', 'Published flood classification'), 'bands': ['flood_class'],
                 'area_ref': scope.get('area_ref'),
                 'limitations': 'Satellite-derived potential inundation; dry, flood, excluded and unknown are distinct.'}
        files = [directory / f'flood-{artifact}.{ext}' for ext in ('json', 'npy')]
    elif kind in OSM_NAMES:
        snapshot = summary.get('osm_data_time')
        if snapshot and not re.match(r'^\d{4}-\d{2}-\d{2}', snapshot):
            try:
                snapshot = parsedate_to_datetime(snapshot).isoformat()
            except (TypeError, ValueError):
                pass
        value = {'name': ' · '.join(filter(None, (OSM_NAMES[kind], summary.get('category'), scope.get('label')))),
                 'snapshot_at': snapshot, 'count': summary.get('count'), 'crs': 'EPSG:4326',
                 'source': summary.get('source') or summary.get('attribution') or 'OpenStreetMap',
                 'category': summary.get('category'), 'source_mode': summary.get('source_mode'),
                 'fallback_reason': summary.get('fallback_reason'), 'attribution': summary.get('attribution'),
                 'fields': ['osm_type', 'osm_id', 'category', 'name'],
                 'limitations': 'Coverage represents mapped OSM features and is limited to the query scope.'}
        files = [directory / f'{artifact}.geojson']
    else:
        raise ValueError('Unsupported spatial artifact type')
    if not all(path.is_file() and not path.is_symlink() for path in files):
        return None
    value.update(bounds=scope['bounds'], geometry=scope.get('analysis_region'),
                 legacy_ref=artifact, task_id=task_id, registered_at=datetime.now(timezone.utc).isoformat())
    return put(db, context['owner'], context['conversation_id'], kind, artifact, value, task_id)


def backfill(db, path):
    if db.execute("SELECT 1 FROM geo_index_migrations WHERE name='references-v1'").fetchone():
        return
    for owner, cid, task_id, raw in db.execute(
            'SELECT t.owner,t.conversation_id,t.id,t.receipt FROM tasks t JOIN conversations c ON c.id=t.conversation_id '
            "WHERE t.status='completed' AND c.deleted=0"):
        job = json.loads(raw)
        if not job.get('analysis_region'):
            continue
        job['area_ref'] = index_area(db, owner, job)
        context = {'owner': owner, 'conversation_id': cid, 'task_id': task_id, 'db': str(path)}
        for layer in (job.get('output') or {}).get('layers') or []:
            publication = layer.get('flood_result')
            if publication:
                index_artifact(db, context, 'flood', publication.get('ref'), publication, job)
            elif layer.get('kind') == 'geojson' and layer.get('name', '').startswith('OSM roads'):
                # A legacy road layer may have used a prior flood's area instead of the request viewport.
                if layer.get('bounds') != job['bounds']:
                    continue
                description = layer.get('metadata') or {}
                index_artifact(db, context, 'roads', layer.get('artifact_ref'), {
                    'category': layer['name'].partition(' · ')[2], 'source': description.get('source'),
                    'osm_data_time': description.get('observed_at')}, job)
    db.execute("UPDATE conversations SET native_id='satgpt-'||lower(hex(randomblob(16))), "
               "native_state='new', recover_context=1 WHERE native_state!='new'")
    db.execute("INSERT INTO geo_index_migrations(name) VALUES('references-v1')")


def scope(db, context):
    row = db.execute('SELECT t.status FROM tasks t JOIN conversations c ON c.id=t.conversation_id '
                     'WHERE t.id=? AND t.owner=? AND c.owner=t.owner AND c.id=? AND c.deleted=0',
                     (context['task_id'], context['owner'], context['conversation_id'])).fetchone()
    allowed = ('completed',) if context.get('replay') else ('running', 'starting')
    if not row or row[0] not in allowed:
        raise ValueError('The spatial data index requires an active conversation task')


def connect(context, *, write=False):
    path = Path(context['db']).resolve()
    return sqlite3.connect(path.as_uri() + ('?mode=rw' if write else '?mode=ro'), uri=True, timeout=4)


def publish(context, kind, artifact, summary, area):
    with closing(connect(context, write=True)) as db, db:
        scope(db, context)
        return index_artifact(db, context, kind, artifact, summary, area)


def available(context, record):
    kind = record['kind']
    if kind == 'area':
        return True
    directory = artifact_directory(context, record['task_id'])
    ref = record['legacy_ref']
    names = [f'flood-{ref}.json', f'flood-{ref}.npy'] if kind == 'flood' else [f'{ref}.geojson']
    return all((directory / name).is_file() and not (directory / name).is_symlink() for name in names)


def resolve(db, context, ref, kinds=KINDS):
    if not isinstance(ref, str) or not REF.fullmatch(ref):
        raise ValueError('Use a data_ref from the spatial data index')
    row = db.execute('SELECT d.value FROM geo_data d LEFT JOIN tasks t ON t.id=d.task_id '
                     'WHERE d.ref=? AND d.owner=? AND d.conversation_id=? AND '
                     '(d.task_id IS NULL OR t.status=\'completed\' OR d.task_id=? AND t.status=\'running\')',
                     (ref, context['owner'], context['conversation_id'], context['task_id'])).fetchone()
    if not row:
        raise ValueError('Spatial data reference is unavailable in this conversation')
    record = json.loads(row[0])
    if record['kind'] not in kinds or not available(context, record):
        raise ValueError('Spatial data is unavailable or has the wrong type for this tool')
    return record


def get(context, ref, kinds=KINDS):
    with closing(connect(context)) as db:
        scope(db, context)
        return resolve(db, context, ref, kinds)


def metadata(record):
    if __package__:
        from .context_guard import safe_text
    else:
        from context_guard import safe_text
    keys = ('data_ref', 'kind', 'name', 'bounds', 'observed_at', 'snapshot_at', 'registered_at', 'source',
            'category', 'source_mode', 'fallback_reason', 'attribution',
            'version', 'crs', 'scale', 'bands', 'fields', 'coverage_fraction', 'area_ref', 'count', 'limitations')
    return {**{key: safe_text(record[key]) if isinstance(record[key], str) else record[key]
               for key in keys if record.get(key) is not None},
            'usable_with': USES[record['kind']]}


def normalized(text):
    text = unicodedata.normalize('NFKC', text).casefold().replace('djakarta', 'jakarta').replace('雅加达', ' jakarta ')
    return ' '.join(re.sub(r'[^\w\u3400-\u9fff]+', ' ', text).split())


def match(record, query):
    name = normalized(record['name'])
    haystack = normalized(' '.join([record['name'], ALIASES[record['kind']], str(record.get('observed_at', '')),
                                    str(record.get('snapshot_at', '')), record['data_ref']]))
    # Common Chinese topic terms are searchable even when joined to a place or a year.
    terms = normalized(re.sub(r'(洪水|淹没|掩膜|道路|路网|建筑|房屋|兴趣点|设施|研究区|区域|边界)', r' \1 ', query)).split()
    if terms and not all(term in haystack for term in terms):
        return -1
    return 2 if name == normalized(query) else sum(term in name for term in terms)


def search(context, args):
    with closing(connect(context)) as db:
        scope(db, context)
        area = resolve(db, context, args['area_ref'], ('area',)) if args.get('area_ref') else None
        rows = db.execute('SELECT d.value FROM geo_data d LEFT JOIN tasks t ON t.id=d.task_id '
                          'WHERE d.owner=? AND d.conversation_id=? AND (? IS NULL OR d.kind=?) AND '
                          '(d.task_id IS NULL OR t.status=\'completed\' OR d.task_id=? AND t.status=\'running\')',
                          (context['owner'], context['conversation_id'], args.get('kind'), args.get('kind'),
                           context['task_id']))
        ranked = []
        for (value,) in rows:
            record = json.loads(value)
            score = match(record, args.get('query', ''))
            if score < 0:
                continue
            when = record.get('observed_at') if record['kind'] == 'flood' else record.get('snapshot_at')
            dates = re.findall(r'\b\d{4}-\d{2}-\d{2}\b', when or '')
            if args.get('start') and (not dates or max(dates) < args['start']):
                continue
            if args.get('end') and (not dates or min(dates) >= args['end']):
                continue
            relation = None
            if area:
                if not box(*record['bounds']).intersects(box(*area['bounds'])):
                    continue
                coverage = record.get('geometry')
                if coverage:
                    candidate, required = shape(coverage), shape(area['geometry'])
                    if not candidate.intersects(required):
                        continue
                    relation = 'covers_area' if candidate.covers(required) else 'intersects_area'
                else:
                    relation = 'bbox_overlap_only'
            status = 'ready' if available(context, record) else 'missing'
            ranked.append((status == 'ready', score, record['registered_at'], record['data_ref'],
                           {**metadata(record), 'status': status, **({'spatial_match': relation} if relation else {})}))
        ranked.sort(key=lambda item: item[:4], reverse=True)
        return {'results': [item[-1] for item in ranked[:args.get('limit', 8)]], 'matched': len(ranked)}

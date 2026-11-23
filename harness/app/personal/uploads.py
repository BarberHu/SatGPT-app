"""Durable upload lifecycle, independent of chat cancellation and its executor."""
import hashlib
import re
import threading
import time
import uuid
from pathlib import Path

from .cloud import asset_name
from .oauth import EE_WRITE, STORAGE
from .settings import PersonalError
from .upload_validation import geojson_csv, geotiff_metadata

TERMINAL = {'ready', 'failed', 'cancelled'}


class Uploads:
    def __init__(self, service, autostart=True):
        self.service, self.store, self.cloud = service, service.store, service.cloud
        self.root = service.settings.state_dir / 'uploads'
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock, self.receiving = threading.RLock(), set()
        self.stopped, self.wake = threading.Event(), threading.Event()
        self.thread = threading.Thread(target=self.loop, daemon=True, name='personal-uploads')
        if autostart:
            self.thread.start()

    def close(self):
        self.stopped.set(); self.wake.set()
        if self.thread.is_alive():
            self.thread.join(timeout=180)

    def public(self, row):
        return {key: value for key, value in row.items() if key not in {'owner', 'request_id', 'object', 'content_path', 'idempotency_key'}}

    def create(self, owner, filename, asset_id, key):
        if not isinstance(filename, str) or len(filename) > 200 or '/' in filename or '\\' in filename:
            raise PersonalError(400, 'Choose a local file with a simple filename.')
        suffix = Path(filename).suffix.lower()
        if suffix not in {'.tif', '.tiff', '.json', '.geojson'}:
            raise PersonalError(422, 'Supported formats: GeoTIFF and GeoJSON.')
        if not re.fullmatch(r'[A-Za-z0-9-]{16,80}', key):
            raise PersonalError(400, 'An upload idempotency key is required.')
        execution = self.service.execution(owner, [])
        self.service.oauth.token(owner, (EE_WRITE, STORAGE))
        conn = self.store.connection(owner)
        if not conn['bucket']:
            raise PersonalError(409, 'Configure an existing Cloud Storage bucket before uploading.')
        name = asset_name(asset_id)
        if not name.startswith(f"projects/{conn['project']}/assets/"):
            raise PersonalError(400, 'The destination must be inside the configured project assets.')
        with self.lock:
            rows = self.store.list('uploads', owner)
            previous = next((r for r in rows if r['idempotency_key'] == key), None)
            if previous:
                if previous['filename'] != filename or previous['asset_id'] != name:
                    raise PersonalError(409, 'This upload key was already used for a different file or destination.')
                return previous
            if any(r['asset_id'] == name and r['status'] not in {'failed', 'cancelled'} for r in rows):
                raise PersonalError(409, 'This destination already has an upload. Choose another asset name.')
            if sum(r['status'] not in TERMINAL for r in self.store.list('uploads')) >= 8:
                raise PersonalError(429, 'The upload queue is full. Wait for an upload to finish.')
            try:
                self.cloud.asset(owner, name)
            except PersonalError as exc:
                if exc.status != 404:
                    raise
            else:
                raise PersonalError(409, 'The destination asset exists. Overwriting is disabled.')
            ident = uuid.uuid4().hex
            row = {'id': ident, 'owner': owner, 'filename': filename, 'asset_id': name,
                   'project': conn['project'], 'connection_id': conn['id'], 'revision': conn['revision'],
                   'bucket': conn['bucket'], 'kind': 'raster' if suffix in {'.tif', '.tiff'} else 'vector',
                   'status': 'received', 'bytes': 0, 'created_at': time.time(), 'error': '',
                   'idempotency_key': key, 'request_id': str(uuid.uuid4()), 'operation': None,
                   'execution': execution, 'cleanup_pending': False}
            self.store.put('uploads', owner, row)
            return row

    async def receive(self, owner, ident, request):
        with self.lock:
            row = self.store.get('uploads', owner, ident)
            if row['status'] != 'received' or ident in self.receiving:
                raise PersonalError(409, 'This upload is not awaiting file content.')
            self.receiving.add(ident)
        limit = self.service.settings.raster_limit if row['kind'] == 'raster' else self.service.settings.vector_limit
        path = self.root / (ident + '.source')
        count, checksum = 0, hashlib.sha256()
        try:
            with path.open('wb') as stream:
                async for chunk in request.stream():
                    with self.lock:
                        if self.store.get('uploads', owner, ident)['status'] == 'cancel_requested':
                            raise PersonalError(409, 'File transfer was cancelled.')
                        count += len(chunk)
                        if count > limit:
                            raise PersonalError(413, 'The actual file content exceeds the upload size limit.')
                        disk = sum(p.stat().st_size for p in self.root.iterdir() if p.is_file())
                        if disk + len(chunk) > self.service.settings.disk_limit:
                            raise PersonalError(413, 'The local staging quota is full. Clean completed uploads first.')
                        stream.write(chunk); checksum.update(chunk)
            if not count:
                raise PersonalError(422, 'The file is empty.')
            with self.lock:
                latest = self.store.get('uploads', owner, ident)
                if latest['status'] == 'cancel_requested':
                    raise PersonalError(409, 'File transfer was cancelled.')
                row.update(bytes=count, sha256=checksum.hexdigest(), status='validating')
                self.store.put('uploads', owner, row)
            self.wake.set()
            return row
        except BaseException as exc:
            path.unlink(missing_ok=True)
            with self.lock:
                row = self.store.get('uploads', owner, ident)
                row.update(status='cancelled' if row['status'] == 'cancel_requested' else 'failed',
                           error=exc.message if isinstance(exc, PersonalError) else 'File transfer was interrupted. Retry the file.')
                self.store.put('uploads', owner, row)
            raise
        finally:
            with self.lock:
                self.receiving.discard(ident)

    def cancel(self, owner, ident):
        with self.lock:
            row = self.store.get('uploads', owner, ident)
            if row['status'] not in TERMINAL:
                row['status'] = 'cancel_requested'
                self.store.put('uploads', owner, row)
        self.wake.set()
        return row

    def retry(self, owner, ident):
        with self.lock:
            row = self.store.get('uploads', owner, ident)
            if row['status'] != 'failed':
                raise PersonalError(409, 'Only failed uploads can be retried.')
            conn = self.store.connection(owner)
            if not conn or not conn['active'] or conn['id'] != row['connection_id']:
                raise PersonalError(401, 'Reconnect the original account before retrying.')
            if row.get('operation_terminal'):
                # A failed/cancelled remote operation cannot be restarted with the old dedupe ID.
                row['operation'], row['request_id'] = None, str(uuid.uuid4())
                row['operation_terminal'] = False
            row.update(revision=conn['revision'], error='',
                       status='ingesting' if row.get('operation') else 'uploading' if row.get('object') else
                       'validating' if (self.root / (ident + '.source')).exists() else 'received')
            self.store.put('uploads', owner, row)
        self.wake.set()
        return row

    def resume(self, owner, ident):
        with self.lock:
            row = self.store.get('uploads', owner, ident)
            if row['status'] in TERMINAL:
                raise PersonalError(409, 'Use retry for a failed upload.')
            conn = self.store.connection(owner)
            if not conn or not conn['active'] or conn['id'] != row['connection_id']:
                raise PersonalError(401, 'Reconnect the original account before resuming.')
            self.service.oauth.token(owner, (EE_WRITE, STORAGE))
            row.update(revision=conn['revision'], error='')
            self.store.put('uploads', owner, row)
        self.wake.set()
        return row

    def cleanup(self, owner, ident):
        with self.lock:
            row = self.store.get('uploads', owner, ident)
            if row['status'] not in TERMINAL or (row.get('operation') and not row.get('operation_terminal')):
                raise PersonalError(409, 'Wait for confirmed remote completion before cleaning staging files.')
            if ident in self.receiving:
                raise PersonalError(409, 'File transfer is still closing.')
        if row.get('object'):
            self.cloud.cleanup(owner, row)
        for suffix in ('.source', '.csv'):
            (self.root / (ident + suffix)).unlink(missing_ok=True)
        row['cleanup_pending'] = False
        self.store.put('uploads', owner, row)
        return row

    def loop(self):
        while not self.stopped.is_set():
            for row in self.store.list('uploads'):
                if self.stopped.is_set():
                    break
                if row['status'] in {'validating', 'uploading', 'ingesting', 'cancel_requested'}:
                    self.step(row['owner'], row['id'])
            self.wake.wait(3); self.wake.clear()

    def step(self, owner, ident):
        with self.lock:
            row = self.store.get('uploads', owner, ident)
            if ident in self.receiving:
                return
        try:
            conn = self.store.connection(owner)
            if row['status'] == 'cancel_requested' and not row.get('operation') and not row.get('import_submitting'):
                row.update(status='cancelled', error=''); self.save(row); return
            if not conn or not conn['active'] or conn['id'] != row['connection_id'] or conn['revision'] != row['revision']:
                # Remote imports can keep running; do not report them as cancelled or failed.
                row['error'] = 'Reconnect the original account, then resume this upload.'
                self.save(row); return
            if row['status'] == 'validating':
                source = self.root / (ident + '.source')
                if row['kind'] == 'raster':
                    row['metadata'] = geotiff_metadata(source); row['content_path'] = ident + '.source'
                else:
                    output = self.root / (ident + '.csv')
                    row['metadata'] = geojson_csv(source, output); row['content_path'] = ident + '.csv'
                if sum(p.stat().st_size for p in self.root.iterdir() if p.is_file()) > self.service.settings.disk_limit:
                    (self.root / (ident + '.csv')).unlink(missing_ok=True)
                    raise PersonalError(413, 'Converted data exceeds the local staging quota.')
                row['object'] = f"satgpt/{owner}/{ident}/source" + ('.tif' if row['kind'] == 'raster' else '.csv')
                row.update(status='uploading', error=''); self.save(row)
            if row['status'] == 'uploading':
                self.cloud.stage(owner, row, self.root / row['content_path'])
                with self.lock:
                    if self.store.get('uploads', owner, ident)['status'] == 'cancel_requested':
                        row.update(status='cancelled', cleanup_pending=True); self.save(row); return
                    recovering = bool(row.get('import_submitting'))
                    row['import_submitting'] = True; self.save(row)
                operation = (self.cloud.find_import(owner, row) if recovering else None) or self.cloud.import_asset(owner, row)
                if not operation.get('name'):
                    raise PersonalError(502, 'Earth Engine did not return an import operation.')
                row.update(operation=operation['name'], import_submitting=False, status='ingesting', error='')
                self.save(row)
            if row['status'] == 'cancel_requested' and row.get('import_submitting') and not row.get('operation'):
                # Recover the same deduplicated remote request before attempting cancellation.
                operation = self.cloud.find_import(owner, row) or self.cloud.import_asset(owner, row)
                row.update(operation=operation['name'], import_submitting=False); self.save(row)
            if row['status'] in {'ingesting', 'cancel_requested'}:
                if row['status'] == 'cancel_requested' and not row.get('cancel_sent'):
                    self.cloud.operation(owner, row['operation'], cancel=True)
                    row['cancel_sent'] = True; self.save(row)
                operation = self.cloud.operation(owner, row['operation'])
                if operation.get('done'):
                    row['operation_terminal'] = True
                    error = operation.get('error')
                    if error:
                        row.update(status='cancelled' if error.get('code') == 1 else 'failed',
                                   error='Cloud import was cancelled.' if error.get('code') == 1 else 'Earth Engine rejected the import. Check the file, quota and destination permissions.')
                    else:
                        dataset = self.service.register_asset(owner, row['asset_id'])
                        row.update(status='ready', data_ref=dataset['id'], error='')
                    row['cleanup_pending'] = True
                    self.save(row)
        except PersonalError as exc:
            row['error'] = exc.message
            if exc.status not in {401, 403, 429, 503} and not (row.get('import_submitting') or row.get('operation')):
                row['status'] = 'failed'
            self.save(row)
        except Exception:
            row['error'] = 'Upload processing was interrupted. Resume or retry after checking the connection.'
            self.save(row)

    def save(self, row):
        with self.lock:
            # Cancellation can race a blocking network call. Never overwrite that intent.
            current = self.store.get('uploads', row['owner'], row['id'])
            if current['status'] == 'cancel_requested' and row['status'] not in TERMINAL:
                row['status'] = 'cancel_requested'
            self.store.put('uploads', row['owner'], row)

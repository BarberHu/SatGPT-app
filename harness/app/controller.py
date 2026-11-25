"""Browser-owned conversations and a durable queue for the shared Harness runtime."""

from __future__ import annotations

import ast
import copy
import hashlib
import json
import os
import threading
import time
import uuid
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from weakref import WeakValueDictionary

from satgpt_config import integer
from .agent import conversation_prompt, describe_run_failure
from .identity import BrowserIdentity
from .session_store import ACTIVE, SessionStore, encode, message, timestamp
from .shared_runtime import RuntimeUnavailable, SharedRuntime
from .trace import add_harness_event, clean_text, remove_final_answer
from .task_stream import TaskStream
from .analysis_region import validate_analysis_region, region_bounds, validate_analysis_aoi
from .layer_generation import generation_recipe, replay_payload
from .layer_thumbnails import LayerThumbnails, valid_ref
from .geo_index import index_area
from .context_guard import recovery_summary, safe_text


def validate_bounds(value) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError("bounds must be [west,south,east,north]")
    try:
        west, south, east, north = [float(number) for number in value]
    except (TypeError, ValueError) as exc:
        raise ValueError("bounds must contain only numbers") from exc
    if not (-180 <= west < east <= 180 and -85 <= south < north <= 85):
        raise ValueError("Map bounds are outside the valid range")
    return [west, south, east, north]


def empty_conversation():
    return {'conversation_id': None, 'messages': [], 'active_task': None}


def layer_code_bounds(code: str) -> list[float] | None:
    """Find a single literal GEE rectangle used by one layer tool call."""
    if not isinstance(code, str):
        return None
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return None
    rectangles = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "Rectangle" and isinstance(node.func.value, ast.Attribute)
                and node.func.value.attr == "Geometry" and isinstance(node.func.value.value, ast.Name)
                and node.func.value.value.id == "ee" and node.args):
            continue
        try:
            rectangles.add(tuple(validate_bounds(ast.literal_eval(node.args[0]))))
        except (ValueError, TypeError, MemoryError, RecursionError):
            continue
    return list(next(iter(rectangles))) if len(rectangles) == 1 else None


def layer_focus_bounds(event: dict) -> list[float] | None:
    """Only expose a locator when the layer's own area is known."""
    explicit = event.get("layer", {}).get("bounds")
    if explicit is not None:
        try:
            explicit = validate_bounds(explicit)
        except ValueError:
            explicit = None
    inferred = layer_code_bounds(event.get("code"))
    if explicit and inferred and (explicit[2] <= inferred[0] or explicit[0] >= inferred[2]
                                  or explicit[3] <= inferred[1] or explicit[1] >= inferred[3]):
        return inferred
    if explicit or inferred:
        return explicit or inferred
    # A request viewport can be unrelated to the region selected by the
    # agent. An unknown footprint must not masquerade as a layer locator.
    return None


CATALOG = [
    {"id": "COPERNICUS/S1_GRD", "title": "Sentinel-1 radar"},
    {"id": "COPERNICUS/S2_SR_HARMONIZED", "title": "Sentinel-2 reflectance"},
    {"id": "JRC/GSW1_4/GlobalSurfaceWater", "title": "Global surface water"},
]



class AdmissionError(RuntimeError):
    def __init__(self, code, message, status=429):
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass
class ActiveTask:
    owner: str
    native_id: str
    run_id: str
    deadline: float
    receipt: dict
    stream: TaskStream
    admitted: threading.Event = field(default_factory=threading.Event)
    stop_requested: float | None = None
    cancel_sent: bool = False


class TaskController:
    def __init__(self, root: Path, *, state=None, runtime_factory=SharedRuntime):
        self.root = root.resolve()
        self.state = Path(state or os.getenv('SATGPT_HARNESS_STATE_DIR') or root / 'state' / 'multiuser').resolve()
        self.state.mkdir(parents=True, exist_ok=True)
        self.identity = BrowserIdentity(self.state)
        self.store = SessionStore(self.state / 'sessions.sqlite3')
        self.execution_slots = integer('SATGPT_AGENT_TASKS')
        self.timeout = integer('SATGPT_AGENT_DEADLINE_SECONDS')
        self.gee_workers = integer('SATGPT_GEE_WORKERS')
        self.timing_log = os.getenv('SATGPT_HARNESS_TIMING_LOG')
        self.trace_secrets = tuple(key for name in ('AIHUBMIX_API_KEY', 'DEEPSEEK_API_KEY')
                                   if len(key := os.getenv(name, '')) >= 8)
        self.runtime = runtime_factory(self.root, self.state / 'dsh-home', self.gee_workers,
                                       integer('SATGPT_AGENT_RESIDENT_SESSIONS'))
        self.runtime.start()
        self.pool = ThreadPoolExecutor(self.execution_slots, thread_name_prefix='satgpt-run')
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.wakeup = threading.Event()
        self.rotating = False
        self.active = {}
        # Queued work lives in SQLite. Retain an event stream only while a client uses it.
        self.queued_streams = WeakValueDictionary()
        self.reloads = {}
        self.thumbnails = LayerThumbnails(self)
        self.monitor = threading.Thread(target=self._monitor, name='satgpt-runtime-monitor', daemon=True)
        self.monitor.start()

    @property
    def healthy(self):
        return not self.closed.is_set() and self.runtime.available.is_set()

    def _task_timing(self, event, task_id, **fields):
        if not self.timing_log:
            return
        point = {'component': 'task', 'event': event, 'task_id': task_id,
                 'at_ms': time.time_ns() // 1_000_000, **fields}
        try:
            with open(self.timing_log, 'ab', buffering=0,
                      opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
                stream.write((encode(point) + '\n').encode('utf-8'))
        except OSError:
            self.timing_log = None

    def _require_available(self, *, allow_rotation=False):
        if allow_rotation and self.rotating and not self.closed.is_set():
            return
        if not self.healthy:
            raise AdmissionError('runtime_unavailable', 'Harness is unavailable. Try again later.', 503)
        if self.rotating:
            raise AdmissionError('runtime_rotating', 'Harness is rotating idle sessions. Try again shortly.')

    def _view(self, db, owner, cid):
        row = self.store.owned(db, owner, cid)
        latest = self.store.latest(db, owner, cid)
        return {'conversation_id': cid, 'messages': json.loads(row['messages']),
                'active_task': latest['id'] if latest and latest['status'] in ACTIVE else None}

    def conversation(self, owner, cid):
        with self.store.connect() as db:
            return self._view(db, owner, cid)

    def current(self, owner):
        with self.store.connect() as db:
            db.execute('BEGIN')
            row = db.execute('SELECT id FROM conversations WHERE owner=? AND deleted=0 ORDER BY updated DESC LIMIT 1',
                             (owner,)).fetchone()
            return self._view(db, owner, row['id']) if row else empty_conversation()

    def list_conversations(self, owner):
        with self.store.connect() as db:
            records = db.execute('SELECT id, messages, updated FROM conversations WHERE owner=? AND deleted=0 '
                                 'ORDER BY updated DESC', (owner,)).fetchall()
            result = []
            for row in records:
                cid = row['id']
                messages = json.loads(row['messages'])
                title = next((m['content'] for m in messages if m['role'] == 'user'), 'New chat')
                latest = self.store.latest(db, owner, cid)
                active = latest if latest and latest['status'] in ACTIVE else None
                result.append({'id': cid, 'title': title[:80], 'updated_at': row['updated'], 'message_count': len(messages),
                               'active_task': active['id'] if active else None,
                               'task_status': active['status'] if active else None,
                               'latest_task': {'id': latest['id'], 'status': latest['status']} if latest else None})
            return result

    def delete_conversation(self, owner, cid):
        with self.lock, self.store.connect(write=True) as db:
            self.store.owned(db, owner, cid)
            if (self.store.has_active_task(db, owner, cid)
                    or any(conversation == cid for conversation, _ in self.reloads)):
                raise AdmissionError('conversation_busy', 'This conversation is busy.', 409)
            db.execute('UPDATE conversations SET deleted=1 WHERE id=?', (cid,))
        # Keep native logs and artifacts intact while their Agent may still be resident.
        replacement = self.current(owner)
        return {'deleted_id': cid, 'conversation': replacement, 'conversations': self.list_conversations(owner)}

    def _artifact_fields(self, owner, cid, task_id):
        return {'artifact_dir': str(self.state / 'artifacts' / owner / cid / task_id),
                'artifact_url': f'/api/previews/{cid}/{task_id}'}

    def _published_floods(self, owner, cid, messages):
        areas = {item.get('job_id'): item for item in messages if item['role'] == 'user'}
        results = {}
        for item in reversed(messages):
            original = areas.get(item.get('job_id'), {})
            if item['role'] != 'assistant' or item.get('status') != 'completed' or not original.get('analysis_region'):
                continue
            job_id = item['job_id']
            if not valid_ref(job_id):
                continue
            directory = Path(self._artifact_fields(owner, cid, job_id)['artifact_dir'])
            for layer in item.get('layers') or []:
                publication = layer.get('flood_result') or {}
                ref = publication.get('ref')
                if not valid_ref(ref) or not all((directory / f'flood-{ref}.{suffix}').is_file() for suffix in ('json', 'npy')):
                    continue
                results[ref] = {'analysis_region': original['analysis_region'], 'bounds': original['bounds'],
                                'artifact_dir': str(directory), 'event': publication['event'],
                                'observed_at': publication['observed_at']}
                if len(results) == 8:
                    return results
        return results

    def artifact(self, owner, cid, task_id, filename, *, osm=False):
        if not re.fullmatch(r'[0-9a-f]{32}\.' + ('geojson' if osm else 'png'), filename):
            raise FileNotFoundError('Preview not found')
        with self.store.connect() as db:
            self.store.owned(db, owner, cid)
            task = self.store.read_task(db, owner, task_id)
            if task['conversation_id'] != cid or task['status'] != 'completed':
                raise FileNotFoundError('Preview not found')
            if osm and not any(
                layer.get('kind') == 'geojson' and layer.get('artifact_ref') == Path(filename).stem
                for layer in (task.get('output') or {}).get('layers', [])
            ):
                raise FileNotFoundError('OSM result not found')
        path = Path(self._artifact_fields(owner, cid, task_id)['artifact_dir']) / filename
        if not path.is_file():
            raise FileNotFoundError('Preview not found')
        return path

    @staticmethod
    def _find_layer(messages, layer_id):
        for item in messages:
            if item.get('role') != 'assistant':
                continue
            for index, layer in enumerate(item.get('layers') or []):
                if f"{item.get('job_id')}-{index}" == layer_id:
                    return item, index, layer
        raise FileNotFoundError('Layer not found')

    def reload_layer(self, owner, cid, layer_id):
        key = (cid, layer_id)
        with self.lock, self.store.connect() as db:
            row = self.store.owned(db, owner, cid)
            item, _, layer = self._find_layer(json.loads(row['messages']), layer_id)
            payload = replay_payload(layer.get('generation'))
            self._require_available()
            if key in self.reloads:
                raise AdmissionError('layer_busy', 'This layer is already reloading.', 409)
            if len(self.reloads) >= self.gee_workers * 2 or sum(value == owner for value in self.reloads.values()) >= 2:
                raise AdmissionError('reload_capacity', 'Layer reload capacity reached. Try again shortly.')
            payload.update(self._artifact_fields(owner, cid, item['job_id']))
            if payload.get('inputs'):
                payload['geo_context'] = {'db': str(self.store.path), 'owner': owner, 'conversation_id': cid,
                                          'task_id': item['job_id'], 'replay': True}
            self.reloads[key] = owner
        settled = False
        try:
            fresh = self.runtime.control('/reload', {'owner_id': owner, 'payload': payload}, timeout=160)['layer']
            settled = True
            with self.store.connect(write=True) as db:
                row = self.store.owned(db, owner, cid)
                messages = json.loads(row['messages'])
                item, index, previous = self._find_layer(messages, layer_id)
                metadata = {**(previous.get('metadata') or {}), **(fresh.get('metadata') or {})}
                if previous.get('metadata', {}).get('created_at'):
                    metadata['created_at'] = previous['metadata']['created_at']
                updated = {**previous, **fresh, 'metadata': metadata, 'reloadable': True,
                           'reload_version': int(previous.get('reload_version') or 0) + 1,
                           'reloaded_at': timestamp()}
                if not fresh.get('thumbnail'):
                    updated.pop('thumbnail', None)
                if 'thumbnail_status' not in fresh:
                    updated.pop('thumbnail_status', None)
                ref = updated.pop('thumbnail_ref', None)
                updated.pop('thumbnail_call_id', None)
                if valid_ref(ref):
                    self.thumbnails.update_receipt(db, owner, item['job_id'], index, previous.get('reload_version', 0), ref, None)
                item['layers'][index] = updated
                self.store.save_messages(db, cid, messages)
            return {'conversation_id': cid, 'layer_id': layer_id, 'layer': updated}
        except RuntimeUnavailable:
            self.runtime.available.clear()
            raise
        except ValueError as exc:
            settled = True
            detail = re.sub(r'https?://\S+', '[service URL]', clean_text(str(exc), self.trace_secrets, 700))
            raise ValueError(detail) from None
        finally:
            if settled:
                with self.lock:
                    self.reloads.pop(key, None)

    def reasoning_options(self):
        reasoning = self.runtime.reasoning_options()
        return {'model': reasoning['model'], 'levels': reasoning['levels'],
                'default_effort': self.runtime.default_reasoning_effort or reasoning['default_effort']}

    def create(self, owner, prompt, bounds, cid, request_id, analysis_region=None, analysis_aoi=None,
               *, reasoning_effort=None):
        prompt = prompt.strip()
        if not 1 <= len(prompt) <= 2000:
            raise ValueError('The prompt must contain 1–2000 characters after trimming whitespace')
        analysis_region = validate_analysis_region(analysis_region)
        analysis_aoi = validate_analysis_aoi(analysis_aoi, analysis_region)
        bounds = region_bounds(analysis_region) if analysis_region else validate_bounds(bounds)
        snapshot = {'bounds': bounds, 'analysis_region': analysis_region, 'analysis_aoi': analysis_aoi}
        preference = {'reasoning_effort': reasoning_effort} if reasoning_effort is not None else {}
        canonical = json.dumps([cid, prompt, {**snapshot, **preference}], sort_keys=True, allow_nan=False).encode()
        fingerprint = hashlib.sha256(canonical).hexdigest()
        with self.lock:
            with self.store.connect(write=True) as db:
                row = self.store.owned(db, owner, cid) if cid is not None else None
                previous = db.execute('SELECT receipt, fingerprint FROM tasks WHERE owner=? AND request_id=?',
                                      (owner, request_id)).fetchone()
                if previous is not None:
                    if previous['fingerprint'] != fingerprint:
                        raise AdmissionError('request_conflict', 'Request ID already used with different input.', 409)
                    receipt = json.loads(previous['receipt'])
                    if row is None:
                        self.store.owned(db, owner, receipt['conversation_id'])
                    return receipt
                if reasoning_effort is not None:
                    reasoning = self.runtime.reasoning
                    if reasoning is None:
                        raise RuntimeUnavailable('Reasoning capabilities are unavailable')
                    if not any(level['id'] == reasoning_effort for level in reasoning['levels']):
                        raise AdmissionError('unsupported_reasoning_effort', 'This reasoning level is unavailable.', 422)
                if row is not None and self.store.has_active_task(db, owner, cid):
                    raise AdmissionError('conversation_busy', 'This conversation already has an active task.', 409)
                self._require_available(allow_rotation=True)
                if cid is None:
                    cid = self.store.new(db, owner)
                messages = json.loads(row['messages']) if row is not None else []
                task_id = uuid.uuid4().hex
                receipt = {'id': task_id, 'conversation_id': cid, 'status': 'queued', 'prompt': prompt,
                           **snapshot, **preference, 'revision': 0, 'trace': [], 'output': None, 'error': None,
                           'created_at': timestamp()}
                db.execute('INSERT INTO tasks(id, conversation_id, owner, request_id, fingerprint, status, receipt) '
                           'VALUES(?,?,?,?,?,?,?)', (task_id, cid, owner, request_id, fingerprint, 'queued', encode(receipt)))
                area_ref = index_area(db, owner, receipt)
                if area_ref:
                    receipt['area_ref'] = area_ref
                    self.store.save_task(db, receipt)
                self.store.save_messages(db, cid, [*messages, message('user', prompt, task_id, **snapshot)])
            self._task_timing('enqueued', task_id)
            self.wakeup.set()
            return receipt

    def get(self, owner, task_id):
        with self.lock:
            task = self.active.get(task_id)
            if task and task.owner == owner:
                return copy.deepcopy(task.receipt)
        with self.store.connect() as db:
            return self.store.read_task(db, owner, task_id)

    def stream(self, owner, task_id):
        with self.lock:
            task = self.active.get(task_id)
            if task is not None and task.owner == owner:
                return task.stream
            with self.store.connect() as db:
                receipt = self.store.read_task(db, owner, task_id)
            if receipt['status'] == 'queued':
                stream = self.queued_streams.get(task_id)
                if stream is None:
                    stream = TaskStream(receipt, secrets=self.trace_secrets)
                    self.queued_streams[task_id] = stream
                return stream
            return TaskStream(receipt, secrets=self.trace_secrets)

    def _update(self, task, **changes):
        receipt = {**task.receipt, **changes, 'revision': task.receipt['revision'] + 1}
        with self.store.connect(write=True) as db:
            self.store.save_task(db, receipt)
        task.receipt = receipt
        task.stream.update(**changes, revision=receipt['revision'])

    def _request_stop(self, task, reason):
        if task.receipt['status'] in {'starting', 'running'}:
            task.stop_requested = time.monotonic()
            self._update(task, status='cancelling', stop_reason=reason, cancellation='requested')

    def cancel(self, owner, task_id):
        with self.lock:
            task = self.active.get(task_id)
            if task is not None and task.owner == owner:
                self._request_stop(task, 'user')
                self.wakeup.set()
                return copy.deepcopy(task.receipt)
            with self.store.connect() as db:
                receipt = self.store.read_task(db, owner, task_id)
            if receipt['status'] != 'queued':
                return receipt
            stream = self.queued_streams.get(task_id) or TaskStream(receipt, secrets=self.trace_secrets)
            settled = self._settle(owner, {**receipt, 'stop_reason': 'user'}, stream,
                                   'cancelled', 'Stopped by user.', [], {})
            self.queued_streams.pop(task_id, None)
            return settled

    def _dispatch_queued(self):
        # The controller lock serializes queue claims, cancellation and shutdown.
        with self.lock:
            while self.healthy and not self.rotating and len(self.active) < self.execution_slots:
                with self.store.connect() as db:
                    entry = self.store.next_queued(db)
                if entry is None:
                    return
                native_id = entry['native_id']
                if self.runtime.full_for(native_id):
                    self.rotating = True
                    self.wakeup.set()
                    return
                receipt = json.loads(entry['receipt'])
                task_id = receipt['id']
                stream = self.queued_streams.get(task_id) or TaskStream(receipt, secrets=self.trace_secrets)
                task = ActiveTask(entry['owner'], native_id, uuid.uuid4().hex, time.monotonic() + self.timeout,
                                  receipt, stream)
                dispatched_at = timestamp()
                wait_ms = (datetime.fromisoformat(dispatched_at) - datetime.fromisoformat(receipt['created_at']))
                self.runtime.reserve(native_id)
                queue_wait_ms = max(0, round(wait_ms.total_seconds() * 1000))
                self._update(task, status='starting', dispatched_at=dispatched_at, queue_wait_ms=queue_wait_ms)
                self._task_timing('claimed', task_id, queue_wait_ms=queue_wait_ms)
                self.queued_streams.pop(task_id, None)
                self.active[task_id] = task
                self.pool.submit(self._run, task)

    def _monitor(self):
        while not self.closed.is_set():
            self.wakeup.wait(.1)
            self.wakeup.clear()
            if self.closed.is_set():
                break
            with self.lock:
                tasks = list(self.active.values())
                rotate = self.rotating and not tasks and not self.reloads and self.healthy
            if rotate:
                try:
                    self.runtime.close()
                    if not self.closed.is_set():
                        self.runtime.start()
                except Exception:
                    self.runtime.available.clear()
                finally:
                    with self.lock:
                        self.rotating = False
            now = time.monotonic()
            for task in tasks:
                try:
                    self._check_task(task, now)
                except sqlite3.Error:
                    self.runtime.available.clear()
            try:
                self._dispatch_queued()
            except (sqlite3.Error, RuntimeUnavailable):
                self.runtime.available.clear()

    def _check_task(self, task, now):
        with self.lock:
            job = task.receipt
            if job['id'] not in self.active:
                return
            if now >= task.deadline:
                self._request_stop(task, 'deadline')
            requested = task.stop_requested
            if requested is None:
                return
            if now - requested > 15 and self.healthy and job['status'] == 'cancelling':
                self.runtime.available.clear()
                self._update(task, error='Harness has not confirmed stop and cleanup. New tasks are paused.')
            send = not task.cancel_sent and task.admitted.is_set() and task.receipt['status'] == 'cancelling'
        if send:
            try:
                accepted = self.runtime.control('/cancel', {'session_id': task.native_id, 'run_id': task.run_id})['accepted']
            except RuntimeUnavailable:
                self.runtime.available.clear()
                return
            with self.lock:
                if accepted and task.receipt['status'] == 'cancelling':
                    task.cancel_sent = True
                    self._update(task, cancellation='accepted', cancel_accepted_at=timestamp())

    def _notify(self, task, notice, trace):
        payload = notice.payload
        if notice.method != 'session.event' or payload.get('sessionId') != task.native_id:
            return
        task.admitted.set()  # Session.run delivers its native inbox receipt first.
        event = payload.get('event') or {}
        if add_harness_event(trace, event, self.trace_secrets):
            del trace[:-250]
            # The live timeline has deltas; only the terminal snapshot carries the full trace.

    def _project(self, task, events, snapshot):
        seen = set()
        layers, previews, codes = [], [], []
        for event in events:
            if event.get('type') != 'tool/result':
                continue
            data = event.get('data', {})
            value = data.get('meta')
            if not isinstance(value, dict) or value.get('task_id') != task.receipt['id'] or value.get('run_id') != task.run_id:
                continue
            native_call_id = data.get('message', {}).get('toolCallId')
            call_id = native_call_id or event.get('seq')
            if call_id in seen:
                continue
            seen.add(call_id)
            code = value.get('code') or ''
            if 'layer' in value:
                layer = {**value['layer'], 'bounds': layer_focus_bounds(value)}
                if layer.get('kind') == 'geojson':
                    ref = layer.get('artifact_ref')
                    render_as = layer.get('renderAs')
                    if not isinstance(ref, str) or not re.fullmatch(r'[0-9a-f]{32}', ref) or render_as not in {'line', 'circle', 'fill'}:
                        continue
                    cid, job_id = task.receipt['conversation_id'], task.receipt['id']
                    layers.append({
                        'kind': 'geojson', 'renderAs': render_as, 'artifact_ref': ref,
                        'name': layer['name'], 'bounds': layer['bounds'], 'visible': layer.get('visible') is True,
                        'metadata': layer['metadata'],
                        'data_url': f'/api/harness/conversations/{cid}/tasks/{job_id}/osm/{ref}.geojson',
                    })
                    continue
                if layer.get('thumbnail_status') == 'pending':
                    if valid_ref(value.get('thumbnail_ref')):
                        layer['thumbnail_ref'] = value['thumbnail_ref']
                        if isinstance(native_call_id, str):
                            layer['thumbnail_call_id'] = native_call_id
                    else:
                        layer['thumbnail_status'] = 'unavailable'
                publication = value.get('flood_result')
                if isinstance(publication, dict) and valid_ref(publication.get('ref')):
                    layer['bounds'] = snapshot['bounds']
                    layer['flood_result'] = publication
                layer['generation'] = generation_recipe(code, layer, snapshot, value.get('indexed_inputs'))
                layer.update(code=code, reloadable=layer['generation'] is not None)
                layers.append(layer)
            if 'preview' in value:
                previews.append(value['preview'])
            if code:
                codes.append(code)
        return {'layers': layers, 'previews': previews, 'code': '\n\n'.join(codes)}

    def _settle(self, owner, job, stream, status, text, trace, output):
        trace = copy.deepcopy(trace)
        timeline = stream.finish_timeline(text if status == 'completed' else '')
        receipt = {**job, 'status': status, 'revision': job['revision'] + 1,
                   'event_cursor': stream.sequence + 1,
                   'trace': trace, 'timeline': timeline, 'finished_at': timestamp(),
                   'error': text if status == 'failed' else None,
                   'output': {'message': text, **output} if status != 'failed' else None}
        if status == 'cancelled':
            receipt['cancellation'] = 'settled'
        with self.store.connect(write=True) as db:
            row = self.store.owned(db, owner, job['conversation_id'])
            messages = json.loads(row['messages'])
            self.store.save_messages(db, row['id'], [*messages, message('assistant', text, job['id'],
                status=status, trace=trace, timeline=timeline, started_at=job.get('started_at'),
                finished_at=receipt['finished_at'], **output)])
            self.store.save_task(db, receipt)
        self._task_timing('finished', job['id'], outcome=status)
        stream.update(**receipt)
        return receipt

    def _finish(self, task, status, text, trace, output):
        with self.lock:
            task.receipt = self._settle(task.owner, task.receipt, task.stream, status, text, trace, output)
            del self.active[task.receipt['id']]
            self.wakeup.set()
            self.thumbnails.schedule(task.owner, task.receipt)

    def _run(self, task):
        from deepseek_harness.errors import TransportClosedError

        job = task.receipt
        cid, job_id = job['conversation_id'], job['id']
        session_id = task.native_id
        bridge = self.runtime.bridge
        bound = entered_run = quiescent = False
        status, text, trace, output = 'failed', 'Analysis failed.', [], {}
        scope = {key: job[key] for key in ('bounds', 'analysis_region', 'analysis_aoi')}
        snapshot = {'task_id': job_id, 'conversation_id': cid, **scope}
        try:
            if task.stop_requested is not None:
                raise InterruptedError()
            with self.store.connect(write=True) as db:
                row = self.store.owned(db, task.owner, cid)
                messages = json.loads(row['messages'])
                resume = row['native_state'] != 'new'
                if not resume:
                    db.execute("UPDATE conversations SET native_state='opening' WHERE id=?", (cid,))
            native = self.runtime.open(session_id, resume=resume)
            with self.store.connect(write=True) as db:
                db.execute("UPDATE conversations SET native_state='open' WHERE id=?", (cid,))
            with self.lock:
                if task.stop_requested is not None:
                    raise InterruptedError()
                self._update(task, status='running', started_at=timestamp())
            floods = self._published_floods(task.owner, cid, messages)
            geo_context = {'db': str(self.store.path), 'owner': task.owner, 'conversation_id': cid, 'task_id': job_id}
            binding = bridge.bind({**snapshot, 'owner_id': task.owner, 'session_id': session_id, 'flood_results': floods,
                                   'geo_context': geo_context, 'area_ref': job.get('area_ref'),
                                   'reasoning_effort': job.get('reasoning_effort', self.runtime.default_reasoning_effort),
                                   'run_id': task.run_id, **self._artifact_fields(task.owner, cid, job_id)}, task.stream.frame)
            bound = True
            with self.lock:
                if task.stop_requested is not None:
                    raise InterruptedError()
            prompt = conversation_prompt(safe_text(job['prompt']), job['bounds'], CATALOG, job.get('analysis_region'),
                                         created_at=job['created_at'],
                                         area_ref=job.get('area_ref'),
                                         recovered_context=recovery_summary(messages, job_id) if row['recover_context'] and not resume else None,
                                         published_floods=[{'ref': ref, **{key: flood[key] for key in ('bounds', 'event', 'observed_at')}}
                                                           for ref, flood in floods.items()])
            entered_run = True
            result = native.run(prompt, on_notification=lambda notice: self._notify(task, notice, trace))
            quiescent = True
            binding.drained.wait(2)
            task.stream.reconcile(result.events)
            if result.finish_reason == 'aborted' and task.stop_requested is not None:
                raise InterruptedError()
            if result.finish_reason != 'completed':
                raise RuntimeError(describe_run_failure(result, self.runtime.provider))
            text = clean_text(result.final_response.strip(), self.trace_secrets, 200_000)
            remove_final_answer(trace, text)
            output = self._project(task, result.events, snapshot)
            status = 'completed'
        except InterruptedError:
            status = 'cancelled'
            text = 'Analysis timed out.' if task.receipt.get('stop_reason') == 'deadline' else 'Stopped by user.'
        except (TransportClosedError, TimeoutError, RuntimeUnavailable):
            self.runtime.available.clear()
            text = 'Harness runtime is unavailable. Analysis could not finish.'
        except Exception as exc:
            text = re.sub(r'https?://\S+', '[service URL]', clean_text(str(exc), self.trace_secrets, 700))
        try:
            with self.lock:
                self._update(task, status='cleaning')
            if entered_run and not quiescent:
                self.runtime.available.clear()
                raise RuntimeUnavailable('Unable to verify native task quiescence')
            if bound:
                bridge.unbind(session_id, task.run_id)
            self._finish(task, status, text, trace, output)
        except Exception:
            with self.lock:
                try:
                    self._update(task, status='cleaning', error='Cleanup could not be confirmed. This analysis retains its slot.')
                except (OSError, sqlite3.Error):
                    pass

    def close(self):
        with self.lock:
            self.closed.set()
            self.wakeup.set()
            tasks = list(self.active.values())
            for task in tasks:
                self._request_stop(task, 'shutdown')
        for task in tasks:
            self._check_task(task, time.monotonic())
        self.monitor.join(timeout=3)
        self.runtime.close()
        self.pool.shutdown(wait=True, cancel_futures=False)
        self.thumbnails.close()

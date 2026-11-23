"""Per-owner orchestration built around the existing TaskController."""
import copy
import json
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

from .store import Store
from .oauth import GoogleOAuth, EE_READ, EE_WRITE, STORAGE
from .cloud import Cloud, asset_name, project_id
from .broker import CredentialBroker
from .settings import PersonalError


class PersonalService:
    def __init__(self, settings, root, cloud=None, pool=None, start_uploads=True, local=None):
        self.settings, self.root = settings, root
        self.local = local
        self.store = Store(settings)
        self.oauth = GoogleOAuth(settings, self.store)
        self.cloud = cloud or Cloud(self.oauth)
        self.lock, self.controllers = threading.RLock(), {}
        self.owns_pool = pool is None
        self.pool = pool or ThreadPoolExecutor(max_workers=1, thread_name_prefix='personal-gee')
        self.replay_gate = threading.BoundedSemaphore(2)
        self.broker = CredentialBroker(self)
        from .uploads import Uploads
        self.uploads = Uploads(self, autostart=start_uploads)

    def controller(self, owner):
        from ..controller import TaskController
        if not re.fullmatch('[a-f0-9]{32}', owner):
            raise PersonalError(401, 'Invalid workspace.')
        with self.lock:
            if owner not in self.controllers:
                if len(self.controllers) >= 8:
                    raise PersonalError(429, 'Personal workspace capacity reached. Restart idle sessions before adding more.')
                self.controllers[owner] = TaskController(self.root,
                    state_dir=self.settings.state_dir / 'owners' / owner,
                    personal=self, owner=owner, pool=self.pool)
            return self.controllers[owner]

    def disconnect(self, owner, revoke=False):
        if revoke:
            self.oauth.revoke(owner)
        self.store.disconnect(owner)
        self.broker.invalidate(owner)
        with self.lock:
            controller = self.controllers.pop(owner, None)
        if controller:
            controller.close()

    def close(self):
        self.uploads.close()
        for controller in list(self.controllers.values()):
            controller.close()
        if self.owns_pool:
            self.pool.shutdown(wait=True, cancel_futures=True)
        self.broker.close(); self.store.close()

    def status(self, session):
        if not session:
            return {'enabled': True, 'login_available': bool(self.settings.client_id), 'user': None, 'connection': None, 'csrf': None}
        conn = self.store.connection(session['owner'], token=True)
        public = None
        if conn:
            scope = conn['token'].get('scope') or []
            granted = set(scope.split() if isinstance(scope, str) else scope)
            public = {key: conn[key] for key in ('id', 'revision', 'active', 'project', 'bucket')}
            public.update(readable=bool(conn['active'] and ({EE_READ, EE_WRITE} & granted)),
                          uploadable=bool(conn['active'] and {EE_WRITE, STORAGE} <= granted))
        return {'enabled': True, 'login_available': True, 'user': {key: session[key] for key in ('owner', 'email', 'name')},
                'connection': public, 'csrf': session['csrf'],
                'limits': {'raster': self.settings.raster_limit, 'vector': self.settings.vector_limit}}

    def configure(self, owner, project, bucket):
        project = project_id(project)
        if bucket and (not re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]', bucket) or '..' in bucket):
            raise PersonalError(400, 'Enter an existing Cloud Storage bucket name, without gs://.')
        self.cloud.verify(owner, project)
        self.store.configure(owner, project, bucket)

    def execution(self, owner, data_refs):
        with self.lock:
            if sum(job['status'] in {'queued', 'running'} for controller in self.controllers.values() for job in controller.jobs.values()) >= 64:
                raise PersonalError(429, 'The analysis queue is full. Wait for a task to finish.')
        conn = self.store.connection(owner)
        if not conn or not conn['active'] or not conn['project']:
            raise PersonalError(409, 'Connect Earth Engine and verify a project before starting analysis.')
        self.oauth.token(owner, (EE_READ,))
        if len(data_refs) > 20 or len(set(data_refs)) != len(data_refs):
            raise PersonalError(400, 'Select up to 20 distinct data inputs.')
        inputs = [self.store.get('datasets', owner, ref) for ref in data_refs]
        execution = {'mode': 'personal', 'owner': owner, 'connection_id': conn['id'],
                     'revision': conn['revision'], 'project': conn['project'], 'data_refs': inputs}
        self.validate_execution(execution, check_assets=True)
        return copy.deepcopy(execution)

    def validate_execution(self, execution, check_assets=False, replay=False):
        conn = self.store.connection(execution['owner'])
        if not conn or not conn['active'] or conn['id'] != execution.get('connection_id'):
            raise PersonalError(401, 'Reconnect the original Earth Engine account.')
        if conn['revision'] != execution.get('revision'):
            if not replay:
                raise PersonalError(409, 'The original connection changed. Send a new analysis request.')
            execution['revision'] = conn['revision']
        if check_assets:
            self.cloud.verify(execution['owner'], execution['project'])
            for row in execution.get('data_refs', []):
                stored = self.store.get('datasets', execution['owner'], row['id'])
                if stored['asset_id'] != row['asset_id'] or row['connection_id'] != conn['id'] or row.get('status') != 'ready':
                    raise PersonalError(403, 'An input is not ready or belongs to another connection.')
                fresh = self.cloud.asset(execution['owner'], row['asset_id'])
                if fresh.get('type') != row['type'] or (row.get('updated_at') and fresh.get('updateTime') != row['updated_at']):
                    raise PersonalError(409, 'An input asset changed. Refresh and select it again before analysis.')
        return execution

    def register_asset(self, owner, name):
        conn = self.store.connection(owner)
        if not conn or not conn['active'] or not conn['project']:
            raise PersonalError(409, 'Verify your Earth Engine project first.')
        info = self.cloud.asset(owner, asset_name(name))
        if info.get('type') not in {'IMAGE', 'IMAGE_COLLECTION', 'TABLE'}:
            raise PersonalError(422, 'Select an Image, ImageCollection or Table asset.')
        existing = next((r for r in self.store.list('datasets', owner) if r['asset_id'] == info['name']), None)
        row = {'id': existing['id'] if existing else uuid.uuid4().hex, 'owner': owner,
               'connection_id': conn['id'], 'asset_id': info['name'], 'type': info['type'],
               'name': info['name'].rsplit('/', 1)[-1], 'updated_at': info.get('updateTime'),
               'bands': [{'id': b.get('id'), 'dataType': b.get('dataType')} for b in info.get('bands', [])][:100],
               'status': 'ready'}
        self.store.put('datasets', owner, row)
        return row

    def show_asset(self, owner, reference, bounds, start=None, end=None, reducer='median'):
        from ..controller import validate_bounds
        from ..layer_generation import generation_recipe
        controller = self.controller(owner)
        execution = self.execution(owner, [reference])
        row = execution['data_refs'][0]
        code = 'result = analysis_inputs[' + json.dumps(reference) + ']'
        if row['type'] == 'TABLE':
            code += '.style(color="5574b5", fillColor="5574b533", width=2)'
        elif row['type'] == 'IMAGE_COLLECTION':
            from datetime import date
            try:
                if not start or not end or date.fromisoformat(start) >= date.fromisoformat(end):
                    raise ValueError()
            except ValueError as exc:
                raise PersonalError(400, 'Choose a valid start and exclusive end date for this collection.') from exc
            if reducer not in {'median', 'mosaic'}:
                raise PersonalError(400, 'Choose median or mosaic.')
            code += f'.filterDate({json.dumps(start)}, {json.dumps(end)}).filterBounds(analysis_region).{reducer}()'
        bounds = validate_bounds(bounds)
        context = {'bounds': bounds, 'analysis_region': None, 'execution': execution}
        payload = {'layer_code': code + '.clip(analysis_region)', 'bounds': bounds,
                   'visualization': {'name': row['name']}, 'metadata': {'source': 'Personal Earth Engine', 'dataset_id': row['asset_id']},
                   'analysis_context': context}
        with controller.conversation_lock, controller.lock:
            cid = controller.conversation_id
            job_id = 'asset-' + uuid.uuid4().hex[:12]
            marker = (cid, job_id)
            controller._layer_reloads.add(marker)
        try:
            controller.prepare_payload(payload, replay=True)
            layer = controller.layer_worker.run(payload)
            layer['generation'] = generation_recipe(payload['layer_code'], layer, context)
            layer['code'], layer['reloadable'] = payload['layer_code'], True
            with controller.conversation_lock, controller.lock:
                if controller._closed:
                    raise PersonalError(409, 'The workspace disconnected before the layer completed.')
                messages = controller._conversation_messages(cid)
                messages.append({'id': uuid.uuid4().hex, 'role': 'assistant', 'job_id': job_id,
                                 'content': 'Data displayed in the captured map extent.', 'layers': [layer], 'status': 'completed'})
                controller._save_conversation(cid, messages)
        finally:
            with controller.lock:
                controller._layer_reloads.discard(marker)
        return controller.conversation()

"""Per-layer replay recipes and bounded calls to the existing GEE worker."""
from __future__ import annotations

import ast
import copy
import json
import os
import subprocess
import sys
import threading
import uuid
from pathlib import Path

from .gee_worker import checked_code


def generation_recipe(code, layer, context=None):
    if not isinstance(code, str) or not code.strip():
        return None
    return {'version': 2 if (context or {}).get('execution') else 1, 'code': code,
            'visualization': {'name': layer.get('name', 'GEE result layer'), **(layer.get('visualization') or {})},
            'bounds': copy.deepcopy(layer.get('bounds')),
            'metadata': copy.deepcopy(layer.get('metadata') or {}),
            'legend': copy.deepcopy(layer.get('legend')),
            'analysis_context': copy.deepcopy(context)}


def replay_payload(recipe):
    if not isinstance(recipe, dict) or recipe.get('version') not in {1, 2}:
        raise ValueError('Original generation parameters are unavailable for this layer.')
    code = recipe.get('code')
    checked_code(code)
    if recipe.get('analysis_context') is None:
        tree = ast.parse(code)
        stored = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
        required = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
        if (required - stored) & {'analysis_region', 'analysis_region_geojson'}:
            raise ValueError('The original analysis region is unavailable. Run the original analysis again.')
    return copy.deepcopy({'layer_code': code, 'visualization': recipe.get('visualization') or {},
                          'bounds': recipe.get('bounds'), 'metadata': recipe.get('metadata') or {},
                          'legend': recipe.get('legend'), 'analysis_context': recipe.get('analysis_context')})


def restore_generation_recipes(messages, conversation_id):
    """Recover legacy code only from unambiguous successful layer tool calls.

    Never split message-wide concatenated code or infer scope from today's map.
    Ambiguous/missing legacy records stay readable and cannot be replayed.
    """
    users = {m.get('job_id'): m for m in messages if m.get('role') == 'user'}
    for message in messages:
        if message.get('role') != 'assistant':
            continue
        layers = message.get('layers') or []
        calls = {}
        for row in message.get('trace') or []:
            if row.get('kind') != 'tool' or row.get('name') != 'gee_layer' or row.get('status') != 'done':
                continue
            try:
                args = json.loads(row['arguments']) if isinstance(row.get('arguments'), str) else row.get('arguments')
                if isinstance(args, dict) and isinstance(args.get('code'), str):
                    calls.setdefault(args.get('name'), []).append(args)
            except (ValueError, KeyError):
                continue
        user = users.get(message.get('job_id'), {})
        context = ({'task_id': message.get('job_id'), 'conversation_id': conversation_id,
                    'bounds': user.get('bounds'), 'analysis_region': user.get('analysis_region'),
                    **({'execution': user['execution']} if user.get('execution') else {})}
                   if user.get('bounds') is not None else None)
        for layer in layers:
            if not layer.get('generation'):
                if isinstance(layer.get('code'), str) and layer['code'].strip():
                    layer['generation'] = generation_recipe(layer['code'], layer, context)
                matching = calls.get(layer.get('name'), [])
                if not layer.get('generation') and len(matching) == 1 and sum(item.get('name') == layer.get('name') for item in layers) == 1:
                    args = matching[0]
                    original = {**layer, 'bounds': args.get('bounds', layer.get('bounds')),
                                'visualization': {k: args[k] for k in ('bands', 'min', 'max', 'palette') if k in args},
                                'metadata': args.get('metadata') or layer.get('metadata') or {},
                                'legend': args.get('legend') or layer.get('legend')}
                    layer['generation'] = generation_recipe(args['code'], original, context)
            recipe = layer.get('generation')
            layer['code'] = recipe.get('code', '') if isinstance(recipe, dict) else layer.get('code', '')
            try:
                replay_payload(recipe)
                layer['reloadable'] = True
                layer.pop('reload_unavailable_reason', None)
            except ValueError as exc:
                layer['reloadable'] = False
                layer['reload_unavailable_reason'] = str(exc)
    return messages


class LayerWorkerRunner:
    """Independent requests use the same worker protocol/restrictions as DSH.

    No model run is needed to regenerate a map ID. Process isolation also keeps
    replay geometry independent from an ongoing chat's persistent worker.
    """
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.Lock()
        self.processes = set()
        self.closed = False
        self.concurrency_gate = None

    def run(self, payload):
        gate = self.concurrency_gate
        if gate and not gate.acquire(blocking=False):
            raise RuntimeError('Two layers are already reloading. Please wait and try again.')
        try:
            return self._run(payload)
        finally:
            if gate:
                gate.release()

    def _run(self, payload):
        payload = copy.deepcopy(payload)
        runtime = payload.pop('_worker_env', {})
        environment = {**os.environ, 'SATGPT_GEE_BROKER': '', 'SATGPT_GEE_LEASE': '', **runtime}
        for name in ('OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'AIHUBMIX_API_KEY', 'GOOGLE_OAUTH_CLIENT_SECRET', 'SATGPT_TOKEN_ENCRYPTION_KEY'):
            environment.pop(name, None)
        environment.pop('GOOGLE_APPLICATION_CREDENTIALS', None)
        worker = self.root / 'app' / 'gee_worker.py'
        if not worker.is_file():
            worker = Path(__file__).with_name('gee_worker.py')
        with self.lock:
            if self.closed:
                raise RuntimeError('Layer worker is shutting down.')
            if len(self.processes) >= 2:
                raise RuntimeError('Two layers are already reloading. Please wait and try again.')
            process = subprocess.Popen([sys.executable, '-X', 'utf8', '-I', str(worker)],
                                       cwd=self.root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                                       env=environment,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            self.processes.add(process)
        request_id = uuid.uuid4().hex
        try:
            request = {'id': request_id, 'payload': {**payload, 'project': os.getenv('GEE_PROJECT_ID')}}
            try:
                stdout, _ = process.communicate(json.dumps(request) + '\n', timeout=150)
            except subprocess.TimeoutExpired as exc:
                process.kill(); process.communicate()
                raise TimeoutError('GEE layer reload timed out. Please try again.') from exc
            try:
                result = json.loads(stdout)
            except ValueError as exc:
                raise ValueError('The GEE worker returned an invalid response.') from exc
            if not isinstance(result, dict):
                raise ValueError('The GEE worker returned an invalid response.')
            if result.get('id') != request_id or not result.get('ok'):
                raise ValueError(result.get('error') or 'GEE could not reload this layer.')
            if not isinstance(result.get('data', {}).get('layer'), dict):
                raise ValueError('The GEE worker did not return a layer.')
            return result['data']['layer']
        finally:
            with self.lock:
                self.processes.discard(process)
            if process.poll() is None:
                process.kill(); process.communicate()

    def close(self):
        with self.lock:
            self.closed = True
            for process in self.processes:
                if process.poll() is None:
                    process.kill()

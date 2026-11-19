"""Per-layer replay recipes and validation for the shared GEE worker pool."""
from __future__ import annotations

import ast
import copy
import json

from .gee_worker import checked_code


def generation_recipe(code, layer, context=None):
    if not isinstance(code, str) or not code.strip():
        return None
    return {'version': 1, 'code': code,
            'visualization': {'name': layer.get('name', 'GEE result layer'), **(layer.get('visualization') or {})},
            'bounds': copy.deepcopy(layer.get('bounds')),
            'metadata': copy.deepcopy(layer.get('metadata') or {}),
            'legend': copy.deepcopy(layer.get('legend')),
            'analysis_context': copy.deepcopy(context)}


def replay_payload(recipe):
    if not isinstance(recipe, dict) or recipe.get('version') != 1:
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
                    'bounds': user.get('bounds'), 'analysis_region': user.get('analysis_region')}
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

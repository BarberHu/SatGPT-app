"""Bounded thumbnail jobs for already-delivered Agent layers."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import re
import sqlite3

from .gee_worker import thumbnail_recipe_path
from .shared_runtime import RuntimeUnavailable


def valid_ref(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{32}', value) is not None


class LayerThumbnails:
    def __init__(self, controller):
        self.controller = controller
        self.active = set()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='satgpt-thumbnail')

    def schedule(self, owner, receipt):
        controller = self.controller
        cid, job_id = receipt['conversation_id'], receipt['id']
        directory = Path(controller._artifact_fields(owner, cid, job_id)['artifact_dir'])
        kept = set()
        if receipt['status'] == 'completed':
            for index, layer in enumerate(receipt['output'].get('layers', [])):
                ref = layer.get('thumbnail_ref')
                if not valid_ref(ref):
                    continue
                layer_id, version = f'{job_id}-{index}', layer.get('reload_version', 0)
                if controller.closed.is_set() or len(self.active) >= 16:
                    self.finish(owner, cid, layer_id, version, ref, None)
                else:
                    self.active.add(ref)
                    kept.add(f'thumbnail-{ref}.json')
                    self.executor.submit(self.render, owner, cid, job_id, layer_id, version, ref,
                                         layer.get('thumbnail_call_id'))
        for recipe in directory.glob('thumbnail-*.json'):
            if recipe.name not in kept and valid_ref(recipe.stem.removeprefix('thumbnail-')):
                self.discard(recipe)

    @staticmethod
    def discard(path):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    def render(self, owner, cid, job_id, layer_id, version, ref, tool_call_id):
        controller = self.controller
        fields = controller._artifact_fields(owner, cid, job_id)
        thumbnail = None
        try:
            with controller.store.connect() as db:
                row = controller.store.owned(db, owner, cid)
                _, _, layer = controller._find_layer(json.loads(row['messages']), layer_id)
                if not self.matches(layer, version, ref) or controller.closed.is_set():
                    return
            payload = {**fields, 'thumbnail_ref': ref, 'analysis_context': {'task_id': job_id}}
            body = {'owner_id': owner, 'payload': payload, 'tool_call_id': tool_call_id}
            value = controller.runtime.control('/thumbnail', body, timeout=50).get('thumbnail')
            if (isinstance(value, dict) and value.get('url') == f"{fields['artifact_url']}/{ref}.png"
                    and all(type(value.get(axis)) is int and value[axis] > 0 for axis in ('width', 'height'))):
                thumbnail = {key: value[key] for key in ('url', 'width', 'height')}
        except (OSError, ValueError, RuntimeUnavailable, sqlite3.Error):
            pass
        finally:
            accepted = False
            with controller.lock:
                try:
                    accepted = self.finish(owner, cid, layer_id, version, ref, thumbnail)
                except sqlite3.Error:
                    pass  # The status read resolves any pending record without a live job.
                finally:
                    self.discard(thumbnail_recipe_path(fields['artifact_dir'], ref))
                    if not accepted or not thumbnail:
                        self.discard(Path(fields['artifact_dir']) / f'{ref}.png')
                    self.active.discard(ref)

    @staticmethod
    def matches(layer, version, ref):
        return (layer.get('reload_version', 0) == version and layer.get('thumbnail_ref') == ref
                and layer.get('thumbnail_status') == 'pending')

    @staticmethod
    def apply(layer, thumbnail):
        layer.pop('thumbnail_ref', None)
        layer.pop('thumbnail_call_id', None)
        layer['thumbnail_status'] = 'ready' if thumbnail else 'unavailable'
        if thumbnail:
            layer['thumbnail'] = thumbnail
        else:
            layer.pop('thumbnail', None)

    def finish(self, owner, cid, layer_id, version, ref, thumbnail):
        controller = self.controller
        try:
            with controller.store.connect(write=True) as db:
                row = controller.store.owned(db, owner, cid)
                messages = json.loads(row['messages'])
                item, index, layer = controller._find_layer(messages, layer_id)
                if not self.matches(layer, version, ref):
                    return False
                self.apply(layer, thumbnail)
                controller.store.save_messages(db, cid, messages, touch=False)
                self.update_receipt(db, owner, item['job_id'], index, version, ref, thumbnail)
                return True
        except FileNotFoundError:
            return False

    def update_receipt(self, db, owner, job_id, index, version, ref, thumbnail):
        store = self.controller.store
        receipt = store.read_task(db, owner, job_id)
        layers = (receipt.get('output') or {}).get('layers') or []
        if index < len(layers) and self.matches(layers[index], version, ref):
            self.apply(layers[index], thumbnail)
            store.save_task(db, receipt)

    def states(self, owner, cid, ids):
        controller = self.controller
        with controller.lock:
            with controller.store.connect() as db:
                row = controller.store.owned(db, owner, cid)
                messages = json.loads(row['messages'])
            result = []
            for layer_id in ids:
                item, _, layer = controller._find_layer(messages, layer_id)
                version = layer.get('reload_version', 0)
                ref = layer.get('thumbnail_ref')
                status = layer.get('thumbnail_status') or ('ready' if layer.get('thumbnail') else 'unavailable')
                if status == 'pending' and ref not in self.active:
                    self.finish(owner, cid, layer_id, version, ref, None)
                    if valid_ref(ref):
                        directory = controller._artifact_fields(owner, cid, item['job_id'])['artifact_dir']
                        self.discard(thumbnail_recipe_path(directory, ref))
                        self.discard(Path(directory) / f'{ref}.png')
                    status = 'unavailable'
                result.append({'layer_id': layer_id, 'reload_version': version, 'thumbnail_status': status,
                               'thumbnail': layer.get('thumbnail') if status == 'ready' else None})
            return result

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)

"""One DeepSeek Harness process with resident native sessions."""

from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from satgpt_config import integer

from .bootstrap import ensure_plugin
from .model_config import harness_model_options, selected_max_tokens
from .stream_bridge import StreamBridge


class RuntimeUnavailable(RuntimeError):
    pass


class SharedRuntime:
    def __init__(self, root: Path, home: Path, workers: int, resident_limit: int):
        self.root = root.resolve()
        self.home = home.resolve()
        self.workers = workers
        self.resident_limit = resident_limit
        self.workspace = self.home.parent / 'agent-workspace'
        self.lock = threading.Lock()
        self.lifecycle = threading.RLock()
        self.sessions = {}
        self.client = None
        self.bridge = None
        self.available = threading.Event()
        self.stop_draining = threading.Event()
        self.opener = build_opener(ProxyHandler({}))
        self.drainer = None
        self.port = None
        self.token = None
        self.reasoning = None
        self.default_reasoning_effort = None

    def start(self):
        with self.lifecycle:
            self._start()

    def _start(self):
        from deepseek_harness import DeepSeekHarness

        self.home.mkdir(parents=True, exist_ok=True)
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.bridge = StreamBridge(self.home)
        port_file = self.bridge.directory / 'control.port'
        self.token = secrets.token_urlsafe(32)
        try:
            ensure_plugin(self.home)
            options = harness_model_options(self.home)
            self.provider = options['provider']
            self.model = options['model']
            self.default_reasoning_effort = options.get('reasoning_effort')
            self.client = DeepSeekHarness(
                **options, max_tokens=selected_max_tokens(), cwd=str(self.workspace),
                runtime_cwd=(os.environ.get('SystemDrive', 'C:') + '\\') if os.name == 'nt' else str(self.workspace),
                dsh_home=str(self.home), profile='sdk',
                env={**self.bridge.environment(), 'WEBGIS_ROOT': str(self.root),
                     'SATGPT_HARNESS_PYTHON': sys.executable, 'SATGPT_GEE_WORKERS': str(self.workers),
                     'SATGPT_GEE_QUEUE_LIMIT': str(integer('SATGPT_GEE_QUEUE_LIMIT')),
                     'SATGPT_OSM_TOOLS': os.environ.get('SATGPT_OSM_TOOLS', '0'),
                     'SATGPT_OVERPASS_URL': os.environ.get('SATGPT_OVERPASS_URL', ''),
                     'SATGPT_ROAD_SNAPSHOT': os.environ.get('SATGPT_ROAD_SNAPSHOT', ''),
                     'SATGPT_OSM_SNAPSHOT_DIR': os.environ.get('SATGPT_OSM_SNAPSHOT_DIR', ''),
                     'SATGPT_GEOCODING_URL': os.environ.get('SATGPT_GEOCODING_URL', '').strip(),
                     'SATGPT_GEOCODING_LOCK_FILE': str(self.root / 'state' / 'nominatim-rate.sqlite3'),
                     **{name: os.environ.get(name, '') for name in (
                         'SATGPT_FLEXTH_PYTHON', 'SATGPT_FLEXTH_SCRIPT', 'SATGPT_FLEXTH_DTM', 'SATGPT_FLEXTH_DTM_SOURCE')},
                     'SATGPT_HARNESS_TIMING_LOG': os.environ.get('SATGPT_HARNESS_TIMING_LOG', ''),
                     'SATGPT_CATALOG_CACHE': str(self.home.parent / 'catalog'),
                     'SATGPT_CONTROL_TOKEN': self.token, 'SATGPT_CONTROL_PORT_FILE': str(port_file),
                     'DSH_TELEMETRY_DISABLED': '1'},
                # Individual protocol waits have a backstop. The controller owns the turn deadline.
                request_timeout_seconds=120, shutdown_timeout_seconds=10,
            )
            self.client.start()
            deadline = time.monotonic() + 5
            while not port_file.is_file() and time.monotonic() < deadline:
                time.sleep(.025)
            self.port = int(port_file.read_text(encoding='ascii'))
            self.control('/health')
            try:
                self._load_reasoning()
            except RuntimeUnavailable:
                # Chat can still use the deployment default without a capability response.
                self.reasoning = None
            self.stop_draining.clear()
            self.available.set()
            self.drainer = threading.Thread(target=self._drain, args=(self.client.client,),
                                            daemon=True, name='harness-sdk-notifications')
            self.drainer.start()
        except Exception:
            self.close()
            raise

    def _load_reasoning(self):
        options = self.control('/reasoning', {'provider': self.provider, 'model': self.model})
        self.reasoning = {**options, 'model': options.get('model') or self.model}
        return self.reasoning

    def reasoning_options(self):
        if self.reasoning is not None:
            return self.reasoning
        if not self.available.is_set():
            raise RuntimeUnavailable('Reasoning capabilities are unavailable')
        with self.lifecycle:
            if not self.available.is_set():
                raise RuntimeUnavailable('Reasoning capabilities are unavailable')
            return self.reasoning if self.reasoning is not None else self._load_reasoning()

    def _drain(self, client):
        # The SDK queues unmatched notifications separately from Session.run subscriptions.
        try:
            while not self.stop_draining.is_set():
                client.next_notification()
        except Exception:
            if not self.stop_draining.is_set():
                self.available.clear()

    def full_for(self, native_id):
        with self.lock:
            return native_id not in self.sessions and len(self.sessions) >= self.resident_limit

    def reserve(self, native_id):
        with self.lock:
            if native_id in self.sessions:
                return
            if len(self.sessions) >= self.resident_limit:
                raise RuntimeUnavailable('Native session capacity reached')
            self.sessions[native_id] = None

    def open(self, native_id, *, resume):
        # The application's per-conversation admission serializes requests to this slot.
        with self.lock:
            existing = self.sessions[native_id]
        if isinstance(existing, Exception):
            raise RuntimeError('Native session could not be opened. Review the saved session or start a new chat.') from existing
        if existing is not None:
            return existing
        try:
            if resume:
                session = self.client.resume_session(native_id)
            else:
                session = self.client.start_session(native_id)
                # start_session creates a Python handle; this documented RPC opens its native Agent.
                session.get_working_directory()
        except Exception as error:
            with self.lock:
                self.sessions[native_id] = error
            raise RuntimeError('Saved native session could not be resumed.' if resume else
                               'Native session could not be opened.') from error
        with self.lock:
            self.sessions[native_id] = session
        return session

    def control(self, route, body=None, *, timeout=2):
        data = json.dumps(body, allow_nan=False).encode() if body is not None else None
        request = Request(f'http://127.0.0.1:{self.port}{route}', data=data,
                          headers={'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=timeout) as response:
                payload = response.read(2_000_001)
                if len(payload) > 2_000_000:
                    raise RuntimeUnavailable('Harness control response exceeded its limit')
                result = json.loads(payload)
                if not isinstance(result, dict) or (route == '/cancel' and type(result.get('accepted')) is not bool):
                    raise RuntimeUnavailable('Harness control response was invalid')
                return result
        except HTTPError as exc:
            with exc:
                if route == '/reload' and exc.code == 422:
                    content = json.loads(exc.read(1000) or b'{}')
                    raise ValueError(content.get('error', 'GEE layer reload failed')) from None
            if route == '/cancel' and exc.code == 404:
                return {'accepted': False}
            raise RuntimeUnavailable('Harness control channel rejected the request') from None
        except (OSError, URLError, ValueError):
            raise RuntimeUnavailable('Harness control channel is unavailable') from None

    def close(self):
        with self.lifecycle:
            self._close()

    def _close(self):
        self.available.clear()
        self.reasoning = None
        self.stop_draining.set()
        try:
            if self.client is not None:
                self.client.close()
        finally:
            self.client = None
            if self.drainer is not None:
                self.drainer.join(timeout=3)
                self.drainer = None
            if self.bridge is not None:
                self.bridge.close()
                self.bridge = None
            with self.lock:
                self.sessions.clear()

"""DeepSeek Harness SDK session adapter."""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

from .bootstrap import ensure_plugin
from .model_config import harness_model_options, selected_max_tokens
from .stream_bridge import StreamBridge


def describe_run_failure(result, provider: str) -> str:
    for event in reversed(result.events):
        if event.get("type") != "turn/end":
            continue
        error = event.get("data", {}).get("reason", {}).get("error", {})
        code = error.get("code", "UNKNOWN")
        if code == "AUTH":
            service = "AIHubMix" if provider == "aihubmix" else "Model provider"
            return f"{service} rejected the API key (401). Check the key and provider."
        return f"Harness run did not complete: {result.finish_reason} ({code})"
    return f"Harness run did not complete: {result.finish_reason}"


class HarnessAgent:
    def __init__(self, workspace: Path, home: Path, session_id: str):
        self.workspace = workspace.resolve()
        self.home = home.resolve()
        self.session_id = session_id
        self.harness = None
        self.session = None
        self.provider = None
        self.bridge = None
        self.require_resume = False
        self._lifecycle_lock = threading.RLock()
        self._cancelled = threading.Event()

    def __enter__(self):
        with self._lifecycle_lock:
            try:
                if self._cancelled.is_set():
                    raise RuntimeError('Run stopped by user')
                agent = self._enter()
                if self._cancelled.is_set():
                    raise RuntimeError('Run stopped by user')
                return agent
            except Exception:
                self.__exit__(None, None, None)
                raise

    def _enter(self):
        from deepseek_harness import DeepSeekHarness

        self.workspace.mkdir(parents=True, exist_ok=True)
        self.home.mkdir(parents=True, exist_ok=True)
        self.bridge = StreamBridge(self.home)
        runtime_env = {"WEBGIS_ROOT": str(self.home.parent.parent),
                       "SATGPT_HARNESS_PYTHON": sys.executable, "PYTHONIOENCODING": "utf-8",
                       **self.bridge.environment()}
        ensure_plugin(self.home)
        options = harness_model_options(self.home)
        self.provider = options["provider"]
        self.harness = DeepSeekHarness(
            **options,
            max_tokens=selected_max_tokens(),
            cwd=str(self.workspace),
            runtime_cwd=(os.environ.get("SystemDrive", "C:") + "\\") if os.name == "nt" else str(self.workspace),
            dsh_home=str(self.home),
            profile="sdk",
            env=runtime_env,
        )
        self.harness.start()
        try:
            self.session = self.harness.resume_session(self.session_id)
        except Exception as exc:
            if f'session "{self.session_id}"' not in str(exc):
                raise
            if self.require_resume:
                raise RuntimeError('The DSH session file is unavailable. Start a new conversation to continue.') from exc
            self.session = self.harness.start_session(self.session_id)
        return self

    def __exit__(self, *_exc):
        with self._lifecycle_lock:
            try:
                if self.harness is not None:
                    self.harness.close()
            finally:
                self.harness = self.session = None
                if self.bridge is not None:
                    self.bridge.close()
                    self.bridge = None

    def cancel(self):
        # SDK close shuts down the runtime and unblocks an in-flight session.run;
        # disconnecting the browser's event stream alone cannot stop execution.
        self._cancelled.set()
        self.__exit__(None, None, None)

    def run(self, prompt: str, session_id: str, on_event=None, on_stream=None) -> str:
        with self._lifecycle_lock:
            if self._cancelled.is_set() or self.session is None or session_id != self.session_id:
                raise RuntimeError("Harness session is not ready or the session ID does not match")
            session, bridge = self.session, self.bridge
            bridge.bind(session_id, on_stream)
        try:
            result = session.run(prompt, on_notification=on_event)
            # A turn/end barrier shares the plugin's ordered HTTP queue. The SDK
            # transport may return first, so allow its presentation channel to drain.
            if not self._cancelled.is_set():
                bridge.drained.wait(timeout=3)
        finally:
            bridge.unbind()
        if result.finish_reason != "completed":
            raise RuntimeError(describe_run_failure(result, self.provider or ""))
        return result.final_response


def conversation_prompt(request: str, bounds: list[float], catalog: list[dict]) -> str:
    return f"""You are SatGPT's geospatial analysis assistant. Answer general questions normally; use the registered GEE tools whenever data is needed.
Use English by default for answers, progress summaries, layer and preview names, metadata descriptions, and legend labels. Follow an explicit user request for another language.
When the user requests a chart, or a chart helps explain verified numerical results, include a lowercase echarts fenced code block containing only a strict JSON ECharts option object. The frontend renders it automatically after streaming finishes. Use double-quoted keys and strings; no comments, JavaScript functions, expressions, external images, title links, custom series, or toolbox dataView. Use string-template formatters and tooltip.trigger="axis" or "item"; tooltips use Canvas rich text, so avoid HTML markup. Keep charts readable in a narrow chat panel: short titles and labels, a contained grid, legends clear of titles, and labeled axes with units. Explain the data source, date range, units, and missing values outside the fence. Never invent observations; when the user supplies data, chart those values, and label synthetic demonstration data explicitly. No GEE call is needed just to visualize values already supplied by the user.
Tool Python runs in a separate worker with ee already available. Assign the output to result. Verify uncertain dataset IDs with gee_catalog; use gee_eval to check coverage and statistics, gee_preview to inspect imagery, and gee_layer to create interactive layers. For gee_layer, supply bounds=[west,south,east,north] for the actual study area; do not use the current map extent to locate results for a different area. Use metadata for verified source, dataset_id, observed_at date or range, unit, and a short description; omit unknown information. Layers automatically receive static thumbnails; legends use palette/min/max. For consecutive integer classes, provide legend.labels in palette order. Correct tool errors and retry when appropriate; diagnose connection failures with gee_status.
Use public datasets only; do not export or modify assets. A visible disaster layer does not establish a reliable event conclusion: explain observation dates, coverage, and methodological limitations. Only claim a layer is displayed after a successful tool result. Filter early by date, region, and bands; specify scale, geometry, and maxPixels for large-area statistics.
Current map bounds [west,south,east,north]: {json.dumps(bounds)}. Reference catalog: {json.dumps(catalog, ensure_ascii=False)}.
User request: {request}"""

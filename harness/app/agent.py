"""DeepSeek Harness SDK session adapter."""

from __future__ import annotations

import json
import os
import sys
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

    def __enter__(self):
        try:
            return self._enter()
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
        try:
            if self.harness is not None:
                self.harness.close()
        finally:
            if self.bridge is not None:
                self.bridge.close()

    def run(self, prompt: str, session_id: str, on_event=None, on_stream=None) -> str:
        if self.session is None or session_id != self.session_id:
            raise RuntimeError("Harness session is not ready or the session ID does not match")
        self.bridge.bind(session_id, on_stream)
        try:
            result = self.session.run(prompt, on_notification=on_event)
            # A turn/end barrier shares the plugin's ordered HTTP queue. The SDK
            # transport may return first, so allow its presentation channel to drain.
            self.bridge.drained.wait(timeout=3)
        finally:
            self.bridge.unbind()
        if result.finish_reason != "completed":
            raise RuntimeError(describe_run_failure(result, self.provider or ""))
        return result.final_response


def conversation_prompt(request: str, bounds: list[float], catalog: list[dict]) -> str:
    return f"""You are SatGPT's geospatial analysis assistant. Answer general questions normally; use the registered GEE tools whenever data is needed.
Use English by default for answers, progress summaries, layer and preview names, metadata descriptions, and legend labels. Follow an explicit user request for another language.
Tool Python runs in a separate worker with ee already available. Assign the output to result. Verify uncertain dataset IDs with gee_catalog; use gee_eval to check coverage and statistics, gee_preview to inspect imagery, and gee_layer to create interactive layers. For gee_layer, supply bounds=[west,south,east,north] for the actual study area; do not use the current map extent to locate results for a different area. Use metadata for verified source, dataset_id, observed_at date or range, unit, and a short description; omit unknown information. Layers automatically receive static thumbnails; legends use palette/min/max. For consecutive integer classes, provide legend.labels in palette order. Correct tool errors and retry when appropriate; diagnose connection failures with gee_status.
Use public datasets only; do not export or modify assets. A visible disaster layer does not establish a reliable event conclusion: explain observation dates, coverage, and methodological limitations. Only claim a layer is displayed after a successful tool result. Filter early by date, region, and bands; specify scale, geometry, and maxPixels for large-area statistics.
Current map bounds [west,south,east,north]: {json.dumps(bounds)}. Reference catalog: {json.dumps(catalog, ensure_ascii=False)}.
User request: {request}"""

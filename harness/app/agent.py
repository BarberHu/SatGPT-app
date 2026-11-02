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
            service = "AIHubMix" if provider == "aihubmix" else "模型服务"
            return f"{service} 拒绝了 API 密钥（401）。请检查密钥与服务商。"
        return f"Harness 运行未完成：{result.finish_reason}（{code}）"
    return f"Harness 运行未完成：{result.finish_reason}"


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
                raise RuntimeError('该对话的 DSH 会话文件不可用，无法继续原有上下文；请新建对话') from exc
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
            raise RuntimeError("Harness 会话未就绪或 ID 不匹配")
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
    return f"""你是 SatGPT 中的地理空间分析助手。正常回答普通问题；需要数据时自主调用已注册的 GEE 工具。
工具中的 Python 运行在独立 worker，ee 已提供，必须把结果赋给 result。数据集 ID 不确定时先用 gee_catalog 核查；使用 gee_eval 做覆盖和统计检查，gee_preview 检查影像外观，gee_layer 创建交互图层。调用 gee_layer 时用 bounds=[西,南,东,北] 标明图层实际研究区域，不要把当前地图视野当作其他地区结果的定位范围。工具报错时可以修正并重试，连接故障用 gee_status 诊断。
仅使用公开数据集，不导出或修改资产。对灾害事件，图层可显示不代表事件结论可靠；需要说明观测时间、覆盖和方法限制。只有工具成功返回图层时才说已显示。尽早按日期、区域和波段过滤；大区域统计明确 scale、geometry、maxPixels。
当前地图范围 [西,南,东,北]：{json.dumps(bounds)}。参考目录：{json.dumps(catalog, ensure_ascii=False)}。
用户请求：{request}"""

"""One-task-at-a-time prototype controller with bounded repair attempts."""

from __future__ import annotations

import ast
import json
import os
import threading
import uuid
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from .agent import HarnessAgent, conversation_prompt
from .model_config import model_key_configured, selected_provider
from .trace import add_harness_event, remove_final_answer
from .task_stream import TaskStream


def validate_bounds(value) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError("bounds 必须是 [西,南,东,北]")
    try:
        west, south, east, north = [float(number) for number in value]
    except (TypeError, ValueError) as exc:
        raise ValueError("bounds 必须都是数字") from exc
    if not (-180 <= west < east <= 180 and -85 <= south < north <= 85):
        raise ValueError("地图边界超出有效范围")
    return [west, south, east, north]


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


class TaskController:
    def __init__(self, root: Path, agent_factory=HarnessAgent):
        self.root = root
        self.agent_factory = agent_factory
        self.home = root / "state" / "dsh-home"
        self.chat_file = root / "state" / "chat-history.json"
        self.archive_dir = root / "state" / "conversations"
        self.tool_events_file = root / "state" / "gee-tool-events.jsonl"
        self.trace_dir = root / "state" / "traces"
        self._agent = None
        self.jobs: dict[str, dict] = {}
        self.streams: dict[str, TaskStream] = {}
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.conversation_lock = threading.RLock()
        self.conversation_id = "webgis-main"
        self.messages = self._load_messages()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gee-agent")
        self.trace_secrets = self._trace_secrets()

    @staticmethod
    def _trace_secrets() -> tuple[str, ...]:
        secrets = [os.getenv("AIHUBMIX_API_KEY", ""), os.getenv("DEEPSEEK_API_KEY", "")]
        credentials = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        if credentials:
            try:
                key = json.loads(Path(credentials).read_text(encoding="utf-8")).get("private_key", "")
                if isinstance(key, str) and key:
                    secrets.extend((key, json.dumps(key)[1:-1]))
            except (OSError, ValueError, TypeError):
                pass
        return tuple(secret for secret in secrets if len(secret) >= 8)

    def _save_trace(self, job_id: str, trace: list[dict]) -> None:
        self.trace_dir.mkdir(parents=True, exist_ok=True)
        target = self.trace_dir / f"{job_id}.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(trace, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(target)

    def _load_messages(self) -> list[dict]:
        if not self.chat_file.is_file():
            return []
        data = json.loads(self.chat_file.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            conversation_id = data.get("conversation_id")
            if not isinstance(conversation_id, str) or not conversation_id.startswith("webgis-"):
                raise ValueError("对话会话 ID 无效")
            self.conversation_id = conversation_id
            data = data.get("messages")
        if not isinstance(data, list):
            raise ValueError("对话历史格式无效")
        return data[-100:]

    def _save_messages(self) -> None:
        self.chat_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.chat_file.with_suffix(".tmp")
        state = {"conversation_id": self.conversation_id, "messages": self.messages[-100:]}
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.chat_file)

    def conversation(self) -> dict:
        with self.lock:
            active = next((job["id"] for job in reversed(list(self.jobs.values()))
                           if job["status"] in {"queued", "running"}
                           and job['conversation_id'] == self.conversation_id), None)
            return {"conversation_id": self.conversation_id,
                    "messages": json.loads(json.dumps(self.messages, ensure_ascii=False)), "active_task": active}

    def _archive_current(self):
        if not self.messages:
            return
        self.archive_dir.mkdir(parents=True, exist_ok=True)
        target = self.archive_dir / f'{self.conversation_id}.json'
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps({'conversation_id': self.conversation_id, 'messages': self.messages},
                                        ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(target)

    def list_conversations(self):
        with self.conversation_lock, self.lock:
            records = {}
            for file in self.archive_dir.glob('webgis-*.json'):
                try:
                    record = json.loads(file.read_text(encoding='utf-8'))
                    if record.get('conversation_id') == file.stem and isinstance(record.get('messages'), list):
                        records[file.stem] = record['messages']
                except (OSError, ValueError, AttributeError):
                    continue
            records[self.conversation_id] = self.messages
            result = []
            for cid, messages in records.items():
                title = next((m.get('content', '') for m in messages if m.get('role') == 'user'), '新对话')
                result.append({'id': cid, 'title': title[:80], 'current': cid == self.conversation_id,
                               'updated_at': messages[-1].get('created_at', '') if messages else '',
                               'message_count': len(messages)})
            return sorted(result, key=lambda item: (item['updated_at'], item['current']), reverse=True)

    def activate_conversation(self, conversation_id):
        if not re.fullmatch(r'webgis-[A-Za-z0-9_-]{1,80}', conversation_id):
            raise ValueError('对话 ID 无效')
        with self.conversation_lock:
            with self.lock:
                if conversation_id == self.conversation_id:
                    return {'conversation_id': self.conversation_id, 'messages': json.loads(json.dumps(self.messages)),
                            'active_task': next((j['id'] for j in self.jobs.values() if j['conversation_id'] == self.conversation_id
                                                 and j['status'] in {'queued', 'running'}), None)}
                if any(j['status'] in {'queued', 'running'} for j in self.jobs.values()):
                    raise RuntimeError('请等待当前任务结束后切换对话')
                target = self.archive_dir / f'{conversation_id}.json'
                if not target.is_file():
                    raise FileNotFoundError('对话不存在')
                record = json.loads(target.read_text(encoding='utf-8'))
                if record.get('conversation_id') != conversation_id or not isinstance(record.get('messages'), list):
                    raise ValueError('对话历史格式无效')
                self._archive_current()
            if self._agent is not None:
                self._agent.__exit__(None, None, None)
                self._agent = None
            with self.lock:
                self.conversation_id = conversation_id
                self.messages = record['messages'][-100:]
                self._save_messages()
            return self.conversation()

    def new_conversation(self) -> dict:
        with self.conversation_lock:
            with self.lock:
                if any(job["status"] in {"queued", "running"} for job in self.jobs.values()):
                    raise RuntimeError("智能体仍在处理消息，请等待当前任务结束后再创建新对话")
                self._archive_current()
            if self._agent is not None:
                self._agent.__exit__(None, None, None)
                self._agent = None
            with self.lock:
                self.conversation_id = f"webgis-{uuid.uuid4().hex[:16]}"
                self.messages = []
                self._save_messages()
            return self.conversation()

    def _append_message(self, role: str, content: str, job_id: str, **extra) -> None:
        message = {
            "id": uuid.uuid4().hex[:12], "role": role, "content": content,
            "job_id": job_id, "created_at": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        with self.lock:
            self.messages.append(message)
            self.messages = self.messages[-100:]
            self._save_messages()

    def create(self, prompt: str, bounds, conversation_id=None) -> dict:
        if not isinstance(prompt, str) or not (3 <= len(prompt.strip()) <= 2000):
            raise ValueError("任务描述需要 3–2000 个字符")
        bounds = validate_bounds(bounds)
        with self.conversation_lock:
            if conversation_id and conversation_id != self.conversation_id:
                raise RuntimeError('当前对话已切换，请刷新后重试')
            job_id = uuid.uuid4().hex[:12]
            job = {
                "id": job_id, "conversation_id": self.conversation_id,
                "status": "queued", "prompt": prompt.strip(),
                "bounds": bounds, "revision": 0,
                "output": None, "error": None, "trace": [],
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            with self.lock:
                self.jobs[job_id] = job
                self.streams[job_id] = TaskStream(job, secrets=self.trace_secrets)
            self._append_message("user", prompt.strip(), job_id)
            self.pool.submit(self._run, job_id)
            return self.get(job_id)

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(job_id)
            return json.loads(json.dumps(job, ensure_ascii=False)) if job else None

    def wait_for_job(self, job_id: str, after_revision: int, timeout: float = 15) -> dict | None:
        with self.changed:
            self.changed.wait_for(
                lambda: job_id not in self.jobs
                or self.jobs[job_id]["revision"] > after_revision
                or self.jobs[job_id]["status"] in {"completed", "failed"},
                timeout=timeout,
            )
            job = self.jobs.get(job_id)
            return json.loads(json.dumps(job, ensure_ascii=False)) if job else None

    def _update(self, job_id: str, **values) -> None:
        with self.changed:
            self.jobs[job_id].update(values)
            self.jobs[job_id]["revision"] += 1
            self.changed.notify_all()
            self.streams[job_id].update(**values)

    def _event(self, job_id: str, notice) -> None:
        if getattr(notice, "method", None) == "session.event":
            if getattr(notice, 'payload', {}).get('sessionId') != self.jobs[job_id]['conversation_id']:
                return
            event = getattr(notice, "payload", {}).get("event") or {}
            with self.changed:
                trace = self.jobs[job_id]["trace"]
                changed = add_harness_event(trace, event, self.trace_secrets)
                snapshot = json.loads(json.dumps(trace, ensure_ascii=False)) if changed else None
                if changed:
                    self.jobs[job_id]["revision"] += 1
                    self.changed.notify_all()
            if snapshot is not None:
                self._save_trace(job_id, snapshot)
                self.streams[job_id].update(trace=snapshot)

    def _tool_events(self, offset: int) -> list[dict]:
        if not self.tool_events_file.is_file():
            return []
        with self.tool_events_file.open("r", encoding="utf-8") as stream:
            stream.seek(offset)
            lines = stream.readlines()
        events = []
        for line in lines:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ((isinstance(event.get("layer"), dict) and event["layer"].get("url"))
                    or (isinstance(event.get("preview"), dict) and event["preview"].get("url"))):
                events.append(event)
        return events

    def close(self) -> None:
        self.pool.shutdown(wait=True)
        if self._agent is not None:
            self._agent.__exit__(None, None, None)
            self._agent = None

    def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        assert job is not None
        workspace = self.root / "state" / "agent-workspace"
        try:
            workspace.mkdir(parents=True, exist_ok=True)
            started_at = datetime.now(timezone.utc).isoformat()
            self._update(job_id, status="running", started_at=started_at)
            if not model_key_configured():
                key_name = "AIHUBMIX_API_KEY" if selected_provider() == "aihubmix" else "DEEPSEEK_API_KEY"
                raise RuntimeError(f"缺少 {key_name}；请先配置模型 API 密钥")
            if self._agent is None:
                candidate = self.agent_factory(workspace, self.home, job["conversation_id"])
                candidate.require_resume = any(m.get('role') == 'assistant' and m.get('status') != 'failed'
                                               for m in self.messages)
                self._agent = candidate.__enter__()
            prompt = conversation_prompt(job["prompt"], job["bounds"], CATALOG)
            offset = self.tool_events_file.stat().st_size if self.tool_events_file.is_file() else 0
            answer = self._agent.run(prompt, session_id=job["conversation_id"],
                                     on_event=lambda notice: self._event(job_id, notice),
                                     on_stream=self.streams[job_id].frame)
            with self.lock:
                trace = self.jobs[job_id]["trace"]
                remove_final_answer(trace, str(answer or ""))
                trace_snapshot = json.loads(json.dumps(trace, ensure_ascii=False))
            self._save_trace(job_id, trace_snapshot)
            events = self._tool_events(offset)
            layers = [{**event["layer"], "bounds": layer_focus_bounds(event)}
                      for event in events if "layer" in event]
            previews = [event["preview"] for event in events if "preview" in event]
            codes = [event["code"] for event in events if isinstance(event.get("code"), str) and event["code"]]
            message = str(answer or "").strip()
            timeline = self.streams[job_id].finish_timeline(message)
            finished_at = datetime.now(timezone.utc).isoformat()
            output = {"message": message, "layers": layers, "previews": previews}
            self._append_message("assistant", message, job_id, status="completed",
                                 layers=layers,
                                 previews=previews, code="\n\n".join(codes),
                                 trace=trace_snapshot, timeline=timeline, started_at=started_at, finished_at=finished_at)
            self._update(job_id, status="completed", output=output, error=None, finished_at=finished_at)
        except Exception as exc:
            error = str(exc)[:2500]
            timeline = self.streams[job_id].finish_timeline()
            finished_at = datetime.now(timezone.utc).isoformat()
            self._append_message("assistant", error, job_id, status="failed",
                                 trace=self.get(job_id).get("trace", []), timeline=timeline,
                                 started_at=self.get(job_id).get('started_at'), finished_at=finished_at)
            self._update(job_id, status="failed", error=error, finished_at=finished_at)

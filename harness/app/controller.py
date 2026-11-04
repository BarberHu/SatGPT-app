"""Serialized agent execution with independent, switchable conversation histories."""

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
        raise ValueError("bounds must be [west,south,east,north]")
    try:
        west, south, east, north = [float(number) for number in value]
    except (TypeError, ValueError) as exc:
        raise ValueError("bounds must contain only numbers") from exc
    if not (-180 <= west < east <= 180 and -85 <= south < north <= 85):
        raise ValueError("Map bounds are outside the valid range")
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
        self._closed = False
        self._agent_conversation_id = None
        self._job_agents = {}
        self.jobs: dict[str, dict] = {}
        self.streams: dict[str, TaskStream] = {}
        self.lock = threading.RLock()
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
                raise ValueError("Invalid conversation session ID")
            self.conversation_id = conversation_id
            data = data.get("messages")
        if not isinstance(data, list):
            raise ValueError("Invalid conversation history format")
        return data[-100:]

    def _save_messages(self) -> None:
        self.chat_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.chat_file.with_suffix(".tmp")
        state = {"conversation_id": self.conversation_id, "messages": self.messages[-100:]}
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.chat_file)

    def conversation(self, conversation_id=None) -> dict:
        with self.conversation_lock, self.lock:
            cid = conversation_id or self.conversation_id
            messages = self._conversation_messages(cid)
            active = next((job["id"] for job in reversed(list(self.jobs.values()))
                           if job["status"] in {"queued", "running"}
                           and job['conversation_id'] == cid), None)
            return {"conversation_id": cid,
                    "messages": json.loads(json.dumps(messages, ensure_ascii=False)), "active_task": active}

    def _conversation_messages(self, cid):
        if not re.fullmatch(r'webgis-[A-Za-z0-9_-]{1,80}', cid):
            raise ValueError('Invalid conversation ID')
        if cid == self.conversation_id:
            return self.messages
        target = self.archive_dir / f'{cid}.json'
        if not target.is_file():
            raise FileNotFoundError('Conversation not found')
        record = json.loads(target.read_text(encoding='utf-8'))
        if record.get('conversation_id') != cid or not isinstance(record.get('messages'), list):
            raise ValueError('Invalid conversation history format')
        return record['messages'][-100:]

    def _save_conversation(self, cid, messages):
        if cid == self.conversation_id:
            self.messages = messages[-100:]
            self._save_messages()
        else:
            self.archive_dir.mkdir(parents=True, exist_ok=True)
            target = self.archive_dir / f'{cid}.json'
            temporary = target.with_suffix('.tmp')
            temporary.write_text(json.dumps({'conversation_id': cid, 'messages': messages[-100:]},
                                            ensure_ascii=False), encoding='utf-8')
            temporary.replace(target)

    def _archive_current(self):
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
            active_tasks = {job['conversation_id']: job for job in self.jobs.values()
                            if job['status'] in {'queued', 'running'}}
            latest_tasks = {job['conversation_id']: job for job in self.jobs.values()}
            result = []
            for cid, messages in records.items():
                active = active_tasks.get(cid)
                latest = latest_tasks.get(cid)
                title = next((m.get('content', '') for m in messages if m.get('role') == 'user'), 'New chat')
                result.append({'id': cid, 'title': title[:80], 'current': cid == self.conversation_id,
                               'updated_at': messages[-1].get('created_at', '') if messages else '',
                               'message_count': len(messages),
                               'active_task': active['id'] if active else None,
                               'task_status': active['status'] if active else None,
                               'latest_task': {'id': latest['id'], 'status': latest['status']} if latest else None})
            return sorted(result, key=lambda item: (item['updated_at'], item['current']), reverse=True)

    def activate_conversation(self, conversation_id):
        if not re.fullmatch(r'webgis-[A-Za-z0-9_-]{1,80}', conversation_id):
            raise ValueError('Invalid conversation ID')
        with self.conversation_lock:
            with self.lock:
                if conversation_id == self.conversation_id:
                    return {'conversation_id': self.conversation_id, 'messages': json.loads(json.dumps(self.messages)),
                            'active_task': next((j['id'] for j in self.jobs.values() if j['conversation_id'] == self.conversation_id
                                                 and j['status'] in {'queued', 'running'}), None)}
                target = self.archive_dir / f'{conversation_id}.json'
                if not target.is_file():
                    raise FileNotFoundError('Conversation not found')
                record = json.loads(target.read_text(encoding='utf-8'))
                if record.get('conversation_id') != conversation_id or not isinstance(record.get('messages'), list):
                    raise ValueError('Invalid conversation history format')
                self._archive_current()
            with self.lock:
                self.conversation_id = conversation_id
                self.messages = record['messages'][-100:]
                self._save_messages()
            return self.conversation()

    def new_conversation(self) -> dict:
        with self.conversation_lock:
            with self.lock:
                self._archive_current()
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
        with self.conversation_lock, self.lock:
            cid = self.jobs[job_id]['conversation_id']
            messages = self._conversation_messages(cid)
            self._save_conversation(cid, [*messages, message])

    def create(self, prompt: str, bounds, conversation_id=None) -> dict:
        if not isinstance(prompt, str) or not (3 <= len(prompt.strip()) <= 2000):
            raise ValueError("The prompt must contain 3–2000 characters")
        bounds = validate_bounds(bounds)
        with self.conversation_lock:
            if self._closed:
                raise RuntimeError('Task controller is shutting down.')
            if conversation_id and conversation_id != self.conversation_id:
                raise RuntimeError('The active conversation has changed. Refresh and try again.')
            with self.lock:
                if any(job['conversation_id'] == self.conversation_id and job['status'] in {'queued', 'running'}
                       for job in self.jobs.values()):
                    raise RuntimeError('This conversation already has an active task. Stop it before sending another message.')
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
                or self.jobs[job_id]["status"] in {"completed", "failed", "cancelled"},
                timeout=timeout,
            )
            job = self.jobs.get(job_id)
            return json.loads(json.dumps(job, ensure_ascii=False)) if job else None

    def _update(self, job_id: str, **values) -> None:
        with self.changed:
            if self.jobs[job_id]['status'] in {'completed', 'failed', 'cancelled'}:
                return
            self.jobs[job_id].update(values)
            self.jobs[job_id]["revision"] += 1
            self.changed.notify_all()
            self.streams[job_id].update(**values)

    def _finish(self, job_id, status, message, **extra):
        # Persist history and publish the terminal event under one lock so that
        # Stop racing completion cannot produce two assistant messages.
        with self.conversation_lock, self.changed:
            job = self.jobs[job_id]
            if job['status'] in {'completed', 'failed', 'cancelled'}:
                return False
            finished_at = datetime.now(timezone.utc).isoformat()
            timeline = self.streams[job_id].finish_timeline(message if status == 'completed' else '')
            self._append_message('assistant', message, job_id, status=status,
                                 trace=job.get('trace', []), timeline=timeline,
                                 started_at=job.get('started_at'), finished_at=finished_at, **extra)
            output = {'message': message, 'layers': extra.get('layers', []), 'previews': extra.get('previews', [])}
            self._update(job_id, status=status, output=output if status != 'failed' else None,
                         error=message if status == 'failed' else None, finished_at=finished_at)
            return True

    def cancel(self, job_id):
        with self.conversation_lock, self.lock:
            if job_id not in self.jobs:
                raise FileNotFoundError('Task not found')
            agent = self._job_agents.get(job_id)
            cancelled = self._finish(job_id, 'cancelled', 'Stopped by user.')
        if cancelled and agent is not None:
            agent.cancel()
        return self.get(job_id)

    def _event(self, job_id: str, notice) -> None:
        if getattr(notice, "method", None) == "session.event":
            if getattr(notice, 'payload', {}).get('sessionId') != self.jobs[job_id]['conversation_id']:
                return
            event = getattr(notice, "payload", {}).get("event") or {}
            with self.changed:
                if self.jobs[job_id]['status'] in {'completed', 'failed', 'cancelled'}:
                    return
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
        with self.conversation_lock, self.lock:
            self._closed = True
            active = [job['id'] for job in self.jobs.values() if job['status'] in {'queued', 'running'}]
        # Stop transports before joining the executor so in-flight SDK calls unblock.
        for job_id in active:
            self.cancel(job_id)
        self.pool.shutdown(wait=True, cancel_futures=True)
        if self._agent is not None:
            self._agent.__exit__(None, None, None)
            self._agent = None

    def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        assert job is not None
        if job['status'] == 'cancelled':
            return
        workspace = self.root / "state" / "agent-workspace"
        try:
            workspace.mkdir(parents=True, exist_ok=True)
            started_at = datetime.now(timezone.utc).isoformat()
            self._update(job_id, status="running", started_at=started_at)
            if not model_key_configured():
                key_name = "AIHUBMIX_API_KEY" if selected_provider() == "aihubmix" else "DEEPSEEK_API_KEY"
                raise RuntimeError(f"Missing {key_name}. Set the model API key in the project root .env.")
            if self._agent is not None and self._agent_conversation_id != job['conversation_id']:
                self._agent.__exit__(None, None, None)
                self._agent = None
            if self._agent is None:
                candidate = self.agent_factory(workspace, self.home, job["conversation_id"])
                with self.conversation_lock, self.lock:
                    if self.jobs[job_id]['status'] == 'cancelled':
                        return
                    candidate.require_resume = any(m.get('role') == 'assistant' and m.get('status') not in {'failed', 'cancelled'}
                                                   for m in self._conversation_messages(job['conversation_id']))
                    self._job_agents[job_id] = candidate
                self._agent = candidate.__enter__()
                self._agent_conversation_id = job['conversation_id']
            with self.lock:
                if self.jobs[job_id]['status'] == 'cancelled':
                    return
                self._job_agents[job_id] = self._agent
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
            self._finish(job_id, 'completed', message, layers=layers, previews=previews, code="\n\n".join(codes))
        except Exception as exc:
            error = str(exc)[:2500]
            self._finish(job_id, 'failed', error)
        finally:
            with self.lock:
                agent = self._job_agents.pop(job_id, None)
                cancelled = self.jobs[job_id]['status'] == 'cancelled'
            if cancelled and agent is not None:
                agent.__exit__(None, None, None)
                if self._agent is agent:
                    self._agent = None
                    self._agent_conversation_id = None

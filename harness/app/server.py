"""Harness API router and lifecycle hooks; the application lives in satgpt_backend."""

from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.applications import Starlette

from .controller import TaskController
from .model_config import model_key_configured
from .trace import clean_text
from satgpt_config import load_project_env, validate_config


ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = ROOT.parent
load_project_env()


@asynccontextmanager
async def lifespan(app: Starlette):
    validate_config("harness")
    from .personal.settings import Settings
    from .personal.service import PersonalService
    runtime = getattr(app.state, 'local', None)
    settings = Settings.environment(ROOT, runtime)
    app.state.harness_initialized = False
    app.state.personal = None
    app.state.controller = await asyncio.to_thread(TaskController, ROOT,
        state_dir=runtime.state_root / 'legacy-system' if runtime else None)
    try:
        if settings.enabled:
            app.state.personal = await asyncio.to_thread(PersonalService, settings, ROOT, pool=app.state.controller.pool, local=runtime)
            app.state.controller.layer_worker.concurrency_gate = app.state.personal.replay_gate
        app.state.harness_initialized = True
        yield
    finally:
        app.state.harness_initialized = False
        if app.state.personal is not None:
            await asyncio.to_thread(app.state.personal.close)
        await asyncio.to_thread(app.state.controller.close)
        app.state.controller = None


router = APIRouter()


def get_controller(request):
    personal = getattr(request.app.state, 'personal', None)
    session = getattr(request.state, 'personal_session', None)
    return personal.controller(session['owner']) if personal and session else request.app.state.controller



class TaskRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)
    bounds: list[float] = Field(min_length=4, max_length=4)
    conversation_id: str | None = None
    analysis_region: dict | None = None
    analysis_aoi: dict | None = None
    data_refs: list[str] = Field(default_factory=list, max_length=20)


@router.get("/api/harness/health")
def health():
    return {"status": "ok", "engine": "deepseek-harness",
            "gee_project_configured": bool(os.getenv("GEE_PROJECT_ID")),
            "model_key_configured": model_key_configured(),
            "gee_authentication": "not_checked", "model_authentication": "not_checked"}


@router.get("/api/harness/conversation")
def conversation(request: Request):
    return get_controller(request).conversation()


@router.post("/api/harness/conversation/new")
def new_conversation(request: Request):
    try:
        return get_controller(request).new_conversation()
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get('/api/harness/conversations')
def list_conversations(request: Request):
    return {'conversations': get_controller(request).list_conversations()}


@router.delete('/api/harness/conversations/{conversation_id}')
def delete_conversation(conversation_id: str, request: Request):
    try:
        return get_controller(request).delete_conversation(conversation_id)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(500, 'Unable to delete the conversation. Please try again.') from exc


@router.post('/api/harness/conversations/{conversation_id}/activate')
def activate_conversation(conversation_id: str, request: Request):
    try:
        return get_controller(request).activate_conversation(conversation_id)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/api/harness/conversations/{conversation_id}')
def get_conversation(conversation_id: str, request: Request):
    try:
        return get_controller(request).conversation(conversation_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/api/harness/conversations/{conversation_id}/layers/{layer_id}/reload')
def reload_layer(conversation_id: str, layer_id: str, request: Request):
    controller = get_controller(request)
    try:
        return controller.reload_layer(conversation_id, layer_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(504, str(exc)) from exc
    except ValueError as exc:
        detail = re.sub(r'https?://\S+', '[service URL]', clean_text(str(exc), controller.trace_secrets, 800))
        raise HTTPException(422, detail) from exc
    except OSError as exc:
        raise HTTPException(503, 'Unable to start the GEE worker. Please try again.') from exc


@router.post("/api/harness/tasks", status_code=202)
def create_task(request: TaskRequest, http_request: Request):
    try:
        from .personal.settings import PersonalError
        personal = getattr(http_request.app.state, 'personal', None)
        session = getattr(http_request.state, 'personal_session', None)
        if not personal or not session:
            raise PersonalError(401, 'Sign in with Google and verify your Earth Engine project before starting analysis.')
        execution = personal.execution(session['owner'], request.data_refs)
        if personal.local:
            personal.local.model_environment()
        return get_controller(http_request).create(request.prompt, request.bounds, request.conversation_id,
            analysis_region=request.analysis_region, analysis_aoi=request.analysis_aoi, execution=execution)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/api/harness/tasks/{task_id}")
def get_task(task_id: str, request: Request):
    task = get_controller(request).get(task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    return task


@router.post('/api/harness/tasks/{task_id}/cancel')
def cancel_task(task_id: str, request: Request):
    try:
        return get_controller(request).cancel(task_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/api/harness/tasks/{task_id}/events")
async def task_events(task_id: str, request: Request):
    if get_controller(request).get(task_id) is None:
        raise HTTPException(404, "Task not found")

    async def events():
        feed = get_controller(request).streams[task_id]
        cursor = request.headers.get('last-event-id', request.query_params.get('after'))
        try:
            cursor = int(cursor) if cursor is not None else None
        except ValueError:
            cursor = None
        while True:
            if await request.is_disconnected():
                break
            batch = await asyncio.to_thread(feed.read, cursor, 10)
            if batch:
                for event in batch:
                    cursor = event['id']
                    yield f"id: {cursor}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            else:
                yield ": keep-alive\n\n"
            if feed.terminal:
                # Completion can race a read; drain its final patch first.
                final = feed.read(cursor, 0)
                for event in final:
                    cursor = event['id']
                    yield f"id: {cursor}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
                break

    return StreamingResponse(events(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
    })


@router.get("/api/previews/{filename}")
def preview(filename: str, request: Request):
    if not re.fullmatch(r"[0-9a-f]{32}\.png", filename):
        raise HTTPException(404, "Preview not found")
    target = get_controller(request).state_dir / 'previews' / filename
    if not target.is_file():
        raise HTTPException(404, "Preview not found")
    return FileResponse(target, media_type="image/png")

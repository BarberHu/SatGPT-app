"""HTTP routes for browser-owned Harness sessions and artifacts."""

from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.applications import Starlette

from .controller import AdmissionError, TaskController
from .identity import owner_for, session_response
from .model_config import model_key_configured
from .shared_runtime import RuntimeUnavailable
from satgpt_config import load_project_env, validate_config

ROOT = Path(__file__).resolve().parents[1]
load_project_env()


@asynccontextmanager
async def lifespan(app: Starlette):
    validate_config('harness')
    app.state.harness_initialized = False
    app.state.controller = await asyncio.to_thread(TaskController, ROOT)
    app.state.harness_initialized = True
    try:
        yield
    finally:
        app.state.harness_initialized = False
        await asyncio.to_thread(app.state.controller.close)
        app.state.controller = None


router = APIRouter()
Owner = Annotated[str, Depends(owner_for)]


class TaskRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    prompt: str = Field(min_length=3, max_length=2000)
    bounds: list[float] = Field(min_length=4, max_length=4)
    conversation_id: str | None = Field(default=None, max_length=100)
    request_id: str = Field(pattern=r'^[A-Za-z0-9_-]{16,80}$')
    analysis_region: dict | None = None
    analysis_aoi: dict | None = None
    reasoning_effort: str | None = Field(default=None, min_length=1, max_length=100)


@contextmanager
def api_errors():
    try:
        yield
    except FileNotFoundError:
        raise HTTPException(404, 'Resource not found') from None
    except AdmissionError as exc:
        headers = {'Retry-After': '2'} if exc.status in {429, 503} else None
        raise HTTPException(exc.status, {'code': exc.code, 'message': str(exc)}, headers=headers) from None
    except RuntimeUnavailable:
        raise HTTPException(503, {'code': 'runtime_unavailable', 'message': 'Harness is unavailable.'},
                            headers={'Retry-After': '2'}) from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get('/api/harness/health')
def health(request: Request):
    controller = getattr(request.app.state, 'controller', None)
    return {'status': 'ok' if controller is not None and controller.healthy else 'degraded',
            'engine': 'deepseek-harness', 'gee_project_configured': bool(os.getenv('GEE_PROJECT_ID')),
            'model_key_configured': model_key_configured(),
            'gee_authentication': 'not_checked', 'model_authentication': 'not_checked'}


@router.get('/api/harness/session')
def session(request: Request):
    return session_response(request)


@router.get('/api/harness/reasoning')
def reasoning(request: Request, owner: Owner):
    with api_errors():
        return request.app.state.controller.reasoning_options()


@router.get('/api/harness/conversation')
def conversation(request: Request, owner: Owner):
    return request.app.state.controller.current(owner)


@router.get('/api/harness/conversations')
def list_conversations(request: Request, owner: Owner):
    return {'conversations': request.app.state.controller.list_conversations(owner)}


@router.delete('/api/harness/conversations/{conversation_id}')
def delete_conversation(conversation_id: str, request: Request, owner: Owner):
    with api_errors():
        return request.app.state.controller.delete_conversation(owner, conversation_id)


@router.post('/api/harness/conversations/{conversation_id}/activate')
@router.get('/api/harness/conversations/{conversation_id}')
def get_conversation(conversation_id: str, request: Request, owner: Owner):
    with api_errors():
        return request.app.state.controller.conversation(owner, conversation_id)


@router.post('/api/harness/conversations/{conversation_id}/layers/{layer_id}/reload')
def reload_layer(conversation_id: str, layer_id: str, request: Request, owner: Owner):
    with api_errors():
        return request.app.state.controller.reload_layer(owner, conversation_id, layer_id)


@router.get('/api/harness/conversations/{conversation_id}/layer-thumbnails')
def layer_thumbnails(conversation_id: str, ids: str, request: Request, owner: Owner):
    selected = list(dict.fromkeys(ids.split(',')))
    if not 1 <= len(selected) <= 24 or any(not re.fullmatch(r'[a-f0-9]{32}-\d{1,4}', key) for key in selected):
        raise HTTPException(422, 'Invalid layer identifiers')
    with api_errors():
        return {'layers': request.app.state.controller.thumbnails.states(owner, conversation_id, selected)}


@router.post('/api/harness/tasks', status_code=202)
def create_task(body: TaskRequest, request: Request, owner: Owner):
    with api_errors():
        return request.app.state.controller.create(owner, body.prompt, body.bounds, body.conversation_id,
                                                   body.request_id, body.analysis_region, body.analysis_aoi,
                                                   reasoning_effort=body.reasoning_effort)


@router.get('/api/harness/tasks/{task_id}')
def get_task(task_id: str, request: Request, owner: Owner):
    with api_errors():
        return request.app.state.controller.get(owner, task_id)


@router.post('/api/harness/tasks/{task_id}/cancel')
def cancel_task(task_id: str, request: Request, owner: Owner):
    with api_errors():
        return request.app.state.controller.cancel(owner, task_id)


@router.get('/api/harness/tasks/{task_id}/events')
async def task_events(task_id: str, request: Request, owner: Owner):
    with api_errors():
        feed = await asyncio.to_thread(request.app.state.controller.stream, owner, task_id)

    async def events():
        cursor = request.headers.get('last-event-id', request.query_params.get('after'))
        try:
            cursor = int(cursor) if cursor is not None else None
        except ValueError:
            cursor = None
        while not await request.is_disconnected():
            batch = feed.read(cursor, 0)
            if not batch and not feed.terminal:
                try:
                    await feed.wait(cursor, 10)
                except RuntimeError:
                    break
                batch = feed.read(cursor, 0)
            for event in batch:
                cursor = event['id']
                yield f"id: {cursor}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            if feed.terminal and not feed.read(cursor, 0):
                break
            if not batch:
                yield ': keep-alive\n\n'

    return StreamingResponse(events(), media_type='text/event-stream', headers={'X-Accel-Buffering': 'no'})


@router.get('/api/previews/{conversation_id}/{task_id}/{filename}')
def preview(conversation_id: str, task_id: str, filename: str, request: Request, owner: Owner):
    with api_errors():
        path = request.app.state.controller.artifact(owner, conversation_id, task_id, filename)
    return FileResponse(path, media_type='image/png', headers={'X-Content-Type-Options': 'nosniff'})


@router.get('/api/harness/conversations/{conversation_id}/tasks/{task_id}/osm/{filename}')
def osm_result(conversation_id: str, task_id: str, filename: str, request: Request, owner: Owner):
    with api_errors():
        path = request.app.state.controller.artifact(owner, conversation_id, task_id, filename, osm=True)
    return FileResponse(path, media_type='application/geo+json',
                        headers={'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store'})

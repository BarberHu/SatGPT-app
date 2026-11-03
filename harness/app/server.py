"""Thin HTTP transport for the DeepSeek Harness SDK and its GEE tool plugin."""

from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from .controller import TaskController
from .model_config import model_key_configured
from .config import load_project_env, validate_config


ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = ROOT.parent
load_project_env()


@asynccontextmanager
async def lifespan(app: FastAPI):
    validate_config("harness")
    app.state.controller = TaskController(ROOT)
    try:
        yield
    finally:
        await asyncio.to_thread(app.state.controller.close)


app = FastAPI(title="SatGPT Harness API", lifespan=lifespan)


class TaskRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)
    bounds: list[float] = Field(min_length=4, max_length=4)
    conversation_id: str | None = None


@app.get("/health")
def health():
    return {"status": "ok", "engine": "deepseek-harness",
            "gee_project_configured": bool(os.getenv("GEE_PROJECT_ID")),
            "model_key_configured": model_key_configured(),
            "gee_authentication": "not_checked", "model_authentication": "not_checked"}


@app.get("/api/harness/conversation")
def conversation():
    return app.state.controller.conversation()


@app.post("/api/harness/conversation/new")
def new_conversation():
    try:
        return app.state.controller.new_conversation()
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get('/api/harness/conversations')
def list_conversations():
    return {'conversations': app.state.controller.list_conversations()}


@app.post('/api/harness/conversations/{conversation_id}/activate')
def activate_conversation(conversation_id: str):
    try:
        return app.state.controller.activate_conversation(conversation_id)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get('/api/harness/conversations/{conversation_id}')
def get_conversation(conversation_id: str):
    try:
        return app.state.controller.conversation(conversation_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/harness/tasks", status_code=202)
def create_task(request: TaskRequest):
    try:
        return app.state.controller.create(request.prompt, request.bounds, request.conversation_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/harness/tasks/{task_id}")
def get_task(task_id: str):
    task = app.state.controller.get(task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    return task


@app.post('/api/harness/tasks/{task_id}/cancel')
def cancel_task(task_id: str):
    try:
        return app.state.controller.cancel(task_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/api/harness/tasks/{task_id}/events")
async def task_events(task_id: str, request: Request):
    if app.state.controller.get(task_id) is None:
        raise HTTPException(404, "Task not found")

    async def events():
        feed = app.state.controller.streams[task_id]
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


@app.get("/api/previews/{filename}")
def preview(filename: str):
    if not re.fullmatch(r"[0-9a-f]{32}\.png", filename):
        raise HTTPException(404, "Preview not found")
    target = ROOT / "state" / "previews" / filename
    if not target.is_file():
        raise HTTPException(404, "Preview not found")
    return FileResponse(target, media_type="image/png")

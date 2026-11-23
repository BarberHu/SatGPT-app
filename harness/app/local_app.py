"""Loopback-only application: the existing UI and Harness run on this computer."""
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
import secrets

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .local_runtime import LocalRuntime
from . import server
from .personal.routes import install, cookie_names
from .personal.settings import PersonalError

PROJECT = Path(__file__).resolve().parents[2]


def create_app(runtime, build=None):
    @asynccontextmanager
    async def lifespan(app):
        runtime.acquire()
        try:
            async with server.lifespan(app):
                yield
        finally:
            runtime.release()

    app = FastAPI(title='SatGPT local application', lifespan=lifespan)
    app.state.local = runtime
    app.include_router(server.router)
    install(app)
    cookie, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    local_cookie = 'satgpt_local_' + runtime.authority.rsplit(':', 1)[1] + '_browser'

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request, _error):
        # Pydantic's default response includes invalid input, potentially a key.
        return JSONResponse({'detail': 'The request fields are invalid. Check the form and try again.'}, status_code=422)

    @app.middleware('http')
    async def local_access(request, call_next):
        # Do not trust forwarded headers or DNS names resolving to loopback.
        if request.headers.get('host') != runtime.authority:
            return JSONResponse({'detail': 'Invalid local application host.'}, status_code=403)
        callback = request.url.path == '/api/personal/oauth/callback' and request.method == 'GET'
        origin = request.headers.get('origin')
        if not callback and (origin and origin != runtime.origin or request.headers.get('sec-fetch-site') == 'cross-site'):
            return JSONResponse({'detail': 'Open this application from its local address.'}, status_code=403)
        api = request.url.path.startswith('/api/')
        if api and request.method not in {'GET', 'HEAD', 'OPTIONS'}:
            if not secrets.compare_digest(request.cookies.get(local_cookie, ''), cookie) or not secrets.compare_digest(request.headers.get('x-satgpt-local-csrf', ''), csrf):
                return JSONResponse({'detail': 'Refresh the local application before submitting.'}, status_code=403)
            if request.url.path.startswith('/api/harness') and not request.cookies.get(cookie_names(app.state.personal.settings)[0]):
                return JSONResponse({'detail': 'Sign in with Google before changing your analysis workspace.'}, status_code=401)
        response = await call_next(request)
        if request.url.path == '/api/personal/status':
            response.set_cookie(local_cookie, cookie, httponly=True, samesite='strict', path='/')
            response.headers['X-SatGPT-Local-CSRF'] = csrf
        if api:
            response.headers.update({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
        return response

    @app.get('/health')
    @app.get('/readyz')
    def ready():
        return {'status': 'ready' if getattr(app.state, 'harness_initialized', False) else 'starting',
                'mode': 'local', 'basic': False, 'service_account': False}

    @app.get('/api/local/config')
    def configuration():
        return runtime.public()

    @app.get('/api/local/history')
    def old_history():
        return {'conversations': app.state.controller.list_conversations()}

    @app.get('/api/local/history/{conversation_id}')
    def old_conversation(conversation_id: str):
        try:
            return app.state.controller.conversation(conversation_id)
        except (ValueError, FileNotFoundError) as exc:
            raise PersonalError(404, 'Historical conversation not found.') from exc

    class ModelConfiguration(BaseModel):
        provider: str = Field(max_length=30)
        model: str = Field(max_length=150)
        api_key: str = Field(default='', max_length=4096)
        base_url: str = Field(default='https://aihubmix.com/v1', max_length=500)

    def idle():
        personal = app.state.personal
        if any(job['status'] in {'queued', 'running'} for controller in personal.controllers.values() for job in controller.jobs.values()):
            raise PersonalError(409, 'Stop active analyses before changing application configuration.')
        return personal

    @app.put('/api/local/model')
    def model_configuration(body: ModelConfiguration):
        idle()
        try:
            runtime.configure_model(body.provider, body.model, body.api_key, body.base_url)
        except ValueError as exc:
            raise PersonalError(400, str(exc)) from exc
        return runtime.public()

    @app.put('/api/local/oauth')
    def oauth_configuration(body: dict):
        personal = idle()
        if personal.store.db.execute('SELECT 1 FROM connections WHERE active=1 LIMIT 1').fetchone():
            raise PersonalError(409, 'Disconnect existing Google connections before changing the application OAuth client.')
        try:
            runtime.configure_oauth(body)
        except ValueError as exc:
            raise PersonalError(400, str(exc)) from exc
        config = runtime.oauth()
        personal.settings = replace(personal.settings, client_id=config['client_id'], client_secret=config['client_secret'])
        personal.oauth.settings = personal.settings
        with personal.store.transaction() as db:
            db.execute('DELETE FROM flows')
        return runtime.public()

    @app.api_route('/api/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
    def unavailable(path: str):
        raise PersonalError(503, 'Basic cloud services are disabled in local Agent mode. Use intelligent analysis with your Google account.')

    build = Path(build) if build else PROJECT / 'frontend' / 'build'

    @app.get('/{path:path}')
    def frontend(path: str):
        candidate = (build / path).resolve()
        if candidate.is_relative_to(build.resolve()) and candidate.is_file():
            return FileResponse(candidate)
        if path and Path(path).suffix:
            return JSONResponse({'detail': 'Resource not found.'}, status_code=404)
        if not (build / 'index.html').is_file():
            return JSONResponse({'detail': 'Build the frontend before starting the local application.'}, status_code=503)
        return FileResponse(build / 'index.html', headers={'Cache-Control': 'no-cache'})

    return app

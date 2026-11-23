"""Same-origin web API. Owner selection is exclusively derived from the session."""
import secrets
from urllib.parse import urlsplit
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from .settings import PersonalError

router = APIRouter(prefix='/api/personal')
COOKIE, FLOW_COOKIE = 'satgpt_session', 'satgpt_oauth_browser'


def cookie_names(settings):
    if settings.local:
        prefix = 'satgpt_local_' + str(urlsplit(settings.origin).port)
        return prefix + '_session', prefix + '_oauth_browser'
    return COOKIE, FLOW_COOKIE


def service(request):
    value = getattr(request.app.state, 'personal', None)
    if value is None:
        raise PersonalError(503, 'Google sign-in is temporarily unavailable. Please try again later.')
    return value


def owner(request):
    session = getattr(request.state, 'personal_session', None)
    if not session:
        raise PersonalError(401, 'Sign in with Google first.')
    return session['owner']


@router.get('/status')
def status(request: Request):
    value = getattr(request.app.state, 'personal', None)
    result = value.status(getattr(request.state, 'personal_session', None)) if value else {
        'enabled': False, 'login_available': False, 'user': None, 'connection': None, 'csrf': None}
    local = getattr(request.app.state, 'local', None)
    if local:
        result['local'] = local.public()
    return JSONResponse(result, headers={'Cache-Control': 'no-store'})


@router.get('/oauth/start')
def start(request: Request, purpose: str = 'login'):
    value = service(request)
    _, flow_cookie = cookie_names(value.settings)
    browser = secrets.token_urlsafe(32)
    session = getattr(request.state, 'personal_session', None)
    response = RedirectResponse(value.oauth.start(browser, session['owner'] if session else None, purpose), status_code=303)
    response.set_cookie(flow_cookie, browser, max_age=600, httponly=True, secure=value.settings.secure, samesite='lax', path='/api/personal/oauth')
    response.headers['Cache-Control'] = 'no-store'
    return response


@router.get('/oauth/callback')
def callback(request: Request, state: str = '', code: str = '', error: str = ''):
    value = service(request)
    cookie, flow_cookie = cookie_names(value.settings)
    browser = request.cookies.get(flow_cookie, '')
    raw, outcome = None, 'connected'
    try:
        if error or not code:
            value.store.consume_flow(state, browser)
            outcome = 'denied'
        else:
            session = getattr(request.state, 'personal_session', None)
            raw = value.oauth.finish(state, browser, code, session['owner'] if session else None)
    except PersonalError:
        # Return to a trusted, fixed application URL with a safe retry message.
        # Failed validation never establishes a session or reveals token errors.
        outcome = 'failed'
    response = RedirectResponse(value.settings.origin + '/?google=' + outcome, status_code=303)
    if raw:
        if request.cookies.get(cookie):
            value.store.logout(request.cookies[cookie])
        response.set_cookie(cookie, raw, max_age=7 * 86400, httponly=True, secure=value.settings.secure, samesite='lax', path='/')
    response.delete_cookie(flow_cookie, path='/api/personal/oauth')
    response.headers.update({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
    return response


@router.post('/logout')
def logout(request: Request):
    value = getattr(request.app.state, 'personal', None)
    cookie = cookie_names(value.settings)[0] if value else COOKIE
    if value:
        value.store.logout(request.cookies.get(cookie, ''))
    response = JSONResponse({'ok': True})
    response.delete_cookie(cookie, path='/')
    return response


@router.post('/disconnect')
def disconnect(request: Request, revoke: bool = False):
    service(request).disconnect(owner(request), revoke)
    return {'ok': True}


class Configuration(BaseModel):
    project: str = Field(max_length=100)
    bucket: str = Field(default='', max_length=222)


@router.put('/connection')
def configure(body: Configuration, request: Request):
    value = service(request)
    value.configure(owner(request), body.project.strip(), body.bucket.strip())
    return value.status(request.state.personal_session)


@router.get('/assets')
def assets(request: Request, parent: str = '', page_token: str = ''):
    value, ident = service(request), owner(request)
    conn = value.store.connection(ident)
    if not conn or not conn['project']:
        raise PersonalError(409, 'Verify a project before browsing assets.')
    result = value.cloud.assets(ident, parent or f"projects/{conn['project']}/assets", page_token)
    return {'assets': [{key: row[key] for key in ('name', 'type', 'updateTime', 'sizeBytes') if key in row}
                       for row in result.get('assets', [])], 'next_page_token': result.get('nextPageToken', '')}


class Asset(BaseModel):
    asset_id: str = Field(max_length=1024)


@router.post('/datasets')
def add_asset(body: Asset, request: Request):
    return service(request).register_asset(owner(request), body.asset_id)


@router.get('/datasets')
def datasets(request: Request):
    return {'datasets': service(request).store.list('datasets', owner(request))}


class Display(BaseModel):
    data_ref: str = Field(max_length=32)
    bounds: list[float] = Field(min_length=4, max_length=4)
    start: str | None = None
    end: str | None = None
    reducer: str = 'median'


@router.post('/display')
def display(body: Display, request: Request):
    try:
        return service(request).show_asset(owner(request), body.data_ref, body.bounds, body.start, body.end, body.reducer)
    except ValueError as exc:
        raise PersonalError(422, 'Unable to display this data with the selected extent and collection options. Check its bands, dates and access.') from exc
    except RuntimeError as exc:
        raise PersonalError(409, 'The layer worker is busy or this workspace changed. Retry after the current operation finishes.') from exc
    except TimeoutError as exc:
        raise PersonalError(504, 'Earth Engine layer generation timed out.') from exc
    except OSError as exc:
        raise PersonalError(503, 'The layer worker is unavailable.') from exc


class Upload(BaseModel):
    filename: str = Field(max_length=200)
    asset_id: str = Field(max_length=1024)
    idempotency_key: str = Field(max_length=80)


@router.post('/uploads', status_code=201)
def create_upload(body: Upload, request: Request):
    uploads = service(request).uploads
    return uploads.public(uploads.create(owner(request), body.filename, body.asset_id, body.idempotency_key))


@router.put('/uploads/{ident}/content')
async def content(ident: str, request: Request):
    uploads = service(request).uploads
    return uploads.public(await uploads.receive(owner(request), ident, request))


@router.get('/uploads')
def uploads(request: Request):
    value = service(request).uploads
    return {'uploads': [value.public(row) for row in value.store.list('uploads', owner(request))]}


@router.post('/uploads/{ident}/{action}')
async def upload_action(ident: str, action: str, request: Request):
    value = service(request).uploads
    handlers = {'cancel': value.cancel, 'retry': value.retry, 'cleanup': value.cleanup, 'resume': value.resume}
    if action not in handlers:
        raise PersonalError(404, 'Unknown upload action.')
    row = await run_in_threadpool(handlers[action], owner(request), ident)
    return value.public(row)


def install(app):
    app.include_router(router)

    @app.exception_handler(PersonalError)
    async def personal_error(_request, exc):
        return JSONResponse({'detail': exc.message}, status_code=exc.status, headers={'Cache-Control': 'no-store'})

    @app.middleware('http')
    async def personal_session(request, call_next):
        value = getattr(request.app.state, 'personal', None)
        request.state.personal_session = None
        relevant = request.url.path.startswith(('/api/personal', '/api/harness', '/api/previews'))
        if value and relevant:
            raw = request.cookies.get(cookie_names(value.settings)[0])
            if raw:
                request.state.personal_session = value.store.session(raw)
                if request.state.personal_session is None and request.url.path not in {'/api/personal/status', '/api/personal/logout', '/api/personal/oauth/start', '/api/personal/oauth/callback'}:
                    return JSONResponse({'detail': 'Your application session expired. Sign in again.'}, status_code=401)
            if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
                if request.headers.get('origin') and request.headers['origin'] != value.settings.origin:
                    return JSONResponse({'detail': 'Request origin does not match this application.'}, status_code=403)
                session = request.state.personal_session
                if session and not secrets.compare_digest(request.headers.get('x-satgpt-csrf', ''), session['csrf']):
                    return JSONResponse({'detail': 'Refresh this page before submitting.'}, status_code=403)
        response = await call_next(request)
        if relevant:
            response.headers['Cache-Control'] = 'no-store'
            response.headers['Referrer-Policy'] = 'no-referrer'
            response.headers['X-SatGPT-Workspace'] = (request.state.personal_session or {}).get('owner', 'system')
        return response

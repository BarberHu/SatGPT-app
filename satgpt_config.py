"""Process environment > root .env > defaults. No alternate files/interpolation."""
from __future__ import annotations
import os
import re
import warnings
from pathlib import Path
from urllib.parse import urlsplit
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULTS = {
    'GOOGLE_APPLICATION_CREDENTIALS': '.private-key.json',
    'REACT_APP_MAPBOX_STYLE_URL': 'mapbox://styles/unuinweh/clsmw8jm201f201ql5wdgcifp',
    'OPENAI_API_BASE': 'https://api.openai.com/v1', 'LLM_MODEL': 'gpt-4o-mini',
    'DSH_PROVIDER': 'deepseek-official', 'DSH_MODEL': 'deepseek-v4-flash',
    'DSH_REASONING_EFFORT': 'high', 'DSH_MAX_TOKENS': '32768',
    'AIHUBMIX_BASE_URL': 'https://aihubmix.com/v1',
    'AGENT_HOST': '127.0.0.1', 'AGENT_PORT': '8000', 'AGENT_WORKERS': '1',
    'FRONTEND_HOST': '127.0.0.1', 'FRONTEND_PORT': '3000',
    'SATGPT_SERVICE_HOST': '127.0.0.1', 'SATGPT_ALLOW_REMOTE_HARNESS': 'false',
    'FORWARDED_ALLOW_IPS': '127.0.0.1',
    'SATGPT_HEAVY_CONCURRENCY': '5', 'SATGPT_HEAVY_QUEUE_TIMEOUT_SECONDS': '30',
    'PROXY_TIMEOUT_MS': '300000', 'PROXY_MAX_SOCKETS': '256', 'GENERATE_SOURCEMAP': 'false',
}


def load_project_env(root: Path = PROJECT_ROOT) -> Path:
    env_file = root / '.env'
    load_dotenv(env_file, override=False, interpolate=False)
    for name, value in DEFAULTS.items():
        os.environ.setdefault(name, value)
    raw = os.getenv('GOOGLE_APPLICATION_CREDENTIALS', '').strip()
    if raw:
        candidate = Path(raw)
        os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = str(candidate if candidate.is_absolute() else (root / candidate).resolve())
    return env_file


def invalid(name: str, explanation='is required'):
    raise ValueError(f'{name} {explanation}. Set {name} in the project root .env (or process environment).') from None


def required_env(name: str) -> str:
    value = os.getenv(name, '').strip()
    if not value:
        invalid(name)
    return value


def integer(name: str, minimum=1, maximum=65535) -> int:
    raw = required_env(name)
    if not re.fullmatch(r'[0-9]+', raw):
        invalid(name, 'must be an integer')
    value = int(raw)
    if not minimum <= value <= maximum:
        invalid(name, f'must be between {minimum} and {maximum}')
    return value


def validate_url(name: str, https_only=False):
    try:
        parsed = urlsplit(required_env(name))
        valid = (parsed.scheme in ({'https'} if https_only else {'http', 'https'})
                 and parsed.hostname and not parsed.username and not parsed.password
                 and not parsed.query and not parsed.fragment)
        parsed.port
    except ValueError:
        valid = False
    if not valid:
        invalid(name, 'must be an HTTP(S) URL without credentials, query or fragment')


def validate_config(component='all'):
    ports = [integer(name) for name in ('AGENT_PORT', 'FRONTEND_PORT')]
    if len(set(ports)) != 2:
        invalid('AGENT_PORT/FRONTEND_PORT', 'must use distinct ports')
    if component in {'all', 'backend', 'basic', 'harness'}:
        integer('AGENT_WORKERS', 1, 1)
    for name in ('AGENT_HOST', 'FRONTEND_HOST', 'SATGPT_SERVICE_HOST'):
        if not re.fullmatch(r'[a-zA-Z0-9.:[\]_-]+', required_env(name)):
            invalid(name, 'must be a host name or IP address')
    for name in ('SATGPT_ALLOW_REMOTE_HARNESS', 'GENERATE_SOURCEMAP'):
        if required_env(name) not in {'true', 'false'}:
            invalid(name, 'must be true or false')
    integer('PROXY_TIMEOUT_MS', 1, 86400000)
    integer('PROXY_MAX_SOCKETS', 1, 65535)
    if component in {'all', 'backend', 'basic', 'harness'}:
        required_env('GEE_PROJECT_ID')
        credential = Path(required_env('GOOGLE_APPLICATION_CREDENTIALS'))
        if not credential.is_file():
            invalid('GOOGLE_APPLICATION_CREDENTIALS', 'must point to an existing service-account JSON file (relative to the project root)')
        import json
        try:
            data = json.loads(credential.read_text(encoding='utf-8'))
            valid = data.get('type') == 'service_account' and data.get('private_key') and data.get('client_email')
        except (OSError, ValueError, AttributeError):
            valid = False
        if not valid:
            invalid('GOOGLE_APPLICATION_CREDENTIALS', 'must contain a service-account JSON credential')
    if component in {'all', 'backend', 'basic'}:
        required_env('OPENAI_API_KEY')
        required_env('LLM_MODEL')
        validate_url('OPENAI_API_BASE')
        integer('SATGPT_HEAVY_CONCURRENCY', 1, 1024)
        integer('SATGPT_HEAVY_QUEUE_TIMEOUT_SECONDS', 1, 3600)
    if component in {'all', 'backend', 'harness'}:
        provider = required_env('DSH_PROVIDER')
        if provider not in {'deepseek-official', 'aihubmix'}:
            invalid('DSH_PROVIDER', 'must be deepseek-official or aihubmix')
        required_env('DEEPSEEK_API_KEY' if provider == 'deepseek-official' else 'AIHUBMIX_API_KEY')
        required_env('DSH_MODEL')
        integer('DSH_MAX_TOKENS', 1024, 131072)
        if required_env('DSH_REASONING_EFFORT') not in {'default', 'off', 'low', 'high', 'max'}:
            invalid('DSH_REASONING_EFFORT', 'must be default, off, low, high or max')
        if provider == 'aihubmix':
            validate_url('AIHUBMIX_BASE_URL', https_only=True)
    if component in {'all', 'frontend'}:
        if required_env('REACT_APP_MAPBOX_ACCESS_TOKEN').startswith('sk.'):
            invalid('REACT_APP_MAPBOX_ACCESS_TOKEN', 'must be a browser public token, not a Mapbox secret token')
        required_env('REACT_APP_MAPBOX_STYLE_URL')


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description='Validate configuration or launch a SatGPT API')
    parser.add_argument('command', choices=['check', 'backend', 'basic', 'harness'])
    args = parser.parse_args(argv)
    if args.command in {'basic', 'harness'}:
        warnings.warn(f"'{args.command}' is deprecated; use 'backend'. Both now start the unified API on AGENT_PORT.", FutureWarning)
    try:
        load_project_env()
        validate_config('all' if args.command == 'check' else 'backend')
    except ValueError as exc:
        parser.exit(2, f'Configuration error: {exc}\n')
    if args.command == 'check':
        print('Configuration valid (configured only; model/GEE authentication not tested).')
        return
    if os.getenv('HARNESS_PORT') or os.getenv('HARNESS_HOST'):
        warnings.warn('HARNESS_PORT/HARNESS_HOST are ignored; both modules use AGENT_PORT/AGENT_HOST.', FutureWarning)
    import uvicorn
    # app_dir is Uvicorn's standard import-root option; no module-specific sys.path edits.
    uvicorn.run('satgpt_backend:app', app_dir=str(PROJECT_ROOT),
                host=required_env('AGENT_HOST'), port=integer('AGENT_PORT'), workers=1,
                proxy_headers=True, forwarded_allow_ips=required_env('FORWARDED_ALLOW_IPS'))


if __name__ == '__main__':
    main()

"""Local application configuration and Windows current-user secret protection."""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import threading
from urllib.parse import urlsplit


def local_mode():
    return os.getenv('SATGPT_RUN_MODE') == 'local'


def data_directory():
    explicit = os.getenv('SATGPT_LOCAL_DATA_DIR')
    if explicit:
        return Path(explicit).expanduser().resolve()
    if os.name != 'nt' or not os.getenv('LOCALAPPDATA'):
        raise ValueError('Local mode currently requires Windows user credential protection.')
    return Path(os.environ['LOCALAPPDATA']) / 'SatGPT' / 'experimental-gee-personal-upload'


class WindowsCipher:
    """Fernet-compatible byte interface; DPAPI key belongs to the signed-in OS user."""
    prefix = b'dpapi:v1:'

    def _crypt(self, value, decrypt=False):
        if os.name != 'nt':
            raise ValueError('Windows credential protection is unavailable; no plaintext fallback is allowed.')

        class Blob(ctypes.Structure):
            _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]

        buffer = ctypes.create_string_buffer(value)
        source = Blob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
        result = Blob()
        crypt = ctypes.WinDLL('crypt32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
        function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                             ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        function.restype = wintypes.BOOL
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree.restype = ctypes.c_void_p
        if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
            raise ValueError('Windows could not protect or unlock these credentials.')
        try:
            return ctypes.string_at(result.pbData, result.cbData)
        finally:
            kernel.LocalFree(result.pbData)

    def encrypt(self, value):
        return self.prefix + base64.b64encode(self._crypt(value))

    def decrypt(self, value):
        if not value.startswith(self.prefix):
            raise ValueError('Legacy credentials must be imported before use in local mode.')
        return self._crypt(base64.b64decode(value[len(self.prefix):], validate=True), decrypt=True)


class LocalRuntime:
    def __init__(self, root=None, origin='http://127.0.0.1:3313'):
        self.root = Path(root) if root else data_directory()
        parsed = urlsplit(origin)
        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path or parsed.query or parsed.fragment:
            raise ValueError('Local mode requires a fixed http://127.0.0.1:<port> origin.')
        if parsed.username or parsed.password or not parsed.port:
            raise ValueError('Local mode requires an explicit loopback port.')
        self.origin, self.authority = origin, parsed.netloc
        self.root.mkdir(parents=True, exist_ok=True)
        self.file = self.root / 'credentials.dpapi'
        self.cipher = WindowsCipher()
        # Fail at startup if protection is unavailable, before accepting secrets.
        self.cipher.decrypt(self.cipher.encrypt(b'SatGPT protection check'))
        self.lock = threading.RLock()
        self.values = json.loads(self.cipher.decrypt(self.file.read_bytes())) if self.file.exists() else {}
        self.revision = 0
        self._instance_lock = None

    def acquire(self):
        if self._instance_lock:
            return
        import msvcrt
        handle = (self.root / 'instance.lock').open('a+b')
        try:
            if handle.tell() == 0:
                handle.write(b'1'); handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            handle.close()
            raise ValueError('This local data directory is already in use. Close its other SatGPT instance first.') from exc
        self._instance_lock = handle

    def release(self):
        if self._instance_lock:
            import msvcrt
            handle, self._instance_lock = self._instance_lock, None
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            handle.close()

    @property
    def state_root(self):
        return self.root / 'imported-state' if (self.root / 'import-source.json').is_file() else self.root

    def _save(self, values):
        encrypted = self.cipher.encrypt(json.dumps(values).encode())
        temporary = self.file.with_suffix('.tmp')
        temporary.write_bytes(encrypted)
        temporary.replace(self.file)
        self.values = values
        self.revision += 1

    def oauth(self):
        with self.lock:
            return dict(self.values.get('oauth', {}))

    def configure_oauth(self, document):
        installed = document.get('installed', {})
        if not isinstance(installed, dict):
            raise ValueError('Choose a downloaded Google Desktop app OAuth JSON file.')
        ident, secret = installed.get('client_id', ''), installed.get('client_secret', '')
        if not isinstance(ident, str) or not ident.endswith('.apps.googleusercontent.com') or len(ident) > 300:
            raise ValueError('Choose a downloaded Google Desktop app OAuth JSON file (installed client).')
        if not isinstance(secret, str) or len(secret) > 500:
            raise ValueError('Invalid desktop client configuration.')
        with self.lock:
            self._save({**self.values, 'oauth': {'client_id': ident, 'client_secret': secret}})

    def configure_model(self, provider, model, api_key, base_url='https://aihubmix.com/v1'):
        if provider not in {'deepseek-official', 'aihubmix'} or not model.strip() or len(model) > 150:
            raise ValueError('Select a supported provider and enter a model name.')
        parsed = urlsplit(base_url)
        if provider == 'aihubmix' and (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError('The model service URL must be HTTPS without credentials or query parameters.')
        with self.lock:
            previous = self.values.get('model', {})
            key = api_key.strip() if api_key else previous.get('key', '') if previous.get('provider') == provider else ''
            if not key or len(key) > 4096:
                raise ValueError('Enter the API key for this provider.')
            self._save({**self.values, 'model': {'provider': provider, 'model': model.strip(), 'key': key,
                                               'base_url': base_url.rstrip('/')}})

    def model_environment(self):
        with self.lock:
            model = self.values.get('model')
            if not model:
                raise ValueError('Configure your model service in My data · Local application before starting analysis.')
            return {'DSH_PROVIDER': model['provider'], 'DSH_MODEL': model['model'],
                    'DSH_MAX_TOKENS': '32768', 'DSH_REASONING_EFFORT': 'default',
                    'AIHUBMIX_BASE_URL': model['base_url'],
                    'AIHUBMIX_API_KEY' if model['provider'] == 'aihubmix' else 'DEEPSEEK_API_KEY': model['key']}

    def public(self):
        with self.lock:
            model = self.values.get('model', {})
            return {'mode': 'local', 'oauth_configured': bool(self.values.get('oauth')),
                    'model_configured': bool(model), 'provider': model.get('provider', 'deepseek-official'),
                    'model': model.get('model', 'deepseek-v4-flash'),
                    'base_url': model.get('base_url', 'https://aihubmix.com/v1'),
                    'storage': 'This Windows user’s application data directory', 'basic_available': False}

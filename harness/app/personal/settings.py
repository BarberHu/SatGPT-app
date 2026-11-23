from dataclasses import dataclass
import os
from pathlib import Path
from urllib.parse import urlsplit


class PersonalError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


@dataclass(frozen=True)
class Settings:
    enabled: bool
    client_id: str
    client_secret: str
    origin: str
    encryption_key: str
    state_dir: Path
    raster_limit: int = 100 * 1024 * 1024
    vector_limit: int = 10 * 1024 * 1024
    disk_limit: int = 1024 * 1024 * 1024
    local: bool = False

    @classmethod
    def environment(cls, root, runtime=None):
        if runtime is not None:
            oauth = runtime.oauth()
            return cls(True, oauth.get('client_id', ''), oauth.get('client_secret', ''),
                       runtime.origin, '', runtime.state_root / 'personal', local=True)
        enabled = os.getenv('SATGPT_PERSONAL_ENABLED', 'false') == 'true'
        origin = os.getenv('SATGPT_PUBLIC_ORIGIN', 'http://127.0.0.1:3313').rstrip('/')
        parsed = urlsplit(origin)
        if enabled and (parsed.path or parsed.query or parsed.fragment or parsed.username
                        or parsed.scheme not in {'http', 'https'} or not parsed.hostname
                        or (parsed.scheme == 'http' and parsed.hostname not in {'localhost', '127.0.0.1'})):
            raise ValueError('SATGPT_PUBLIC_ORIGIN must be a fixed HTTPS origin (HTTP is allowed on loopback).')
        values = [os.getenv(k, '') for k in ('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'SATGPT_TOKEN_ENCRYPTION_KEY')]
        if enabled and not all(values):
            raise ValueError('Personal mode requires OAuth client configuration and SATGPT_TOKEN_ENCRYPTION_KEY.')
        if enabled:
            from cryptography.fernet import Fernet
            Fernet(values[2].encode())
        limits = [int(os.getenv(k, str(v))) for k, v in (
            ('SATGPT_UPLOAD_RASTER_BYTES', 100 * 1024 * 1024),
            ('SATGPT_UPLOAD_VECTOR_BYTES', 10 * 1024 * 1024),
            ('SATGPT_UPLOAD_DISK_BYTES', 1024 * 1024 * 1024))]
        if any(v <= 0 for v in limits):
            raise ValueError('Upload limits must be positive.')
        return cls(enabled, values[0], values[1], origin, values[2],
                   Path(root) / 'state' / 'personal', *limits)

    @property
    def callback(self):
        return self.origin + '/api/personal/oauth/callback'

    @property
    def secure(self):
        return self.origin.startswith('https://')

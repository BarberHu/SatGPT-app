"""Small durable store. Tokens are encrypted separately from business records."""
from contextlib import contextmanager
import hashlib
import json
import secrets
import sqlite3
import threading
import time
import uuid

from cryptography.fernet import Fernet
from .settings import PersonalError


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Store:
    def __init__(self, settings):
        self.root = settings.state_dir
        self.root.mkdir(parents=True, exist_ok=True)
        if settings.local:
            from ..local_runtime import WindowsCipher
            self.cipher = WindowsCipher()
        else:
            self.cipher = Fernet(settings.encryption_key.encode())
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / 'personal.sqlite3', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, subject TEXT UNIQUE, email TEXT, name TEXT);
          CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, owner TEXT, csrf TEXT, expires REAL);
          CREATE TABLE IF NOT EXISTS flows(hash TEXT PRIMARY KEY, browser TEXT, owner TEXT, purpose TEXT,
            verifier TEXT, nonce TEXT, expires REAL);
          CREATE TABLE IF NOT EXISTS connections(owner TEXT PRIMARY KEY, id TEXT UNIQUE, revision INTEGER,
            active INTEGER, project TEXT, bucket TEXT, token TEXT);
          CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY, owner TEXT, data TEXT);
          CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, owner TEXT, data TEXT);
        ''')
        self.db.commit()

    @contextmanager
    def transaction(self):
        with self.lock, self.db:
            yield self.db

    def close(self):
        with self.lock:
            self.db.close()

    def user(self, claims):
        with self.transaction() as db:
            row = db.execute('SELECT id FROM users WHERE subject=?', (claims['sub'],)).fetchone()
            owner = row['id'] if row else uuid.uuid4().hex
            db.execute('INSERT INTO users VALUES(?,?,?,?) ON CONFLICT(subject) DO UPDATE SET email=excluded.email,name=excluded.name',
                       (owner, claims['sub'], claims.get('email', ''), claims.get('name', '')))
        return owner

    def new_session(self, owner):
        raw, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with self.transaction() as db:
            db.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?)', (digest(raw), owner, csrf, time.time() + 7 * 86400))
        return raw

    def session(self, raw):
        with self.lock:
            row = self.db.execute('SELECT s.owner,s.csrf,u.email,u.name FROM sessions s JOIN users u ON u.id=s.owner WHERE hash=? AND expires>?',
                                  (digest(raw), time.time())).fetchone()
        return dict(row) if row else None

    def logout(self, raw):
        with self.transaction() as db:
            db.execute('DELETE FROM sessions WHERE hash=?', (digest(raw),))

    def flow(self, browser, owner, purpose, verifier, nonce):
        raw = secrets.token_urlsafe(32)
        with self.transaction() as db:
            db.execute('DELETE FROM flows WHERE expires<?', (time.time(),))
            db.execute('INSERT INTO flows VALUES(?,?,?,?,?,?,?)',
                       (digest(raw), digest(browser), owner, purpose, verifier, nonce, time.time() + 600))
        return raw

    def consume_flow(self, raw, browser):
        with self.transaction() as db:
            row = db.execute('SELECT * FROM flows WHERE hash=?', (digest(raw),)).fetchone()
            db.execute('DELETE FROM flows WHERE hash=?', (digest(raw),))
        if not row or row['expires'] < time.time() or not secrets.compare_digest(row['browser'], digest(browser)):
            raise PersonalError(400, 'Authorization expired or does not belong to this browser. Start again.')
        return dict(row)

    def connection(self, owner, token=False):
        with self.lock:
            row = self.db.execute('SELECT * FROM connections WHERE owner=?', (owner,)).fetchone()
        if not row:
            return None
        value = dict(row)
        encrypted = value.pop('token')
        if token:
            value['token'] = json.loads(self.cipher.decrypt(encrypted.encode())) if encrypted else {}
        return value

    def save_token(self, owner, token, expected_revision=None):
        with self.transaction() as db:
            previous = self.connection(owner, token=True)
            if expected_revision is not None and (not previous or not previous['active'] or previous['revision'] != expected_revision):
                raise PersonalError(409, 'The connection changed while Google access was refreshing.')
            if previous:
                # Google's refresh response often omits refresh_token and scope.
                token = {**previous['token'], **token}
            encrypted = self.cipher.encrypt(json.dumps(token).encode()).decode()
            db.execute('INSERT INTO connections VALUES(?,?,?,1,?,?,?) ON CONFLICT(owner) DO UPDATE SET active=1,token=excluded.token',
                       (owner, previous['id'] if previous else uuid.uuid4().hex,
                        previous['revision'] if previous else 1,
                        previous['project'] if previous else '', previous['bucket'] if previous else '', encrypted))

    def configure(self, owner, project, bucket):
        with self.transaction() as db:
            db.execute('UPDATE connections SET project=?,bucket=? WHERE owner=?', (project, bucket, owner))

    def disconnect(self, owner):
        with self.transaction() as db:
            db.execute("UPDATE connections SET active=0,revision=revision+1,token='' WHERE owner=?", (owner,))
            db.execute('DELETE FROM flows WHERE owner=?', (owner,))

    def put(self, table, owner, data):
        assert table in {'datasets', 'uploads'}
        with self.transaction() as db:
            db.execute(f'INSERT INTO {table} VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE {table}.owner=excluded.owner',
                       (data['id'], owner, json.dumps(data, allow_nan=False)))

    def get(self, table, owner, item_id):
        assert table in {'datasets', 'uploads'}
        with self.lock:
            row = self.db.execute(f'SELECT data FROM {table} WHERE owner=? AND id=?', (owner, item_id)).fetchone()
        if not row:
            raise PersonalError(404, 'Record not found in this workspace.')
        return json.loads(row['data'])

    def list(self, table, owner=None):
        assert table in {'datasets', 'uploads'}
        with self.lock:
            rows = self.db.execute(f'SELECT data FROM {table}' + (' WHERE owner=?' if owner else ''),
                                   (owner,) if owner else ()).fetchall()
        return [json.loads(row['data']) for row in rows]

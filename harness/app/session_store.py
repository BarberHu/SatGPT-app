"""Durable browser-owned chat projections and task receipts."""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path

ACTIVE = frozenset({'queued', 'starting', 'running', 'cancelling', 'cleaning'})
_ACTIVE_SQL = ', '.join(f"'{status}'" for status in sorted(ACTIVE))
TERMINAL = frozenset({'completed', 'failed', 'cancelled', 'interrupted'})


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def message(role, content, job_id, **fields):
    return {'id': uuid.uuid4().hex, 'role': role, 'content': content, 'job_id': job_id,
            'created_at': timestamp(), **fields}


class SessionStore:
    def __init__(self, path: Path):
        self.path = path
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    owner TEXT NOT NULL,
                    native_id TEXT NOT NULL UNIQUE,
                    native_state TEXT NOT NULL DEFAULT 'new',
                    updated TEXT NOT NULL,
                    messages TEXT NOT NULL DEFAULT '[]',
                    deleted INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(owner, deleted, updated);
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id),
                    owner TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL,
                    receipt TEXT NOT NULL,
                    UNIQUE(owner, request_id)
                );
                CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversation_id);
                CREATE INDEX IF NOT EXISTS tasks_waiting ON tasks(status) WHERE status='queued';
            """)
        with self.connect(write=True) as db:
            unfinished = f'SELECT id, owner, conversation_id, receipt FROM tasks WHERE status IN ({_ACTIVE_SQL}) LIMIT 100'
            while rows := db.execute(unfinished).fetchall():
                for row in rows:
                    receipt = json.loads(row['receipt'])
                    interrupted = 'The service restarted before the task finished.'
                    receipt.update(status='interrupted', finished_at=timestamp(), error=interrupted,
                                   output=None, revision=receipt['revision'] + 1)
                    self.save_task(db, receipt)
                    conversation = self.owned(db, row['owner'], row['conversation_id'])
                    messages = json.loads(conversation['messages'])
                    if not any(item['role'] == 'assistant' and item.get('job_id') == row['id'] for item in messages):
                        self.save_messages(db, conversation['id'], [*messages,
                            message('assistant', interrupted, row['id'], status='interrupted',
                                    finished_at=receipt['finished_at'])])

            db.execute(f'CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active_per_conversation '
                       f'ON tasks(conversation_id) WHERE status IN ({_ACTIVE_SQL})')

    @contextmanager
    def connect(self, *, write=False):
        with closing(sqlite3.connect(self.path, timeout=3)) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            if write:
                db.execute('BEGIN IMMEDIATE')
            with db:
                yield db

    @staticmethod
    def owned(db, owner, cid):
        row = db.execute('SELECT * FROM conversations WHERE id=? AND owner=? AND deleted=0',
                         (cid, owner)).fetchone()
        if row is None:
            raise FileNotFoundError('Conversation not found')
        return row

    @staticmethod
    def new(db, owner):
        cid = f'webgis-{uuid.uuid4().hex}'
        db.execute('INSERT INTO conversations(id, owner, native_id, updated) VALUES(?,?,?,?)',
                   (cid, owner, f'satgpt-{uuid.uuid4().hex}', timestamp()))
        return cid

    @staticmethod
    def latest(db, owner, cid):
        row = db.execute('SELECT receipt FROM tasks WHERE conversation_id=? AND owner=? ORDER BY rowid DESC LIMIT 1',
                         (cid, owner)).fetchone()
        return json.loads(row['receipt']) if row else None

    @staticmethod
    def has_active_task(db, owner, cid):
        return db.execute(f'SELECT 1 FROM tasks WHERE conversation_id=? AND owner=? AND status IN ({_ACTIVE_SQL})',
                          (cid, owner)).fetchone() is not None

    @staticmethod
    def next_queued(db):
        return db.execute("""
            SELECT t.owner, t.receipt, c.native_id
            FROM tasks t JOIN conversations c ON t.conversation_id=c.id
            WHERE t.status='queued' AND c.deleted=0
            ORDER BY t.rowid LIMIT 1
        """).fetchone()

    @staticmethod
    def read_task(db, owner, job_id):
        row = db.execute('SELECT t.receipt FROM tasks t JOIN conversations c ON t.conversation_id=c.id '
                         'WHERE t.id=? AND t.owner=? AND c.deleted=0', (job_id, owner)).fetchone()
        if row is None:
            raise FileNotFoundError('Task not found')
        return json.loads(row['receipt'])

    @staticmethod
    def save_task(db, job):
        db.execute('UPDATE tasks SET status=?, receipt=? WHERE id=?', (job['status'], encode(job), job['id']))

    @staticmethod
    def save_messages(db, cid, messages):
        db.execute('UPDATE conversations SET messages=?, updated=? WHERE id=?',
                   (encode(messages[-100:]), timestamp(), cid))

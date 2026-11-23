"""Explicit copy-only import. Never alter the experimental source state or .env."""
import json
from pathlib import Path
import shutil
import sqlite3
import uuid


def import_existing(project, runtime):
    source = Path(project).resolve() / 'harness' / 'state'
    target = runtime.root.resolve()
    if source == target or target.is_relative_to(source):
        raise ValueError('Choose an application data directory outside the old state directory.')
    if any((target / name).exists() for name in ('personal', 'legacy-system', 'imported-state', 'import-source.json')):
        raise ValueError('Existing local data was preserved. Import requires a fresh application data directory.')
    if not source.exists():
        return
    stage = target / ('import-' + uuid.uuid4().hex)
    stage.mkdir()
    legacy = stage / 'legacy-system'
    # Do not copy live SQLite WAL files; SQLite backup provides a consistent database.
    shutil.copytree(source, legacy, ignore=shutil.ignore_patterns('personal', '*.lock', '*.tmp'))
    personal = source / 'personal'
    if personal.exists():
        destination = stage / 'personal'
        shutil.copytree(personal, destination,
                        ignore=shutil.ignore_patterns('personal.sqlite3', 'personal.sqlite3-wal', 'personal.sqlite3-shm'))
        dbpath = personal / 'personal.sqlite3'
        if dbpath.exists():
            old = sqlite3.connect(dbpath.as_uri() + '?mode=ro', uri=True)
            db = sqlite3.connect(destination / 'personal.sqlite3')
            try:
                old.backup(db)
                # A web client's refresh token cannot be reused by a Desktop
                # client. Preserve identities/assets/history, require new consent.
                # The original encrypted credentials remain untouched at source.
                db.execute("UPDATE connections SET active=0,revision=revision+1,token=''")
                # Browser sessions and in-flight OAuth handshakes are never migrated.
                db.execute('DELETE FROM sessions'); db.execute('DELETE FROM flows')
                for ident, record in db.execute('SELECT id,data FROM uploads').fetchall():
                    value = json.loads(record)
                    oldpath = value.get('content_path')
                    if oldpath:
                        path = Path(oldpath).resolve()
                        if not path.is_relative_to(personal.resolve()):
                            raise ValueError('An old upload points outside its state directory. Import stopped without changing the source.')
                        value['content_path'] = str(target / 'imported-state' / 'personal' / path.relative_to(personal.resolve()))
                    db.execute('UPDATE uploads SET data=? WHERE id=?', (json.dumps(value), ident))
                db.commit()
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Imported database validation failed. Source data was preserved.')
            finally:
                db.close(); old.close()
    # Publish the complete copy with one rename; a failed import stays in its own
    # staging directory and never becomes active application data.
    archive = target / 'imported-state'
    if archive.exists():
        raise ValueError('An imported state already exists; it was preserved.')
    stage.rename(archive)
    # The launcher uses these paths only after the whole import succeeded.
    (target / 'import-source.json').write_text(json.dumps({'directory': 'imported-state'}), encoding='utf-8')
    print('Copied existing experiment data; originals were preserved. Sign in again to access personal records.')

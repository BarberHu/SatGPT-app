"""Recovery proofs and browser-bound transfer requests for Agent history."""

import hashlib
import re
import secrets
import time
import uuid


REQUEST_TTL = 24 * 60 * 60
ISSUE_INTERVAL = 60
CLAIM_INTERVAL = 3
MAX_APPROVALS = 20


class RecoveryError(ValueError):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code = code
        self.status = status


def initialize(db):
    db.executescript("""
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS history_proofs (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
            digest TEXT NOT NULL,
            issued INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS history_requests (
            id TEXT PRIMARY KEY,
            target_owner TEXT NOT NULL UNIQUE,
            digest TEXT NOT NULL UNIQUE,
            created INTEGER NOT NULL,
            expires INTEGER NOT NULL,
            last_attempt INTEGER,
            consumed INTEGER
        );
        CREATE INDEX IF NOT EXISTS history_requests_created ON history_requests(created);
        CREATE TABLE IF NOT EXISTS history_approvals (
            request_id TEXT NOT NULL REFERENCES history_requests(id) ON DELETE CASCADE,
            conversation_id TEXT NOT NULL REFERENCES conversations(id),
            source_owner TEXT NOT NULL,
            proof_digest TEXT,
            PRIMARY KEY(request_id, conversation_id)
        );
        CREATE INDEX IF NOT EXISTS history_approvals_conversation ON history_approvals(conversation_id);
        CREATE TABLE IF NOT EXISTS history_audit (
            id INTEGER PRIMARY KEY,
            request_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            source_owner TEXT NOT NULL,
            target_owner TEXT NOT NULL,
            event TEXT NOT NULL,
            recorded_at INTEGER NOT NULL,
            operator TEXT,
            verified_case TEXT,
            UNIQUE(request_id, conversation_id, event)
        );
        COMMIT;
    """)


def digest(code, prefix):
    if not re.fullmatch(re.escape(prefix) + r'-[A-Za-z0-9_-]{43}', code):
        raise RecoveryError('invalid_code', 'Invalid recovery code format.', 422)
    return hashlib.sha256(code.encode('ascii')).hexdigest()


def issue_proof(db, cid):
    now = int(time.time())
    old = db.execute('SELECT issued FROM history_proofs WHERE conversation_id=?', (cid,)).fetchone()
    if old and old['issued'] > now - ISSUE_INTERVAL:
        raise RecoveryError('recovery_rate', 'Wait a minute before replacing the recovery credential.', 429)
    code = 'proof-' + secrets.token_urlsafe(32)
    db.execute('INSERT INTO history_proofs VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE '
               'SET digest=excluded.digest, issued=excluded.issued', (cid, digest(code, 'proof'), now))
    return {'code': code}


def open_request(db, owner):
    now = int(time.time())
    old = db.execute('SELECT created FROM history_requests WHERE target_owner=?', (owner,)).fetchone()
    recent = db.execute('SELECT COUNT(*) FROM history_requests WHERE created>?', (now - ISSUE_INTERVAL,)).fetchone()[0]
    if recent >= 120 or (old and old['created'] > now - ISSUE_INTERVAL):
        raise RecoveryError('recovery_rate', 'Wait a minute before creating another request.', 429)
    db.execute('DELETE FROM history_requests WHERE target_owner=? OR expires<?', (owner, now - REQUEST_TTL))
    code = 'request-' + secrets.token_urlsafe(32)
    request_id = uuid.uuid4().hex
    db.execute('INSERT INTO history_requests(id,target_owner,digest,created,expires) VALUES(?,?,?,?,?)',
               (request_id, owner, digest(code, 'request'), now, now + REQUEST_TTL))
    return {'request_id': request_id, 'code': code, 'status': 'pending', 'expires_at': now + REQUEST_TTL}


def request_status(db, owner):
    row = db.execute('SELECT r.*, (SELECT COUNT(*) FROM history_approvals a WHERE a.request_id=r.id) AS approved '
                     'FROM history_requests r WHERE target_owner=?', (owner,)).fetchone()
    if row is None:
        return {'status': 'none'}
    if row['consumed'] is not None:
        status = 'consumed'
    elif row['expires'] <= time.time():
        status = 'expired'
    else:
        status = 'approved' if row['approved'] else 'pending'
    return {'request_id': row['id'], 'status': status, 'expires_at': row['expires'], 'count': row['approved']}


def audit(db, request, approval, event, *, operator=None, verified_case=None):
    db.execute('INSERT INTO history_audit(request_id,conversation_id,source_owner,target_owner,event,recorded_at,'
               'operator,verified_case) VALUES(?,?,?,?,?,?,?,?) '
               'ON CONFLICT(request_id,conversation_id,event) DO NOTHING',
               (request['id'], approval['conversation_id'], approval['source_owner'], request['target_owner'],
                event, int(time.time()), operator, verified_case))


def approve(db, request_code, credentials, *, operator, verified_case=None):
    """Authorize a single batch after checking each selected conversation's proof."""
    request = db.execute('SELECT * FROM history_requests WHERE digest=? AND consumed IS NULL AND expires>?',
                         (digest(request_code, 'request'), time.time())).fetchone()
    if request is None:
        raise RecoveryError('request_unavailable', 'The request is unavailable or has expired.')
    if db.execute('SELECT 1 FROM history_approvals WHERE request_id=?', (request['id'],)).fetchone():
        raise RecoveryError('already_approved', 'This request already has an approved batch.')
    if not 1 <= len(credentials) <= MAX_APPROVALS:
        raise RecoveryError('invalid_selection', f'Select between 1 and {MAX_APPROVALS} distinct conversations.', 422)
    if verified_case is not None and not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', verified_case):
        raise RecoveryError('invalid_case', 'Provide an opaque support case reference.', 422)

    for cid, code in credentials.items():
        row = db.execute('SELECT c.owner, p.digest FROM conversations c LEFT JOIN history_proofs p '
                         'ON p.conversation_id=c.id WHERE c.id=? AND c.deleted=0', (cid,)).fetchone()
        if row is None or row['owner'] == request['target_owner']:
            raise RecoveryError('invalid_selection', 'A selected conversation is unavailable for transfer.')
        proof_digest = None
        if verified_case is None:
            proof_digest = digest(code, 'proof')
            if not row['digest'] or not secrets.compare_digest(row['digest'], proof_digest):
                raise RecoveryError('unverified_source', 'The credential does not verify the selected conversation.')
        approval = {'conversation_id': cid, 'source_owner': row['owner']}
        db.execute('INSERT INTO history_approvals VALUES(?,?,?,?)', (request['id'], cid, row['owner'], proof_digest))
        audit(db, request, approval, 'approved_case' if verified_case else 'approved_proof',
              operator=operator, verified_case=verified_case)
    return len(credentials)


def claim_request(db, owner, request_id):
    row = db.execute('SELECT * FROM history_requests WHERE id=? AND target_owner=?', (request_id, owner)).fetchone()
    if row is None:
        raise FileNotFoundError('Recovery request not found')
    if row['expires'] <= time.time() and row['consumed'] is None:
        raise RecoveryError('request_expired', 'The request has expired. Create a new request.')
    return row


def mark_attempt(db, owner, request_id):
    request = claim_request(db, owner, request_id)
    now = int(time.time())
    if request['consumed'] is None:
        if request['last_attempt'] is not None and request['last_attempt'] > now - CLAIM_INTERVAL:
            raise RecoveryError('recovery_rate', 'Wait a few seconds before trying again.', 429)
        db.execute('UPDATE history_requests SET last_attempt=? WHERE id=?', (now, request_id))


def approvals_for(db, request_id):
    return db.execute('SELECT * FROM history_approvals WHERE request_id=? ORDER BY conversation_id',
                      (request_id,)).fetchall()


def transfer_conversation(db, approval, target):
    cid = approval['conversation_id']
    proof = approval['proof_digest']
    if proof and not db.execute('SELECT 1 FROM history_proofs WHERE conversation_id=? AND digest=?',
                                (cid, proof)).fetchone():
        raise RecoveryError('stale_approval', 'A recovery credential changed. Ask the deployer to approve a new request.')
    db.execute('UPDATE tasks SET owner=? WHERE conversation_id=?', (target, cid))
    db.execute('UPDATE conversations SET artifact_owner=COALESCE(artifact_owner, owner), owner=? WHERE id=?',
               (target, cid))
    db.execute('DELETE FROM history_proofs WHERE conversation_id=?', (cid,))
    db.execute('DELETE FROM history_requests WHERE id<>? AND consumed IS NULL AND id IN '
               '(SELECT request_id FROM history_approvals WHERE conversation_id=?)', (approval['request_id'], cid))

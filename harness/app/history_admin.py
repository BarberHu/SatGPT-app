"""Local operator commands for finding and recovering Agent conversations."""

import argparse
import getpass
import json
import sqlite3
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

from .history_recovery import MAX_APPROVALS, RecoveryError, approve
from .session_store import ACTIVE, TERMINAL, connect_database


def date_filter(value):
    try:
        instant = datetime.fromisoformat(value)
        if instant.tzinfo is not None:
            return instant.astimezone(timezone.utc).isoformat(timespec='microseconds')
    except ValueError:
        pass
    raise argparse.ArgumentTypeError('Use an ISO 8601 timestamp with a time zone.')


def bounded_limit(value):
    number = int(value)
    if not 1 <= number <= 100:
        raise argparse.ArgumentTypeError('Limit must be between 1 and 100.')
    return number


def nonnegative_offset(value):
    number = int(value)
    if not 0 <= number <= 2**31 - 1:
        raise argparse.ArgumentTypeError('Offset must be a nonnegative 32-bit integer.')
    return number


def list_history(db, args):
    filters = [('c.id=?', args.conversation), ('c.owner=?', args.owner),
               ('c.updated>=?', args.after), ('c.updated<?', args.before)]
    conditions, values = ['1=1'], []
    for condition, value in filters:
        if value is not None:
            conditions.append(condition)
            values.append(value)
    if args.state != 'all':
        conditions.append('c.deleted=?')
        values.append(int(args.state == 'deleted'))
    source = ("FROM conversations c LEFT JOIN tasks t ON t.rowid=(SELECT rowid FROM tasks "
              "WHERE conversation_id=c.id ORDER BY rowid DESC LIMIT 1)")
    if args.task_status:
        conditions.append('t.status=?')
        values.append(args.task_status)
    where = ' WHERE ' + ' AND '.join(conditions)
    summary = db.execute('SELECT c.deleted, t.status AS task_status, COUNT(*) AS count ' + source + where +
                         ' GROUP BY c.deleted,t.status ORDER BY c.deleted,t.status', values).fetchall()
    rows = db.execute('SELECT c.id, c.owner, c.updated, c.deleted, t.status AS task_status, '
                      'json_array_length(c.messages) AS message_count ' + source + where +
                      ' ORDER BY c.updated DESC,c.id LIMIT ? OFFSET ?', [*values, args.limit, args.offset]).fetchall()
    return {'total': sum(row['count'] for row in summary), 'summary': [dict(row) for row in summary],
            'offset': args.offset, 'conversations': [dict(row) for row in rows]}


def show_history(db, cid):
    row = db.execute('SELECT id, owner, updated, deleted, messages FROM conversations WHERE id=?', (cid,)).fetchone()
    if row is None:
        raise RecoveryError('not_found', 'Conversation not found.')
    result = dict(row)
    result['messages'] = [{key: message.get(key) for key in ('role', 'content', 'created_at')}
                          for message in json.loads(row['messages'])]
    return result


def read_code(prompt):
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        return getpass.getpass(prompt).strip()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, required=True, help='Existing Harness state directory.')
    commands = parser.add_subparsers(dest='command', required=True)
    listing = commands.add_parser('list', help='List conversation metadata and matching totals.')
    listing.add_argument('--conversation')
    listing.add_argument('--owner')
    listing.add_argument('--after', type=date_filter)
    listing.add_argument('--before', type=date_filter)
    listing.add_argument('--state', choices=('live', 'deleted', 'all'), default='live')
    listing.add_argument('--task-status', choices=sorted(ACTIVE | TERMINAL))
    listing.add_argument('--limit', type=bounded_limit, default=30)
    listing.add_argument('--offset', type=nonnegative_offset, default=0)
    commands.add_parser('show', help='Read the retained text of one conversation.').add_argument('conversation')
    approval = commands.add_parser('approve', help='Approve a batch for a browser request using hidden prompts.')
    approval.add_argument('--conversation', action='append', required=True)
    approval.add_argument('--verified-case', help='Attest independent verification using an opaque support case ID.')
    audit = commands.add_parser('audit', help='Read recovery events for one conversation.')
    audit.add_argument('conversation')
    audit.add_argument('--limit', type=bounded_limit, default=30)
    args = parser.parse_args(argv)

    path = args.state_dir / 'sessions.sqlite3'
    if not path.is_file():
        parser.error('The specified state directory has no sessions.sqlite3.')
    try:
        if args.command == 'approve':
            if len(set(args.conversation)) != len(args.conversation) or len(args.conversation) > MAX_APPROVALS:
                parser.error(f'Select between 1 and {MAX_APPROVALS} distinct conversations.')
            request_code = read_code('Browser request code: ')
            credentials = {cid: None if args.verified_case else read_code(f'Recovery credential for {cid}: ')
                           for cid in args.conversation}
            with connect_database(path, write=True, mode='rw') as db:
                count = approve(db, request_code, credentials, operator=getpass.getuser(), verified_case=args.verified_case)
            output = {'approved': count}
        else:
            with connect_database(path, mode='ro') as db:
                db.execute('BEGIN')
                if args.command == 'list':
                    output = list_history(db, args)
                elif args.command == 'show':
                    output = show_history(db, args.conversation)
                else:
                    rows = db.execute('SELECT * FROM history_audit WHERE conversation_id=? ORDER BY id DESC LIMIT ?',
                                      (args.conversation, args.limit)).fetchall()
                    output = [dict(row) for row in rows]
    except RecoveryError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except sqlite3.Error:
        print('Could not access history. Check the state directory, database permissions, and server version.', file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        print('Approval requires an interactive terminal with hidden input.', file=sys.stderr)
        return 1
    print(json.dumps(output, ensure_ascii=True, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

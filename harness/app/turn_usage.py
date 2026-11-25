"""Provider-reported usage from the durable events of one Harness task."""

from typing import NamedTuple

from .aihubmix_pricing import REFERENCE_PRICE, reference_request_cost

MAX_SAFE_INTEGER = 2**53 - 1
ATTEMPT_EVENTS = {'step/start', 'step/end', 'llm/retry', 'llm/retry-started',
                  'assistant/message', 'assistant/attempt'}


class AttemptCounts(NamedTuple):
    uncached_input: int
    cache_read: int | None
    output: int
    total: int


def _is_count(value):
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def _last_usage_sample(data):
    # Harness 0.2.1rc2 stores usage in raw chunks inside the compact stream.
    stream = data.get('stream')
    if not isinstance(stream, list):
        return None
    for record in reversed(stream):
        chunk = record.get('chunk') if isinstance(record, dict) and record.get('type') == 'chunk' else None
        if isinstance(chunk, dict) and chunk.get('type') == 'usage':
            return chunk.get('usage')
    return None


def _attempt_counts(usage):
    if not isinstance(usage, dict):
        return None
    uncached, output = usage.get('inputTokens'), usage.get('outputTokens')
    cache_read, cache_write = usage.get('cacheReadTokens'), usage.get('cacheWriteTokens')
    total = usage.get('totalTokens')
    if not _is_count(uncached) or not _is_count(output):
        return None
    if any(bucket is not None and not _is_count(bucket) for bucket in (cache_read, cache_write)):
        return None
    known_total = uncached + (cache_read or 0) + (cache_write or 0) + output
    cache_complete = cache_read is not None and cache_write is not None
    if total is None and cache_complete:
        total = known_total
    # Some adapter errors produce a zero-filled sample without any provider counts.
    if not _is_count(total) or total == 0 or total < known_total or (cache_complete and total != known_total):
        return None
    # When exact totals balance, omitted cache buckets must be zero. An
    # unexplained remainder or a cache-write charge has no supported price.
    priced_cache_read = (cache_read or 0) if total == known_total and not cache_write else None
    return AttemptCounts(uncached, priced_cache_read, output, total)


def _first_response_time(event):
    stream = event['data'].get('stream')
    first = stream[0] if isinstance(stream, list) and stream else None
    if isinstance(first, dict):
        first_time = first.get('time', first.get('time0'))
        if _is_count(first_time):
            return first_time
    return event.get('time')


def summarize_turn_usage(events, *, provider=None, model=None):
    """Count each request attempt once, and disclose when records are incomplete."""
    seen_sequences = set()
    started_turns, ended_turns = set(), set()
    open_steps = set()
    attempt_number = {}
    attempt_starts = {}
    attempts = {}
    costs = {}
    incomplete = False

    for event in events:
        seq = event.get('seq')
        if _is_count(seq):
            if seq in seen_sequences:
                continue
            seen_sequences.add(seq)
        kind, data = event.get('type'), event.get('data')
        if not isinstance(data, dict):
            continue
        turn = data.get('turn')
        if kind == 'turn/start' and _is_count(turn):
            started_turns.add(turn)
        elif kind == 'turn/end' and _is_count(turn):
            ended_turns.add(turn)
        elif kind in ATTEMPT_EVENTS:
            step = (turn, data.get('step'))
            if not all(_is_count(part) for part in step):
                incomplete = True
                continue
            if kind == 'step/start':
                open_steps.add(step)
            elif turn not in started_turns or step not in open_steps:
                incomplete = True

            key = (*step, attempt_number.get(step, 0))
            attempts.setdefault(key, None)
            if kind == 'step/start':
                attempt_starts.setdefault(key, event.get('time'))
            elif kind == 'llm/retry-started':
                # The provider's retry counter can restart when its route changes.
                attempt_number[step] = key[-1] + 1
                retry_key = (*step, attempt_number[step])
                attempts.setdefault(retry_key, None)
                attempt_starts[retry_key] = event.get('time')
            elif kind == 'assistant/message' or kind == 'assistant/attempt':
                usage = data.get('usage') if kind == 'assistant/message' else None
                if usage is None:
                    usage = _last_usage_sample(data)
                counts = attempts[key] = _attempt_counts(usage)
                if counts is not None:
                    message = data.get('message')
                    source = message.get('source') if isinstance(message, dict) else None
                    source = source if isinstance(source, dict) else {}
                    costs[key] = reference_request_cost(
                        source.get('provider') or provider, source.get('model') or model,
                        attempt_starts.get(key), _first_response_time(event),
                        uncached=counts.uncached_input, cache_read=counts.cache_read, output=counts.output,
                    )
                incomplete |= data.get('interrupted') is True
            elif kind == 'step/end':
                open_steps.discard(step)

    counts = [attempt for attempt in attempts.values() if attempt is not None]
    if not counts:
        return {'status': 'unavailable'}
    total_tokens = sum(attempt.total for attempt in counts)
    output_tokens = sum(attempt.output for attempt in counts)
    if not _is_count(total_tokens):
        return {'status': 'unavailable'}
    incomplete |= bool(open_steps or not started_turns or started_turns != ended_turns)
    if seen_sequences:
        incomplete |= max(seen_sequences) - min(seen_sequences) + 1 != len(seen_sequences)
    complete = not incomplete and len(counts) == len(attempts)
    summary = {'status': 'complete' if complete else 'partial',
               'input_tokens': total_tokens - output_tokens, 'output_tokens': output_tokens, 'total_tokens': total_tokens}
    if complete and all(costs.get(key) is not None for key in attempts):
        summary['estimated_cost'] = {**REFERENCE_PRICE, 'amount': format(sum(costs.values()), 'f')}
    return summary

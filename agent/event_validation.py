"""Validate the event window before accepting Human-in-the-Loop confirmation."""
import re
from datetime import date


def validate_flood_event_dates(pre_date, peek_date, after_date):
    values = (pre_date, peek_date, after_date)
    if any(not value for value in values):
        raise ValueError('Pre-flood, peak, and post-flood dates are required.')
    try:
        if any(not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value) for value in values):
            raise ValueError
        dates = tuple(date.fromisoformat(value) for value in values)
    except ValueError as exc:
        raise ValueError('Enter valid event dates in YYYY-MM-DD format.') from exc
    if not dates[0] <= dates[1] <= dates[2]:
        raise ValueError('Event dates must follow: pre-flood ≤ peak ≤ post-flood.')

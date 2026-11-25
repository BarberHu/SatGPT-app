"""AIHubMix public list-price reference for the DeepSeek 1017 route."""

from bisect import bisect_right
from datetime import datetime, timedelta, timezone
from decimal import Decimal


REFERENCE_MODEL = 'deepseek-v4.1-flash-1017'
REFERENCE_PRICE = {
    'currency': 'USD',
    'reference_route': 'DeepSeek',
    'model': REFERENCE_MODEL,
    'price_source': 'https://aihubmix.com/model/deepseek-v4.1-flash-1017',
    'price_checked_on': '2026-11-22',
}
# USD per million uncached input, cache reads, and output, respectively.
OFF_PEAK = (Decimal('0.155'), Decimal('0.0031'), Decimal('0.62'))
PEAK = (Decimal('0.3098'), Decimal('0.0062'), Decimal('1.2392'))
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
REFERENCE_START = int(datetime(2026, 10, 17, tzinfo=timezone.utc).timestamp()) * 1000
REFERENCE_END = int(datetime(2027, 1, 1, tzinfo=timezone.utc).timestamp()) * 1000
PEAK_BOUNDARIES = (1, 4, 6, 10)


def reference_request_cost(provider, model, start_ms, first_response_ms, *, uncached, cache_read, output):
    """Price only when the available timestamps identify one rate window."""
    if provider != 'aihubmix' or model != REFERENCE_MODEL or cache_read is None:
        return None
    if type(start_ms) is not int or type(first_response_ms) is not int:
        return None
    if not REFERENCE_START <= start_ms <= first_response_ms < REFERENCE_END:
        return None
    start = EPOCH + timedelta(milliseconds=start_ms)
    end = EPOCH + timedelta(milliseconds=first_response_ms)
    start_band = bisect_right(PEAK_BOUNDARIES, start.hour)
    if start.date() != end.date():
        return None
    # The published 2026 Chinese holiday calendar has no holidays between the
    # launch of 1017 and year end. The public price still discounts weekends.
    if start.weekday() >= 5:
        rates = OFF_PEAK
    elif start_band == bisect_right(PEAK_BOUNDARIES, end.hour):
        rates = PEAK if start_band in (1, 3) else OFF_PEAK
    else:
        return None
    return sum(rate * count for rate, count in zip(rates, (uncached, cache_read, output))) / 1_000_000

"""Small dependency-light HTTP load test for SatGPT deployment checks."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import time
from collections import Counter
from dataclasses import asdict, dataclass
from typing import Any

import httpx


@dataclass
class Result:
    concurrency: int
    duration_seconds: float
    requests: int
    requests_per_second: float
    success_rate_percent: float
    latency_ms_p50: float
    latency_ms_p95: float
    latency_ms_p99: float
    latency_ms_max: float
    response_bytes: int
    statuses: dict[str, int]
    errors: dict[str, int]


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(quantile * len(ordered)) - 1))
    return ordered[index]


async def run_load(args: argparse.Namespace) -> Result:
    deadline = time.perf_counter() + args.duration
    issued = 0
    latencies: list[float] = []
    statuses: Counter[str] = Counter()
    errors: Counter[str] = Counter()
    response_bytes = 0
    lock = asyncio.Lock()
    issue_lock = asyncio.Lock()
    if args.json_file:
        with open(args.json_file, encoding="utf-8") as payload_file:
            payload: Any = json.load(payload_file)
    else:
        payload = json.loads(args.json) if args.json else None

    limits = httpx.Limits(
        max_connections=max(args.concurrency, 10),
        max_keepalive_connections=max(args.concurrency, 10),
    )
    timeout = httpx.Timeout(args.timeout)

    async with httpx.AsyncClient(limits=limits, timeout=timeout) as client:
        async def worker() -> None:
            nonlocal issued, response_bytes
            while True:
                if args.requests is not None:
                    async with issue_lock:
                        if issued >= args.requests:
                            return
                        issued += 1
                elif time.perf_counter() >= deadline:
                    return
                started = time.perf_counter()
                try:
                    response = await client.request(args.method, args.url, json=payload)
                    elapsed = (time.perf_counter() - started) * 1000
                    async with lock:
                        latencies.append(elapsed)
                        statuses[str(response.status_code)] += 1
                        response_bytes += len(response.content)
                except Exception as exc:  # load-test accounting, not application flow
                    elapsed = (time.perf_counter() - started) * 1000
                    async with lock:
                        latencies.append(elapsed)
                        errors[type(exc).__name__] += 1

        started = time.perf_counter()
        await asyncio.gather(*(worker() for _ in range(args.concurrency)))
        elapsed = time.perf_counter() - started

    requests = len(latencies)
    successes = sum(count for status, count in statuses.items() if status.startswith("2"))
    return Result(
        concurrency=args.concurrency,
        duration_seconds=round(elapsed, 3),
        requests=requests,
        requests_per_second=round(requests / elapsed, 2) if elapsed else 0.0,
        success_rate_percent=round(successes * 100 / requests, 3) if requests else 0.0,
        latency_ms_p50=round(percentile(latencies, 0.50), 2),
        latency_ms_p95=round(percentile(latencies, 0.95), 2),
        latency_ms_p99=round(percentile(latencies, 0.99), 2),
        latency_ms_max=round(max(latencies, default=0.0), 2),
        response_bytes=response_bytes,
        statuses=dict(statuses),
        errors=dict(errors),
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--duration", type=float, default=10.0)
    parser.add_argument("--requests", type=int, help="Stop after this many total requests")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--method", choices=["GET", "POST"], default="GET")
    parser.add_argument("--json", help="JSON request body")
    parser.add_argument("--json-file", help="Path to a UTF-8 JSON request body")
    return parser.parse_args()


if __name__ == "__main__":
    print(json.dumps(asdict(asyncio.run(run_load(parse_args()))), ensure_ascii=False))

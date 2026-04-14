from __future__ import annotations

import argparse
import json
import os
import traceback
from pathlib import Path
from typing import Any, Dict, List

from hydrafloods_langgraph_agent import GRAPH


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CASES = BASE_DIR / "test_cases.json"
DEFAULT_REPORT = BASE_DIR / "test_report.json"


def load_cases(path: Path) -> List[Dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))


def check_case(case: Dict[str, Any], result: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    parsed = result.get("parsed_request", {})
    tool_result = result.get("tool_result", {})
    exception = result.get("exception", {})

    if case["expect_status"] == "exception":
        if result.get("status") != "exception":
            errors.append(f"status mismatch: expected exception, got {result.get('status')}")
        if "expected_exception_type" in case and exception.get("type") != case["expected_exception_type"]:
            errors.append(
                f"exception type mismatch: expected {case['expected_exception_type']}, got {exception.get('type')}"
            )
        if (
            "expected_exception_message_contains" in case
            and case["expected_exception_message_contains"] not in (exception.get("message") or "")
        ):
            errors.append(
                "exception message mismatch: "
                f"expected to contain {case['expected_exception_message_contains']!r}, "
                f"got {exception.get('message')!r}"
            )
        return errors

    if result.get("selected_tool") != case["expected_tool"]:
        errors.append(
            f"selected_tool mismatch: expected {case['expected_tool']}, got {result.get('selected_tool')}"
        )

    actual_action = parsed.get("primary_action") or parsed.get("action")
    if actual_action != case["expected_action"]:
        errors.append(
            f"action mismatch: expected {case['expected_action']}, got {actual_action}"
        )

    if tool_result.get("status") != case["expect_status"]:
        errors.append(
            f"status mismatch: expected {case['expect_status']}, got {tool_result.get('status')}"
        )

    if "expected_algorithm" in case and parsed.get("algorithm") != case["expected_algorithm"]:
        errors.append(
            f"algorithm mismatch: expected {case['expected_algorithm']}, got {parsed.get('algorithm')}"
        )

    if "expected_reference" in case and parsed.get("reference") != case["expected_reference"]:
        errors.append(
            f"reference mismatch: expected {case['expected_reference']}, got {parsed.get('reference')}"
        )

    if "expected_dataset" in case and parsed.get("dataset") != case["expected_dataset"]:
        errors.append(
            f"dataset mismatch: expected {case['expected_dataset']}, got {parsed.get('dataset')}"
        )

    if case["expect_status"] == "ok" and case.get("expected_artifact") == "tile":
        primary_layer = tool_result.get("artifacts", {}).get("primary_layer", {})
        if not primary_layer.get("tile_url"):
            errors.append("missing tile_url in successful result")

    if case["expect_status"] == "ok" and case.get("expected_artifact") == "registry":
        if not tool_result.get("registry"):
            errors.append("missing registry in catalog result")

    if "expected_execution_mode" in case:
        actual_mode = tool_result.get("metadata", {}).get("execution_mode")
        if actual_mode != case["expected_execution_mode"]:
            errors.append(
                f"execution_mode mismatch: expected {case['expected_execution_mode']}, got {actual_mode}"
            )

    if "expect_recommendations" in case:
        has_recommendations = bool(tool_result.get("recommendations"))
        if has_recommendations != case["expect_recommendations"]:
            errors.append(
                f"recommendations mismatch: expected {case['expect_recommendations']}, got {has_recommendations}"
            )

    if "expected_blocking_issue_contains" in case:
        blocking_issues = tool_result.get("preflight", {}).get("blocking_issues", [])
        expected_text = case["expected_blocking_issue_contains"]
        if not any(expected_text in issue for issue in blocking_issues):
            errors.append(
                f"blocking issue mismatch: expected one issue containing {expected_text!r}, got {blocking_issues!r}"
            )

    return errors


def run_case(case: Dict[str, Any], token_stats: bool, debug_trace: bool) -> Dict[str, Any]:
    initial_state: Dict[str, Any] = {"query": case["query"]}
    if token_stats or debug_trace:
        initial_state["environment"] = {}
    if token_stats:
        initial_state["environment"]["token_tracking_enabled"] = True
    if debug_trace:
        initial_state["environment"]["debug_trace_enabled"] = True

    try:
        result = GRAPH.invoke(initial_state)
    except Exception as exc:
        result = {
            "status": "exception",
            "exception": {
                "type": type(exc).__name__,
                "message": str(exc),
                "traceback": traceback.format_exc(),
            },
            "environment": {
                "llm_model": os.getenv("LLM_MODEL", "gpt-4o-mini"),
            },
            "token_usage": None,
        }
    errors = check_case(case, result)
    return {
        "id": case["id"],
        "description": case["description"],
        "query": case["query"],
        "passed": len(errors) == 0,
        "errors": errors,
        "llm_model": result.get("environment", {}).get("llm_model"),
        "selected_tool": result.get("selected_tool"),
        "action": result.get("parsed_request", {}).get("primary_action")
        or result.get("parsed_request", {}).get("action"),
        "dataset": result.get("parsed_request", {}).get("dataset"),
        "status": result.get("tool_result", {}).get("status") or result.get("status"),
        "exception": result.get("exception"),
        "token_usage": result.get("token_usage"),
    }


def aggregate_token_totals(results: List[Dict[str, Any]]) -> Dict[str, int]:
    totals = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
    }
    for item in results:
        usage = item.get("token_usage") or {}
        usage_totals = usage.get("totals") or {}
        totals["prompt_tokens"] += int(usage_totals.get("prompt_tokens", 0))
        totals["completion_tokens"] += int(usage_totals.get("completion_tokens", 0))
        totals["total_tokens"] += int(usage_totals.get("total_tokens", 0))
    return totals


def main() -> None:
    parser = argparse.ArgumentParser(description="Run HYDRAFloods tool-agent test cases")
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES, help="Path to test_cases.json")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help="Path to output JSON report")
    parser.add_argument(
        "--no-token-stats",
        action="store_true",
        help="Disable token usage collection during test runs",
    )
    parser.add_argument(
        "--debug-trace",
        action="store_true",
        help="Print detailed graph node and tool-call tracing during test runs",
    )
    args = parser.parse_args()

    token_stats_enabled = not args.no_token_stats
    cases = load_cases(args.cases)
    results = [
        run_case(case, token_stats=token_stats_enabled, debug_trace=args.debug_trace)
        for case in cases
    ]
    passed = sum(1 for item in results if item["passed"])
    total = len(results)
    llm_model = next((item.get("llm_model") for item in results if item.get("llm_model")), None)

    report = {
        "llm_model": llm_model,
        "token_stats_enabled": token_stats_enabled,
        "token_totals": aggregate_token_totals(results),
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
        "results": results,
    }

    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Ran {total} cases: {passed} passed, {total - passed} failed")
    print(f"LLM model: {llm_model}")
    if token_stats_enabled:
        print(
            "Token totals: "
            f"prompt={report['token_totals']['prompt_tokens']}, "
            f"completion={report['token_totals']['completion_tokens']}, "
            f"total={report['token_totals']['total_tokens']}"
        )
    for item in results:
        status = "PASS" if item["passed"] else "FAIL"
        print(
            f"[{status}] {item['id']} -> tool={item['selected_tool']} dataset={item.get('dataset')} status={item['status']}"
        )
        for err in item["errors"]:
            print(f"  - {err}")
    print(f"Report written to: {args.report}")


if __name__ == "__main__":
    main()

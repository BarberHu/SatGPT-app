from __future__ import annotations

# Supports both old `cd harness; python -m app` and `python -m harness.app`.
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().parents[2] / "satgpt_config.py"))["main"](["harness"])

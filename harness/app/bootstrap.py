"""Install the local GEE tool bundle into the private Harness SDK profile."""

from __future__ import annotations

import json
import shutil
from pathlib import Path


BUNDLES = {"@local/webgis-gee-tools": "gee-tools",
           "@local/satgpt-assistant-stream": "assistant-stream"}


def ensure_plugin(home: Path) -> None:
    profile = home / "profiles" / "sdk" / "package.json"
    project = Path(__file__).resolve().parents[1]
    if profile.is_file():
        data = json.loads(profile.read_text(encoding="utf-8"))
    else:
        data = {"name": "dsh-profile-sdk", "private": True, "dependencies": {},
                "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"]}}}
    bundles = data.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
    for bundle, folder in BUNDLES.items():
        plugin = project / "integrations" / folder
        destination = profile.parent / "node_modules" / bundle
        destination.mkdir(parents=True, exist_ok=True)
        for source in plugin.iterdir():
            if source.is_file():
                shutil.copy2(source, destination / source.name)
        data.setdefault("dependencies", {})[bundle] = f"file:{plugin}"
        if bundle not in bundles:
            bundles.append(bundle)
    profile.write_text(json.dumps(data, indent=2), encoding="utf-8")

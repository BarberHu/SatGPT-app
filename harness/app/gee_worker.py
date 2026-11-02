"""Focused adaptation of dsh-gee's read-only GEE worker operations.

Source idea: https://github.com/cdllI/dsh-gee (MIT). This process is for a
trusted local prototype; Python code execution is not a public-user sandbox.
"""

from __future__ import annotations

import ast
import builtins
import json
import os
import sys
import uuid
from pathlib import Path
from urllib.request import urlopen


SAFE_BUILTINS = {"int": int, "float": float, "str": str, "bool": bool,
                 "len": len, "range": range, "min": min, "max": max,
                 "abs": abs, "sum": sum, "round": round, "sorted": sorted,
                 "list": list, "dict": dict, "tuple": tuple, "set": set,
                 "enumerate": enumerate, "zip": zip, "any": any, "all": all}
DENIED_NAMES = {"open", "exec", "eval", "compile", "globals", "locals", "vars",
                "getattr", "setattr", "delattr", "__import__", "breakpoint"}
DENIED_EE_ATTRIBUTES = {"data", "batch", "Export", "ServiceAccountCredentials"}
_SESSION = None
_PROJECT = None


def earth_engine(project: str):
    """Keep one authenticated Earth Engine client for the worker lifetime."""
    global _SESSION, _PROJECT
    if _SESSION is not None and _PROJECT == project:
        return _SESSION
    import ee
    import google.auth
    from google.oauth2.credentials import Credentials as UserCredentials
    from google.oauth2.service_account import Credentials as ServiceCredentials

    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/earthengine"])
    if isinstance(credentials, UserCredentials) or not isinstance(credentials, ServiceCredentials):
        raise ValueError("GEE worker requires a service account credential")
    ee.Initialize(credentials=credentials, project=project)
    _SESSION, _PROJECT = ee, project
    return ee


def checked_code(code: str) -> object:
    if not isinstance(code, str):
        raise ValueError("code 必须是 Python 字符串")
    if len(code) > 16_000:
        raise ValueError("代码超过 16000 字符限制")
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        raise ValueError(f"Python 语法错误，第 {exc.lineno} 行：{exc.msg}") from exc
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.ClassDef, ast.FunctionDef,
                             ast.AsyncFunctionDef, ast.With, ast.AsyncWith, ast.Try,
                             ast.Raise, ast.Global, ast.Nonlocal, ast.Delete)):
            raise ValueError(f"不支持的 Python 语句：{type(node).__name__}（第 {node.lineno} 行）")
        if isinstance(node, ast.Name) and (node.id.startswith("_") or node.id in DENIED_NAMES):
            raise ValueError(f"不允许使用名称：{node.id}（第 {node.lineno} 行）")
        if isinstance(node, ast.Attribute) and (
            node.attr.startswith("_") or node.attr in DENIED_EE_ATTRIBUTES
        ):
            raise ValueError(f"不允许访问属性：{node.attr}（第 {node.lineno} 行）")
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and hasattr(builtins, node.func.id) and node.func.id not in SAFE_BUILTINS):
            hint = "；用 result 返回结果" if node.func.id == "print" else ""
            raise ValueError(f"此执行器不提供 Python 内置函数 {node.func.id}（第 {node.lineno} 行）{hint}")
    if not any(isinstance(node, ast.Name) and node.id == "result" and isinstance(node.ctx, ast.Store)
               for node in ast.walk(tree)):
        raise ValueError("代码必须给 result 赋值")
    return compile(tree, "<gee-code>", "exec")


def code_warnings(code: str) -> list[str]:
    """Non-blocking hints from the Earth Engine guides; never infer dataset validity."""
    tree = ast.parse(code, mode="exec")
    warnings = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.For, ast.While)) and any(
            isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute)
            and child.func.attr == "getInfo" for child in ast.walk(node)
        ):
            warnings.append("循环内的 getInfo() 会逐次阻塞；能在服务端汇总时优先汇总后取一次结果")
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "reduceRegion" and len(node.args) < 3
                and not any(keyword.arg in {"scale", "crsTransform"} for keyword in node.keywords)
                and not any(keyword.arg is None for keyword in node.keywords)):
            warnings.append("reduceRegion() 建议显式指定 scale 或 crsTransform，避免统计尺度不确定")
    return list(dict.fromkeys(warnings))


def run_code(ee, code: str):
    scope = {"ee": ee, "__builtins__": SAFE_BUILTINS}
    exec(checked_code(code), scope)
    if "result" not in scope:
        raise ValueError("代码必须给 result 赋值")
    return scope["result"]


def jsonable(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    get_info = getattr(value, "getInfo", None)
    if callable(get_info):
        return jsonable(get_info())
    raise TypeError(f"无法序列化结果类型：{type(value).__name__}")


def execute(payload: dict) -> dict:
    operation = payload.get("operation")
    if operation == "catalog":
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from gee_catalog import search

        return search(payload.get("query", ""), payload.get("limit", 20),
                      payload.get("type"), bool(payload.get("refresh")))
    if operation == "check":
        code = payload.get("code")
        try:
            checked_code(code)
        except ValueError as exc:
            return {"valid": False, "errors": [str(exc)], "warnings": []}
        return {"valid": True, "errors": [], "warnings": code_warnings(code)}
    # Reject local Python errors before credentials, ee.Initialize, or a GEE request.
    if operation in {"eval", "preview"}:
        checked_code(payload.get("code"))
    elif operation != "status":
        checked_code(payload.get("layer_code"))
        analysis_code = payload.get("analysis_code")
        if isinstance(analysis_code, str) and analysis_code.strip():
            checked_code(analysis_code)
    project = payload.get("project")
    if not project:
        raise ValueError("缺少 GEE_PROJECT_ID；请填写项目根目录 .env")
    ee = earth_engine(project)
    if operation == "status":
        return {"python": sys.version.split()[0], "ee_version": getattr(ee, "__version__", "unknown"),
                "project": project, "credential_type": "service_account",
                "initialized": True, "server_round_trip": ee.Number(1).add(1).getInfo() == 2}
    if operation == "eval":
        return {"result": jsonable(run_code(ee, payload["code"]))}
    if operation == "preview":
        image = run_code(ee, payload["code"])
        if not callable(getattr(image, "getThumbURL", None)):
            raise TypeError("预览代码的 result 必须是 ee.Image")
        dimensions = max(64, min(1024, int(payload.get("dimensions") or 768)))
        vis = {"format": "png", "dimensions": dimensions}
        options = payload.get("visualization") or {}
        for key in ("bands", "min", "max", "palette"):
            if key in options:
                vis[key] = options[key]
        region = payload.get("region")
        if region is not None:
            if (not isinstance(region, list) or len(region) != 4
                    or not all(isinstance(value, (int, float)) for value in region)):
                raise ValueError("region 必须是 [西,南,东,北]")
            vis["region"] = region
        url = image.getThumbURL(vis)
        with urlopen(url, timeout=120) as response:
            png = response.read(12_000_001)
        if len(png) > 12_000_000 or not png.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("GEE 预览不是有效 PNG，或超过 12 MB")
        preview_dir = Path(__file__).resolve().parent.parent / "state" / "previews"
        preview_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{uuid.uuid4().hex}.png"
        (preview_dir / filename).write_bytes(png)
        return {"preview": {"name": str(payload.get("name") or "GEE 影像预览")[:100],
                            "url": f"/api/previews/{filename}", "bytes": len(png),
                            "width": int.from_bytes(png[16:20], "big"),
                            "height": int.from_bytes(png[20:24], "big")}}
    image = run_code(ee, payload["layer_code"])
    if not callable(getattr(image, "getMapId", None)):
        raise TypeError("layer_code 的 result 必须是 ee.Image")
    vis = payload.get("visualization") or {}
    options = {key: vis[key] for key in ("bands", "min", "max", "palette") if key in vis}
    map_name = image.getMapId(options)["mapid"]
    if not isinstance(map_name, str) or not map_name.startswith("projects/"):
        raise ValueError("Earth Engine 未返回有效地图 ID")
    output = {
        "layer": {
            "name": str(vis.get("name") or "GEE 结果图层")[:100],
            "url": f"https://earthengine.googleapis.com/v1/{map_name}/tiles/{{z}}/{{x}}/{{y}}",
            "visualization": options,
        }
    }
    # -I workers resolve local helpers explicitly, independent of startup cwd.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from layer_details import layer_metadata, legend_labels
    output['layer']['metadata'] = layer_metadata(payload.get('metadata'))
    labels = legend_labels(payload.get('legend'), options)
    if labels:
        output['layer']['legend'] = labels
    bounds = payload.get('bounds')
    if bounds is not None:
        output['layer']['bounds'] = bounds
        try:
            output['layer']['thumbnail'] = save_thumbnail(image, options, bounds, ee)
        except Exception:
            # A failed optional preview must not discard an already-created map.
            output['layer']['thumbnail_status'] = 'unavailable'
    else:
        output['layer']['thumbnail_status'] = 'missing_bounds'
    analysis_code = payload.get("analysis_code")
    if isinstance(analysis_code, str) and analysis_code.strip():
        output["analysis"] = jsonable(run_code(ee, analysis_code))
    return output


def save_thumbnail(image, visualization, bounds, ee):
    if (not isinstance(bounds, list) or len(bounds) != 4
            or not all(isinstance(v, (int, float)) for v in bounds)
            or not (-180 <= bounds[0] < bounds[2] <= 180 and -85 <= bounds[1] < bounds[3] <= 85)):
        raise ValueError('Invalid layer thumbnail bounds')
    url = image.getThumbURL({**visualization, 'format': 'png', 'dimensions': 256,
                             'region': ee.Geometry.Rectangle(bounds)})
    with urlopen(url, timeout=20) as response:
        png = response.read(4_000_001)
    if len(png) > 4_000_000 or len(png) < 24 or not png.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Invalid layer thumbnail PNG')
    directory = Path(__file__).resolve().parent.parent / 'state' / 'previews'
    directory.mkdir(parents=True, exist_ok=True)
    filename = f'{uuid.uuid4().hex}.png'
    (directory / filename).write_bytes(png)
    return {'url': f'/api/previews/{filename}', 'width': int.from_bytes(png[16:20], 'big'),
            'height': int.from_bytes(png[20:24], 'big')}


def main() -> None:
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            result = {"id": request["id"], "ok": True, "data": execute(request["payload"])}
        except Exception as exc:
            result = {"id": request.get("id") if isinstance(request, dict) else None,
                      "ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

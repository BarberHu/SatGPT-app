"""Focused adaptation of dsh-gee's read-only GEE worker operations.

Source idea: https://github.com/cdllI/dsh-gee (MIT). This process is for a
trusted local prototype; Python code execution is not a public-user sandbox.
"""

from __future__ import annotations

import ast
import builtins
from collections import Counter
import json
import math
import re
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace
from urllib.request import urlopen


SAFE_BUILTINS = {"int": int, "float": float, "str": str, "bool": bool,
                 "len": len, "range": range, "min": min, "max": max,
                 "abs": abs, "sum": sum, "round": round, "sorted": sorted,
                 "list": list, "dict": dict, "tuple": tuple, "set": set,
                 "enumerate": enumerate, "zip": zip, "any": any, "all": all}
DENIED_NAMES = {"open", "exec", "eval", "compile", "globals", "locals", "vars",
                "getattr", "setattr", "delattr", "__import__", "breakpoint"}
DENIED_EE_ATTRIBUTES = {"data", "batch", "Export", "ServiceAccountCredentials", "Initialize",
                        "Authenticate", "Reset", "initialize", "reset", "importApi", "clearApi"}
EE_TYPES = ("Algorithms", "Array", "Classifier", "Clusterer", "Date", "DateRange", "Dictionary",
            "ErrorMargin", "Feature", "FeatureCollection", "Filter", "Geometry", "Image", "ImageCollection",
            "Join", "Kernel", "List", "Number", "Projection", "Reducer", "String", "Terrain")
STATEMENT_HINTS = {
    ast.Import: "Remove the import. ee is already available.",
    ast.ImportFrom: "Remove the import. ee is already available.",
    ast.FunctionDef: "Write multi-step calculations as top-level assignments. Use an inline lambda only for a simple Earth Engine .map() callback; use aggregate_array() to read properties.",
    ast.AsyncFunctionDef: "Write multi-step calculations as top-level assignments. Use an inline lambda only for a simple Earth Engine .map() callback; use aggregate_array() to read properties.",
}
COLLECTION_TYPES = {"ImageCollection": "ee.Image", "FeatureCollection": "ee.Feature"}
COLLECTION_CHAIN_METHODS = {"filter", "filterBounds", "filterDate", "limit", "select", "sort"}
_SESSION = None
_PROJECT = None
# Isolated Python startup does not add the worker directory to the import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))


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


def check_reduce_region_arguments(call: ast.Call) -> None:
    if not isinstance(call.func, ast.Attribute) or call.func.attr != "reduceRegion":
        return
    transform = next((keyword.value for keyword in call.keywords if keyword.arg == "crsTransform"), None)
    if transform is None and len(call.args) >= 5 and not any(isinstance(arg, ast.Starred) for arg in call.args[:5]):
        transform = call.args[4]
    if isinstance(transform, ast.UnaryOp) and isinstance(transform.op, (ast.UAdd, ast.USub)):
        transform = transform.operand
    if isinstance(transform, ast.Constant) and type(transform.value) in (int, float):
        raise ValueError(
            f"reduceRegion crsTransform must be a transform list (line {call.lineno}). "
            "The fifth positional argument is crsTransform. Use maxPixels=<integer> to set the pixel limit."
        )


def ee_constructor(expression):
    if (isinstance(expression, ast.Call) and isinstance(expression.func, ast.Attribute)
            and isinstance(expression.func.value, ast.Name) and expression.func.value.id == "ee"):
        return expression.func.attr
    return None


def collection_kind(expression, bindings):
    while (isinstance(expression, ast.Call) and isinstance(expression.func, ast.Attribute)
           and expression.func.attr in COLLECTION_CHAIN_METHODS):
        expression = expression.func.value
    if isinstance(expression, ast.Name):
        return bindings.get(expression.id)
    kind = ee_constructor(expression)
    return kind if kind in COLLECTION_TYPES else None


def collection_map_return_error(callback: ast.Lambda, kind: str) -> str | None:
    body = callback.body
    if not isinstance(body, ast.Call) or not isinstance(body.func, ast.Attribute):
        return None
    receiver = body.func.value
    if body.func.attr == "format" and ee_constructor(receiver) == "Date":
        return "Use aggregate_array('system:time_start'), then ee.List.map() to format dates."
    reduction = receiver if body.func.attr == "set" else body
    if not (isinstance(reduction, ast.Call) and isinstance(reduction.func, ast.Attribute)
            and reduction.func.attr == "reduceRegion"):
        return None
    image = reduction.func.value
    parameters = callback.args.posonlyargs + callback.args.args
    is_image_parameter = (kind == "ImageCollection" and bool(parameters) and isinstance(image, ast.Name)
                          and image.id == parameters[0].arg)
    if ee_constructor(image) == "Image" or is_image_parameter:
        return "reduceRegion() returns a dictionary. Reduce outside the collection callback, or set metadata on the image and return the image."
    return None


def check_collection_map_returns(tree: ast.Module) -> None:
    writes = Counter(node.id for node in ast.walk(tree) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store))
    shadowed = {node.arg for node in ast.walk(tree) if isinstance(node, ast.arg)}
    if writes["ee"] or "ee" in shadowed:
        return
    bindings = {}
    for statement in tree.body:
        if not isinstance(statement, (ast.Assign, ast.Expr)):
            bindings.clear()
            continue
        for call in ast.walk(statement.value):
            if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == "map"):
                continue
            kind = collection_kind(call.func.value, bindings)
            callback = call.args[0] if call.args else next(
                (argument.value for argument in call.keywords if argument.arg == "algorithm"), None)
            if kind and isinstance(callback, ast.Lambda):
                hint = collection_map_return_error(callback, kind)
                if hint:
                    raise ValueError(f"ee.{kind}.map() must return an {COLLECTION_TYPES[kind]} (line {call.lineno}). {hint}")
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
            target = statement.targets[0]
            if isinstance(target, ast.Name) and writes[target.id] == 1 and target.id not in shadowed:
                kind = collection_kind(statement.value, bindings)
                if kind:
                    bindings[target.id] = kind


def checked_code(code: str, *, check_eval_arguments: bool = False) -> object:
    if not isinstance(code, str):
        raise ValueError("code must be a Python string")
    if len(code) > 16_000:
        raise ValueError("Code exceeds the 16000-character limit")
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        raise ValueError(f"Python syntax error on line {exc.lineno}: {exc.msg}") from exc
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.ClassDef, ast.FunctionDef,
                             ast.AsyncFunctionDef, ast.With, ast.AsyncWith, ast.Try,
                             ast.Raise, ast.Global, ast.Nonlocal, ast.Delete)):
            hint = STATEMENT_HINTS.get(type(node), "")
            raise ValueError(f"Unsupported Python statement: {type(node).__name__} (line {node.lineno}). {hint}".rstrip())
        if isinstance(node, ast.Name) and (node.id.startswith("_") or node.id in DENIED_NAMES):
            raise ValueError(f"Name is not allowed: {node.id} (line {node.lineno})")
        if isinstance(node, ast.Attribute) and (
            node.attr.startswith("_") or node.attr in DENIED_EE_ATTRIBUTES
        ):
            raise ValueError(f"Attribute access is not allowed: {node.attr} (line {node.lineno})")
        if isinstance(node, ast.Attribute) and not isinstance(node.ctx, ast.Load):
            raise ValueError(f"Attribute mutation is not allowed (line {node.lineno})")
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and hasattr(builtins, node.func.id) and node.func.id not in SAFE_BUILTINS):
            hint = ". Assign the output to result." if node.func.id == "print" else ""
            raise ValueError(f"Python builtin {node.func.id} is unavailable in this executor (line {node.lineno}){hint}")
        if check_eval_arguments and isinstance(node, ast.Call):
            check_reduce_region_arguments(node)
    if check_eval_arguments:
        check_collection_map_returns(tree)
    if not any(isinstance(node, ast.Name) and node.id == "result" and isinstance(node.ctx, ast.Store)
               for node in ast.walk(tree)):
        raise ValueError("Code must assign a value to result. Write result = stats or result = {...}. "
                         "A standalone final expression is not returned.")
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
            warnings.append("getInfo() inside a loop blocks on each iteration. Prefer server-side aggregation and retrieve the result once.")
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "reduceRegion" and len(node.args) < 3
                and not any(keyword.arg in {"scale", "crsTransform"} for keyword in node.keywords)
                and not any(keyword.arg is None for keyword in node.keywords)):
            warnings.append("Set scale or crsTransform explicitly in reduceRegion() to ensure a defined analysis resolution.")
    return list(dict.fromkeys(warnings))


def run_code(ee, code: str, analysis_context=None):
    available = {name: getattr(ee, name) for name in EE_TYPES if hasattr(ee, name)}
    scope = {"ee": SimpleNamespace(**available), "__builtins__": SAFE_BUILTINS.copy()}
    if analysis_context is not None:
        # A fresh scope on every execution, including analysis_code. Never cache
        # mutable task geometry in this persistent worker's module globals.
        from analysis_region import validate_analysis_region
        geometry = validate_analysis_region(analysis_context.get('analysis_region'))
        if geometry is None:
            bounds = analysis_context.get('bounds')
            if (not isinstance(bounds, list) or len(bounds) != 4
                    or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in bounds)
                    or not (-180 <= bounds[0] < bounds[2] <= 180 and -90 <= bounds[1] < bounds[3] <= 90)):
                raise ValueError('Invalid analysis context bounds')
            w, s, e, n = bounds
            geometry = {'type': 'Polygon', 'coordinates': [[[w,s], [e,s], [e,n], [w,n], [w,s]]]}
        scope['analysis_region_geojson'] = geometry
        scope['analysis_region'] = ee.Geometry(geometry)
    exec(checked_code(code), scope)
    if "result" not in scope:
        raise ValueError("Code must assign a value to result")
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
    raise TypeError(f"Cannot serialize result type: {type(value).__name__}")


def execute(payload: dict) -> dict:
    operation = payload.get("operation")
    if operation == "catalog":
        from gee_catalog import search

        cache_dir = Path(payload['catalog_dir']) if payload.get('catalog_dir') else None
        return search(payload.get("query", ""), payload.get("limit", 20),
                      payload.get("type"), bool(payload.get("refresh")), cache_dir=cache_dir)
    if operation == "check":
        code = payload.get("code")
        try:
            checked_code(code, check_eval_arguments=True)
        except ValueError as exc:
            return {"valid": False, "errors": [str(exc)], "warnings": []}
        return {"valid": True, "errors": [], "warnings": code_warnings(code)}
    # Reject local Python errors before credentials, ee.Initialize, or a GEE request.
    if operation in {"eval", "preview"}:
        checked_code(payload.get("code"), check_eval_arguments=operation == "eval")
    elif operation != "status":
        checked_code(payload.get("layer_code"))
        analysis_code = payload.get("analysis_code")
        if isinstance(analysis_code, str) and analysis_code.strip():
            checked_code(analysis_code)
    project = payload.get("project")
    if not project:
        raise ValueError("Missing GEE_PROJECT_ID. Set it in the project root .env.")
    ee = earth_engine(project)
    if operation == "status":
        return {"python": sys.version.split()[0], "ee_version": getattr(ee, "__version__", "unknown"),
                "project": project, "credential_type": "service_account",
                "initialized": True, "server_round_trip": ee.Number(1).add(1).getInfo() == 2}
    if operation == "eval":
        return {"result": jsonable(run_code(ee, payload["code"], payload.get('analysis_context')))}
    if operation == "preview":
        image = run_code(ee, payload["code"], payload.get('analysis_context'))
        if not callable(getattr(image, "getThumbURL", None)):
            raise TypeError("Preview code must assign an ee.Image to result")
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
                raise ValueError("region must be [west,south,east,north]")
            vis["region"] = region
        url = image.getThumbURL(vis)
        with urlopen(url, timeout=120) as response:
            png = response.read(12_000_001)
        if len(png) > 12_000_000 or not png.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("The GEE preview is not a valid PNG or exceeds 12 MB")
        preview_url = save_png(png, payload)
        return {"preview": {"name": str(payload.get("name") or "GEE image preview")[:100],
                            "url": preview_url, "bytes": len(png),
                            "width": int.from_bytes(png[16:20], "big"),
                            "height": int.from_bytes(png[20:24], "big")}}
    image = run_code(ee, payload["layer_code"], payload.get('analysis_context'))
    if not callable(getattr(image, "getMapId", None)):
        raise TypeError("layer_code must assign an ee.Image to result")
    vis = payload.get("visualization") or {}
    options = {key: vis[key] for key in ("bands", "min", "max", "palette") if key in vis}
    map_name = image.getMapId(options)["mapid"]
    if not isinstance(map_name, str) or not map_name.startswith("projects/"):
        raise ValueError("Earth Engine did not return a valid map ID")
    output = {
        "layer": {
            "name": str(vis.get("name") or "GEE result layer")[:100],
            "url": f"https://earthengine.googleapis.com/v1/{map_name}/tiles/{{z}}/{{x}}/{{y}}",
            "visualization": options,
        }
    }
    # -I workers resolve local helpers explicitly, independent of startup cwd.
    from layer_details import layer_metadata, legend_labels
    output['layer']['metadata'] = layer_metadata(payload.get('metadata'))
    labels = legend_labels(payload.get('legend'), options)
    if labels:
        output['layer']['legend'] = labels
    bounds = payload.get('bounds')
    if bounds is not None:
        output['layer']['bounds'] = bounds
        try:
            output['layer']['thumbnail'] = save_thumbnail(image, options, bounds, ee, payload)
        except Exception:
            # A failed optional preview must not discard an already-created map.
            output['layer']['thumbnail_status'] = 'unavailable'
    else:
        output['layer']['thumbnail_status'] = 'missing_bounds'
    analysis_code = payload.get("analysis_code")
    if isinstance(analysis_code, str) and analysis_code.strip():
        output["analysis"] = jsonable(run_code(ee, analysis_code, payload.get('analysis_context')))
    return output


def save_png(png, payload):
    directory = Path(payload['artifact_dir'])
    directory.mkdir(parents=True, exist_ok=True)
    filename = f'{uuid.uuid4().hex}.png'
    temporary = directory / (filename + '.tmp')
    temporary.write_bytes(png)
    temporary.replace(directory / filename)
    return f"{payload['artifact_url']}/{filename}"


def save_thumbnail(image, visualization, bounds, ee, payload):
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
    return {'url': save_png(png, payload), 'width': int.from_bytes(png[16:20], 'big'),
            'height': int.from_bytes(png[20:24], 'big')}


def main() -> None:
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            result = {"id": request["id"], "ok": True, "data": execute(request["payload"])}
        except Exception as exc:
            result = {"id": request.get("id") if isinstance(request, dict) else None,
                      "ok": False, "error": re.sub(r"https?://\S+", "[service URL]", f"{type(exc).__name__}: {exc}")[:1200]}
        try:
            line = json.dumps(result, ensure_ascii=False, allow_nan=False)
        except (ValueError, TypeError):
            line = json.dumps({'id': result['id'], 'ok': False, 'error': 'GEE result is not JSON serializable'})
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

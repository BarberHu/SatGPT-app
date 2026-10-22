import ast
import json
import unittest
from datetime import date, timedelta
from pathlib import Path


def load_layer_key_parser():
    path = Path(__file__).resolve().parents[1] / "flood_api_services.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    definitions = [
        node
        for node in tree.body
        if (
            isinstance(node, ast.Assign)
            and any(getattr(target, "id", None) == "AGENT_RASTER_LAYER_KEYS" for target in node.targets)
        )
        or getattr(node, "name", None) == "_requested_agent_raster_layer_keys"
    ]
    namespace = {"Any": object, "Dict": dict, "json": json}
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(path), "exec"), namespace)
    return namespace["_requested_agent_raster_layer_keys"]


def load_imagery_download_helpers():
    path = Path(__file__).resolve().parents[1] / "flood_api_services.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    wanted = {
        "_get_imagery_download_date_window",
        "_agent_raster_download_scales",
        "_is_download_size_limit_error",
    }
    definitions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted
    ]
    namespace = {
        "Any": object,
        "Dict": dict,
        "date": date,
        "timedelta": timedelta,
    }
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(path), "exec"), namespace)
    return namespace


class RasterLayerContractTests(unittest.TestCase):
    def setUp(self):
        self.parse_layer_keys = load_layer_key_parser()

    def test_layer_keys_are_required(self):
        with self.assertRaisesRegex(ValueError, "at least one layer key"):
            self.parse_layer_keys({})

    def test_removed_aliases_are_rejected(self):
        for legacy_key in ("populationExposure", "fuelLandCover"):
            with self.subTest(legacy_key=legacy_key):
                with self.assertRaisesRegex(ValueError, "Unsupported"):
                    self.parse_layer_keys({"layer_keys": [legacy_key]})

    def test_canonical_context_layers_are_accepted(self):
        self.assertEqual(
            self.parse_layer_keys({"layer_keys": ["populationDensity", "lclu"]}),
            {"populationDensity", "lclu"},
        )

    def test_imagery_download_window_keeps_ui_end_date_inclusive(self):
        helper = load_imagery_download_helpers()["_get_imagery_download_date_window"]
        self.assertEqual(
            helper({"start_date": "2026-08-19", "end_date": "2026-09-17"}),
            ("2026-08-19", "2026-09-17", "2026-09-18"),
        )

    def test_imagery_download_window_rejects_reversed_dates(self):
        helper = load_imagery_download_helpers()["_get_imagery_download_date_window"]
        with self.assertRaisesRegex(ValueError, "must not be after"):
            helper({"start_date": "2026-09-17", "end_date": "2026-08-19"})

    def test_imagery_downloads_retry_at_coarser_resolutions(self):
        helper = load_imagery_download_helpers()["_agent_raster_download_scales"]
        self.assertEqual(helper("sentinel2Rgb", 10), [10, 20, 30, 60, 100, 250])
        self.assertEqual(helper("sentinel1Vv", 10), [10, 20, 30, 60, 100, 250])

    def test_download_size_limit_errors_are_retryable(self):
        helper = load_imagery_download_helpers()["_is_download_size_limit_error"]
        self.assertTrue(helper("Total request size must be less than or equal to 50331648 bytes"))
        self.assertTrue(helper(
            "Pixel grid dimensions (52888x30612) must be less than or equal to 32768."
        ))
        self.assertFalse(helper("No Sentinel-2 imagery found in the selected window"))


if __name__ == "__main__":
    unittest.main()

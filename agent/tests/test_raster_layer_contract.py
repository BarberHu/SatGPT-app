import ast
import json
import unittest
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


if __name__ == "__main__":
    unittest.main()

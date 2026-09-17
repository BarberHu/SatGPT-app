import json
import unittest
from pathlib import Path

from experiments.water_asset_agent.tile_service import (
    apply_configured_valid_data_mask,
    apply_configured_value_remap,
    resolve_calendar_month,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = PROJECT_ROOT / "agent" / "config" / "flood_dataset_registry.json"


class FakeImage:
    def __init__(self):
        self.remap_call = None
        self.renamed_to = None

    def remap(self, source_values, display_values, defaultValue=None, bandName=None):
        self.remap_call = {
            "source_values": source_values,
            "display_values": display_values,
            "default_value": defaultValue,
            "band_name": bandName,
        }
        return self

    def select(self, bands):
        self.selected_bands = bands
        return self

    def eq(self, value):
        self.equal_value = value
        return self

    def updateMask(self, mask):
        self.applied_mask = mask
        return self

    def rename(self, band_name):
        self.renamed_to = band_name
        return self


class CatalogValueRemapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        payload = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
        cls.assets = {item["asset_id"]: item for item in payload["assets"]}

    def test_hls_uses_compact_display_classes(self):
        remap = self.assets["OPERA/DSWX/L3_V1/HLS"]["execution_profile"]["value_remap"]
        self.assertEqual(remap["source_values"], [0, 1, 2, 252, 253, 254])
        self.assertEqual(remap["display_values"], [0, 1, 2, 3, 4, 5])

    def test_sentinel_1_uses_its_own_class_schema(self):
        remap = self.assets["OPERA/DSWX/L3_V1/S1"]["execution_profile"]["value_remap"]
        self.assertEqual(remap["source_values"], [0, 1, 3, 250, 251, 254])
        self.assertEqual(remap["display_values"], [0, 1, 2, 3, 4, 5])

    def test_configured_remap_is_applied_and_band_name_is_preserved(self):
        image = FakeImage()
        hints = {
            "value_remap": {
                "band": "WTR_Water_classification",
                "source_values": [0, 1, 2, 252, 253, 254],
                "display_values": [0, 1, 2, 3, 4, 5],
            }
        }

        result = apply_configured_value_remap(image, hints)

        self.assertIs(result, image)
        self.assertEqual(image.remap_call["source_values"], [0, 1, 2, 252, 253, 254])
        self.assertEqual(image.remap_call["display_values"], [0, 1, 2, 3, 4, 5])
        self.assertEqual(image.remap_call["band_name"], "WTR_Water_classification")
        self.assertEqual(image.renamed_to, "WTR_Water_classification")

    def test_invalid_mapping_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "equally sized"):
            apply_configured_value_remap(
                FakeImage(),
                {"value_remap": {"source_values": [0, 1], "display_values": [0]}},
            )

    def test_monthly_recurrence_uses_calendar_month_property_and_observation_mask(self):
        profile = self.assets["JRC/GSW1_4/MonthlyRecurrence"]["execution_profile"]
        self.assertEqual(profile["time_selection"]["mode"], "calendar_month_property")
        self.assertEqual(profile["time_selection"]["property"], "month")
        self.assertEqual(profile["valid_data_mask"], {"band": "has_observations", "valid_value": 1})

    def test_calendar_month_is_read_from_request_date(self):
        self.assertEqual(resolve_calendar_month("2000-08-01"), 8)
        with self.assertRaisesRegex(ValueError, "valid start_date month"):
            resolve_calendar_month("not-a-date")

    def test_valid_data_mask_keeps_only_output_band(self):
        image = FakeImage()
        result = apply_configured_valid_data_mask(image, {
            "select_bands": ["monthly_recurrence"],
            "valid_data_mask": {"band": "has_observations", "valid_value": 1},
        })

        self.assertIs(result, image)
        self.assertEqual(image.equal_value, 1)
        self.assertIs(image.applied_mask, image)
        self.assertEqual(image.selected_bands, ["monthly_recurrence"])


if __name__ == "__main__":
    unittest.main()

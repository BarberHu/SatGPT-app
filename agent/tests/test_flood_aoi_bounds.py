"""Check geocoded boundary handling without network or model initialization."""
import importlib.util
import unittest
from pathlib import Path
import sys
from unittest.mock import Mock


def load_geometry_helpers():
    # The resolver is now independent of models/GEE and can be tested directly.
    path = Path(__file__).resolve().parents[1] / "flood_aoi.py"
    sys.path.insert(0, str(path.parent))
    try:
        spec = importlib.util.spec_from_file_location("tested_flood_aoi", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return vars(module)
    finally:
        sys.path.pop(0)


class FloodAoiBoundsTests(unittest.TestCase):
    def setUp(self):
        self.helpers = load_geometry_helpers()
        self.ring = [[85.1, 28.0], [85.6, 28.0], [85.6, 28.4], [85.1, 28.4], [85.1, 28.0]]
        self.bounds = {"west": 85.1, "south": 28.0, "east": 85.6, "north": 28.4}

    def test_polygon_boundary_produces_real_bounds(self):
        geometry = {"type": "Polygon", "coordinates": [self.ring]}
        self.assertEqual(self.helpers["_bounds_from_geometry"](geometry), self.bounds)

    def test_multipolygon_bounds_include_all_parts(self):
        geometry = {"type": "MultiPolygon", "coordinates": [
            [self.ring], [[[86, 29], [86.5, 29], [86.5, 29.5], [86, 29.5], [86, 29]]],
        ]}
        self.assertEqual(self.helpers["_bounds_from_geometry"](geometry), {
            "west": 85.1, "south": 28, "east": 86.5, "north": 29.5,
        })

    def test_existing_boundary_without_bounds_recovers_center(self):
        aoi = {"bounds": None, "geojson": {"type": "Feature", "geometry": {
            "type": "Polygon", "coordinates": [self.ring],
        }}}
        fields = self.helpers["aoi_to_geo_fields"](aoi)
        self.assertEqual(fields["bounds"], self.bounds)
        self.assertAlmostEqual(fields["coordinates"][0], 85.35)
        self.assertAlmostEqual(fields["coordinates"][1], 28.2)
        self.assertIsNone(aoi["bounds"])

    def test_place_resolution_and_search_use_the_same_fix_across_regions(self):
        # Synthetic boxes test the shared logic; these are not official boundaries.
        for label, west, south in [
            ("Synthetic Thai region", 100.4, 13.6), ("Zhengzhou, China", 113.5, 34.6),
            ("Jakarta, Indonesia", 106.6, -6.4), ("Dushanbe, Tajikistan", 68.7, 38.4),
            ("Western hemisphere test scope", -74.2, 40.5), ("Equator test scope", 0.0, 0.0),
        ]:
            with self.subTest(region=label):
                east, north = west + 0.2, south + 0.2
                ring = [[west, south], [east, south], [east, north], [west, north], [west, south]]
                expected = {"west": west, "south": south, "east": east, "north": north}
                self.helpers["_query_nominatim"] = Mock(return_value={"features": [{
                    "type": "Feature", "properties": {"category": "boundary", "type": "administrative", "display_name": label, "place_id": 123},
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                }]})
                resolution = self.helpers["resolve_location_aoi"](label)
                candidates = self.helpers["search_location_candidates"](label)
                self.assertEqual(resolution["bounds"], expected)
                self.assertEqual(resolution["resolved_aoi"]["bounds"], expected)
                self.assertEqual(candidates[0]["resolved_aoi"]["bounds"], expected)
                self.assertAlmostEqual(resolution["coordinates"][0], west + 0.1)
                self.assertAlmostEqual(candidates[0]["coordinates"][1], south + 0.1)

    def test_bangkok_search_and_analysis_share_the_land_reference_without_network(self):
        network = Mock(side_effect=AssertionError("Bangkok should not require a geocoder request"))
        self.helpers["_query_nominatim"] = network
        for query in ("bangkok", "Bangkok, Thailand", " BANGKOK ", "曼谷", "กรุงเทพมหานคร"):
            with self.subTest(query=query):
                candidate = self.helpers["search_location_candidates"](query)[0]
                resolution = self.helpers["resolve_location_aoi"](query)
                self.assertEqual(candidate["geojson"], resolution["geojson"])
                self.assertEqual(candidate["bounds"], resolution["bounds"])
                self.assertGreater(candidate["bounds"]["south"], 13.49)
                self.assertLess(candidate["bounds"]["south"], 13.50)
                self.assertEqual(candidate["source"], "reference_boundary")
                self.assertEqual(candidate["boundary_year"], "2017")
                self.assertIn("HDX", candidate["source_label"])
        network.assert_not_called()

    def test_osm_bangkok_identity_is_replaced_for_other_search_spellings(self):
        maritime_ring = [[100.3, 13.2], [100.9, 13.2], [100.9, 13.95], [100.3, 13.95], [100.3, 13.2]]
        self.helpers["_query_nominatim"] = Mock(return_value={"features": [{
            "type": "Feature", "properties": {"category": "boundary", "type": "administrative", "display_name": "Bangkok, Thailand", "osm_type": "relation", "osm_id": 92277},
            "geometry": {"type": "Polygon", "coordinates": [maritime_ring]},
        }]})
        candidate = self.helpers["search_location_candidates"]("Krung Thep")[0]
        resolution = self.helpers["resolve_location_aoi"]("Krung Thep")
        self.assertGreater(candidate["bounds"]["south"], 13.49)
        self.assertEqual(candidate["geojson"], resolution["geojson"])

    def test_bangkok_district_and_metropolitan_queries_are_not_city_aliases(self):
        lookup = self.helpers["find_reference_boundary"]
        for query in ("Bangkok Metropolitan Region", "Bangkok Noi", "Bang Khun Thian, Bangkok", "Bangkok, US"):
            self.assertIsNone(lookup(query=query))
        self.assertIsNone(lookup(properties={"osm_type": "way", "osm_id": 92277}))

    def test_reference_boundary_is_not_mutated_by_a_previous_search(self):
        lookup = self.helpers["find_reference_boundary"]
        first = lookup(query="Bangkok")
        first["geometry"]["coordinates"][0][0][1] = 0
        first["properties"]["source_label"] = "changed"
        second = lookup(query="Bangkok")
        self.assertGreater(second["geometry"]["coordinates"][0][0][1], 13.49)
        self.assertIn("HDX", second["properties"]["source_label"])

    def test_other_geocoder_polygons_are_not_mislabeled_official(self):
        self.helpers["_query_nominatim"] = Mock(return_value={"features": [{
            "type": "Feature", "properties": {"category": "boundary", "type": "administrative", "display_name": "Test city", "place_id": 4},
            "geometry": {"type": "Polygon", "coordinates": [self.ring]},
        }]})
        candidate = self.helpers["search_location_candidates"]("Test city")[0]
        resolution = self.helpers["resolve_location_aoi"]("Test city")
        self.assertEqual(candidate["source"], "osm_boundary")
        self.assertEqual(resolution["resolved_aoi"]["source"], "osm_boundary")

    def test_point_bbox_is_never_promoted_to_an_administrative_boundary(self):
        self.helpers["_query_nominatim"] = Mock(return_value={"features": [{
            "type": "Feature", "properties": {"category": "place", "type": "city", "display_name": "Point city", "place_id": 4},
            "geometry": {"type": "Point", "coordinates": [85.35, 28.2]},
            "bbox": [85.1, 28.0, 85.6, 28.4],
        }]})
        self.assertEqual(self.helpers["search_location_candidates"]("Point city"), [])
        resolution = self.helpers["resolve_location_aoi"]("Point city")
        self.assertIsNone(resolution["resolved_aoi"])
        self.assertIsNone(resolution["bounds"])
        self.assertFalse(resolution["aoi_resolution_meta"]["can_analyze"])

    def mock_features(self, features):
        self.helpers["_query_nominatim"] = Mock(return_value={"features": features})

    def feature(self, geometry=None, **properties):
        return {"type": "Feature", "properties": {
            "category": "boundary", "type": "administrative", "display_name": "Test city",
            "osm_type": "relation", "osm_id": 7, **properties,
        }, "geometry": geometry or {"type": "Polygon", "coordinates": [self.ring]}}

    def test_building_and_place_polygons_are_not_administrative_candidates(self):
        self.mock_features([self.feature(category="building", type="residential"),
                            self.feature(category="place", type="city")])
        self.assertEqual(self.helpers["search_location_candidates"]("Test"), [])

    def test_bad_geometry_is_rejected_without_bbox_or_model_replacement(self):
        rings = [
            [[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]],  # bow tie
            [[0, 0], [1, 0], [1, 1], [0, 1]],  # not closed
            [[0, 0], [1, 0], [float('nan'), 1], [0, 0]],
            [[0, 0], [1, 0], [float('inf'), 1], [0, 0]],
            [[1800, 0], [1801, 0], [1801, 1], [1800, 0]],
            [[0, 0], [0, 0], [0, 0], [0, 0]],
        ]
        model = Mock(side_effect=AssertionError("Must never guess a replacement boundary"))
        self.helpers["_generate_geojson_with_llm"] = model
        for ring in rings:
            with self.subTest(ring=ring):
                feature = self.feature({"type": "Polygon", "coordinates": [ring]})
                feature["bbox"] = [0, 0, 1, 1]
                self.mock_features([feature])
                self.assertEqual(self.helpers["search_location_candidates"]("Test"), [])
                self.assertIsNone(self.helpers["resolve_location_aoi"]("Test")["resolved_aoi"])
        model.assert_not_called()

    def test_holes_and_all_islands_are_preserved_with_actual_bounds(self):
        hole = [[85.2, 28.1], [85.3, 28.1], [85.3, 28.2], [85.2, 28.2], [85.2, 28.1]]
        island = [[86, 29], [86.2, 29], [86.2, 29.2], [86, 29.2], [86, 29]]
        geometry = {"type": "MultiPolygon", "coordinates": [[self.ring, hole], [island]]}
        feature = self.feature(geometry)
        feature["bbox"] = [-180, -90, 180, 90]  # bad provider bbox ignored
        self.mock_features([feature])
        candidate = self.helpers["search_location_candidates"]("Test")[0]
        self.assertEqual(candidate["geojson"]["geometry"], geometry)
        self.assertEqual(candidate["bounds"], {"west": 85.1, "south": 28, "east": 86.2, "north": 29.2})
        self.assertEqual(candidate["geojson"], self.helpers["resolve_location_aoi"]("Test")["geojson"])

    def test_same_name_different_regions_are_retained_and_require_selection(self):
        bigger = {"type": "Polygon", "coordinates": [[[85, 27], [87, 27], [87, 30], [85, 30], [85, 27]]]}
        self.mock_features([self.feature(extratags={"admin_level": "8"}, addresstype="city"),
                            self.feature(bigger, osm_id=8, extratags={"admin_level": "4"}, addresstype="state")])
        candidates = self.helpers["search_location_candidates"]("Test")
        self.assertEqual(len(candidates), 2)
        self.assertEqual([c["admin_level"] for c in candidates], ["8", "4"])
        resolution = self.helpers["resolve_location_aoi"]("Test")
        self.assertIsNone(resolution["resolved_aoi"])
        self.assertEqual(resolution["aoi_resolution_meta"]["source"], "ambiguous")
        self.assertEqual(len(resolution["aoi_resolution_meta"]["candidates"]), 2)

    def test_duplicate_geometry_with_different_ring_order_does_not_create_ambiguity(self):
        reversed_geometry = {"type": "Polygon", "coordinates": [list(reversed(self.ring))]}
        self.mock_features([self.feature(), self.feature(reversed_geometry, osm_id=8, display_name="Alternate city label")])
        self.assertEqual(len(self.helpers["search_location_candidates"]("Test")), 1)
        self.assertIsNotNone(self.helpers["resolve_location_aoi"]("Test")["resolved_aoi"])

    def test_network_failure_is_unresolved_instead_of_a_guessed_world_or_polygon(self):
        self.helpers["_query_nominatim"] = Mock(side_effect=TimeoutError("Unavailable"))
        resolution = self.helpers["resolve_location_aoi"]("Test")
        self.assertIsNone(resolution["resolved_aoi"])
        self.assertIsNone(resolution["bounds"])
        self.assertEqual(resolution["aoi_resolution_meta"]["status"], "Boundary unavailable")

    def test_identical_shapes_at_different_levels_remain_explicit_choices(self):
        self.mock_features([self.feature(extratags={"admin_level": "8"}),
                            self.feature(osm_id=8, extratags={"admin_level": "4"})])
        self.assertEqual(len(self.helpers["search_location_candidates"]("Test")), 2)
        self.assertIsNone(self.helpers["resolve_location_aoi"]("Test")["resolved_aoi"])

    def test_coordinate_accumulator_collects_all_rings_and_retains_zero_values(self):
        outer = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]
        hole = [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]]
        coordinates = [outer, hole]
        result = []
        extracted = self.helpers["_extract_all_coordinates"](coordinates, result)
        self.assertIs(extracted, result)
        self.assertEqual(extracted, outer + hole)


if __name__ == "__main__":
    unittest.main()

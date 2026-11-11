import unittest
from unittest.mock import MagicMock, patch

from basic import preset_layers as presets


class PresetLayersTest(unittest.TestCase):
    def test_annual_water_counts_are_binary_before_class_visualization(self):
        class Pixel:
            def __init__(self, value): self.value = value
            def unmask(self, _): return self
            def gt(self, other): return Pixel(int(self.value > other))
            def where(self, condition, replacement): return Pixel(replacement if condition.value else self.value)
            def rename(self, _): return self
            def selfMask(self): return self
            def visualize(self, **_): return self.value
        # Several permanent-water years must stay class 1, never saturate to red class 2.
        self.assertEqual(presets.raster._visualize_single_inundation(Pixel(5), Pixel(0)), 1)
        self.assertEqual(presets.raster._visualize_single_inundation(Pixel(5), Pixel(1)), 2)

    def test_year_clamp_and_date_limits(self):
        self.assertEqual(presets.effective_parameters('singleInundationEvent', {'year_start': 1900, 'year_end': 2030}), {'year_start': 1984, 'year_end': 2021})
        with self.assertRaises(ValueError):
            presets.effective_parameters('wildfireRisk', {'time_start': '2017-01-01', 'time_end': '2017-02-01'})
        with self.assertRaises(ValueError):
            presets.effective_parameters('burnHistory', {'time_start': '2021-01-01', 'time_end': '2021-01-02'})

    def test_legends_use_real_palettes_and_context_dates(self):
        context = presets.raster.get_basic_layer_catalog()['supplementary']
        population = presets.presentation('populationDensity', {})
        self.assertEqual(population['visualization'], context['populationDensity']['visualization'])
        self.assertEqual(population['metadata']['observed_at'], '2020')
        self.assertIn('adjusted', population['metadata']['dataset_id'])
        soil = presets.presentation('soilTexture', {})
        self.assertEqual(len(soil['legend']['labels']), 12)
        self.assertIn('10 cm', soil['metadata']['description'])
        landcover = presets.presentation('lclu', {})
        self.assertEqual(len(landcover['legend']['labels']), 11)
        self.assertEqual(len(landcover['visualization']['palette']), 11)
        hotspot = presets.presentation('inundationHotspot', {'year_start': 2000, 'year_end': 2021})
        self.assertEqual(hotspot['legend']['type'], 'composite')
        self.assertEqual(hotspot['visualization']['min'], .1)

    def test_uses_same_rendered_image_for_preview_without_palette_and_survives_preview_failure(self):
        aoi = {'geojson': {'type': 'Polygon', 'coordinates': [[[100,10],[100.1,10],[100.1,10.1],[100,10.1],[100,10]]]}, 'bounds': {'west':0,'south':0,'east':1,'north':1}}
        image = MagicMock()
        image.mask.return_value.reduceRegion.return_value.getInfo.return_value = {'vis-red': 1}
        def generate(payload, *, _images):
            self.assertEqual(payload['layer_keys'], ['slopeSteepness'])
            _images['SlopeSteepness'] = image
            return {'eeMapURLSlopeSteepness': 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}'}
        with patch.object(presets.raster, 'get_agent_raster_layers_payload', side_effect=generate), patch.object(presets.raster, 'aoi_to_ee_geometry', return_value='region'), patch.object(presets.ee.Reducer,'max'), patch('harness.app.gee_worker.save_thumbnail', side_effect=TimeoutError()) as preview:
            result = presets.get_preset_layer_payload({'preset_id': 'slopeSteepness', 'aoi': aoi})
            self.assertEqual(result['status'], 'ready')
            self.assertEqual(result['layer']['bounds'], [100,10,100.1,10.1])
            self.assertIsNone(result['layer']['thumbnail'])
            self.assertEqual(preview.call_args.args, (image, {}, [100,10,100.1,10.1], presets.ee))
            image.mask.return_value.reduceRegion.return_value.getInfo.return_value = {'vis-red': None}
            self.assertEqual(presets.get_preset_layer_payload({'preset_id': 'slopeSteepness', 'aoi': aoi})['status'], 'empty')

    def test_pending_or_unknown_presets_are_rejected(self):
        with self.assertRaises(ValueError):
            presets.get_preset_layer_payload({'preset_id': 'burnSeverity'})


if __name__ == '__main__':
    unittest.main()

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

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
        self.assertEqual(population['visualization'], {
            'min': 0, 'max': 5,
            'palette': context['populationDensity']['visualization']['palette'],
        })
        self.assertEqual(population['legend'], {'type': 'categorical',
            'labels': ['>0 to 1', '>1 to 5', '>5 to 20', '>20 to 100', '>100 to 500', '>500'],
            'note': '0 is transparent'})
        self.assertEqual(population['metadata']['observed_at'], '2020')
        self.assertEqual(population['metadata']['source'], 'JRC GHSL')
        self.assertEqual(population['metadata']['dataset_id'], 'JRC/GHSL/P2023A/GHS_POP/2020')
        self.assertEqual(population['metadata']['unit'], 'people/pixel')
        self.assertIn('100 m', population['metadata']['description'])
        self.assertIn('UNWPP-Adjusted', context['populationDensity']['dataset'])
        soil = presets.presentation('soilTexture', {})
        self.assertEqual(len(soil['legend']['labels']), 12)
        self.assertIn('10 cm', soil['metadata']['description'])
        landcover = presets.presentation('lclu', {})
        self.assertEqual(landcover['metadata']['dataset_id'], 'ESA/WorldCover/v200')
        self.assertEqual(landcover['metadata']['observed_at'], '2021')
        self.assertEqual(len(landcover['legend']['labels']), 11)
        self.assertEqual(len(landcover['visualization']['palette']), 11)
        hotspot = presets.presentation('inundationHotspot', {'year_start': 2000, 'year_end': 2021})
        self.assertEqual(hotspot['legend']['type'], 'composite')
        self.assertEqual(hotspot['visualization']['min'], .1)

    def test_population_count_masks_negative_nodata_but_retains_zero_and_raw_values(self):
        with patch.object(presets.ee, 'Image') as image:
            count = presets._build_population_count('region')
            selected = image.return_value.select.return_value
            self.assertEqual(image.mock_calls, [
                call('JRC/GHSL/P2023A/GHS_POP/2020'),
                call().select('population_count'),
                call().select().gte(0),
                call().select().updateMask(selected.gte.return_value),
                call().select().updateMask().clip('region'),
            ])
            self.assertIs(count, selected.updateMask.return_value.clip.return_value)

    def test_population_display_classes_use_inclusive_upper_bounds_and_mask_zero(self):
        class Pixel:
            def __init__(self, value): self.value = value
            def gt(self, threshold): return Pixel(None if self.value is None else int(self.value > threshold))
            def add(self, other): return Pixel(None if self.value is None else self.value + other.value)
            def updateMask(self, mask): return Pixel(self.value if mask.value else None)
            def projection(self): return 'native grid'
            def reproject(self, *, crs):
                self.crs = crs
                return self

        cases = [(None, None), (0, None), (0.01, 0), (1, 0), (1.01, 1), (5, 1), (5.01, 2),
                 (20, 2), (20.01, 3), (100, 3), (100.01, 4), (500, 4), (500.01, 5)]
        for value, display_class in cases:
            with self.subTest(value=value):
                counts = Pixel(value)
                rendered = presets._classify_population_counts(counts)
                self.assertEqual(rendered.value, display_class)
                self.assertEqual(rendered.crs, 'native grid')
                self.assertEqual(counts.value, value)

    def test_basic_population_publishes_one_rendered_image_for_tiles_and_preview(self):
        aoi = {'geojson': {'type': 'Polygon', 'coordinates': [[[100,10],[101,10],[101,11],[100,11],[100,10]]]}}
        count, image = MagicMock(), MagicMock()
        tile_url = 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}'
        thumbnail_url = 'https://earthengine.googleapis.com/v1/projects/p/thumbnails/t:getPixels'
        image.getMapId.return_value = {'mapid': 'map', 'token': '', 'tile_fetcher': SimpleNamespace(url_format=tile_url)}
        image.getThumbURL.return_value = thumbnail_url
        stats = count.reduceRegion.return_value
        stats.getInfo.return_value = {'population_count_min': 0, 'population_count_max': 281.375}
        with (patch.object(presets, '_build_population_count', return_value=count),
              patch.object(presets, '_classify_population_counts') as classify,
              patch.object(presets.raster, 'visualize_image', return_value=image) as render,
              patch.object(presets.raster, 'aoi_to_ee_geometry', return_value='grid'),
              patch.object(presets.raster, 'get_agent_raster_layers_payload') as shared,
              patch.object(presets.ee.Reducer, 'minMax') as reducer):
            result = presets.get_preset_layer_payload({'preset_id': 'populationDensity', 'aoi': aoi})
            self.assertEqual(result['status'], 'ready')
            self.assertEqual(result['layer']['name'], 'Population Count')
            self.assertEqual(result['layer']['url'], tile_url)
            self.assertEqual(result['layer']['thumbnail'], {'url': thumbnail_url})
            self.assertEqual(result['layer']['visualization'], presets.presentation('populationDensity', {})['visualization'])
            self.assertIn('0 to 281.375 people/pixel', result['layer']['metadata']['description'])
            classify.assert_called_once_with(count)
            render.assert_called_once_with(classify.return_value, result['layer']['visualization'])
            image.getMapId.assert_called_once_with()
            image.getThumbURL.assert_called_once_with({'format': 'png', 'dimensions': 256, 'region': 'grid'})
            count.reduceRegion.assert_called_once_with(reducer=reducer.return_value.unweighted.return_value,
                                                        geometry='grid', crs=count.projection.return_value,
                                                        maxPixels=10_000_000, tileScale=4)
            image.mask.assert_not_called()
            stats.getInfo.return_value = {'population_count_min': None, 'population_count_max': None}
            self.assertEqual(presets.get_preset_layer_payload({'preset_id': 'populationDensity', 'aoi': aoi})['status'], 'empty')
            self.assertEqual(image.getThumbURL.call_count, 1)
            self.assertEqual(image.getMapId.call_count, 1)
            shared.assert_not_called()

    def test_all_zero_and_constant_positive_grids_retain_the_shared_legend(self):
        aoi = {'geojson': {'type': 'Polygon', 'coordinates': [[[100,10],[101,10],[101,11],[100,11],[100,10]]]}}
        count, image = MagicMock(), MagicMock()
        with (patch.object(presets, '_build_population_count', return_value=count),
              patch.object(presets, '_classify_population_counts') as classify,
              patch.object(presets.raster, 'visualize_image', return_value=image) as render,
              patch.object(presets.raster, 'aoi_to_ee_geometry', return_value='grid'),
              patch.object(presets.ee.Reducer, 'minMax')):
            expected = presets.presentation('populationDensity', {})
            for value in (0, 0.125):
                with self.subTest(value=value):
                    count.reduceRegion.return_value.getInfo.return_value = {
                        'population_count_min': value, 'population_count_max': value,
                    }
                    result = presets.get_preset_layer_payload({'preset_id': 'populationDensity', 'aoi': aoi})
                    self.assertEqual(result['status'], 'ready')
                    vis = result['layer']['visualization']
                    self.assertEqual(vis, expected['visualization'])
                    self.assertEqual(result['layer']['legend'], expected['legend'])
                    self.assertIn(f'{value:g} to {value:g} people/pixel', result['layer']['metadata']['description'])
                    self.assertEqual(render.call_args.args, (classify.return_value, vis))

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

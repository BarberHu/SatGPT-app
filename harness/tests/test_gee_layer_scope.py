import unittest
from types import SimpleNamespace
from unittest.mock import patch

from harness.app import gee_worker
from harness.app.layer_generation import generation_recipe, replay_payload


OUTER = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]
HOLE = [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1], [0.5, 0.5]]
SECOND = [[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]
AREA = {'type': 'MultiPolygon', 'coordinates': [[OUTER, HOLE], [SECOND]]}
CONTEXT = {'analysis_region': AREA, 'bounds': [0, 0, 4, 2]}


class Image:
    def __init__(self, _value):
        pass

    def clip(self, region):
        self.region = region
        return self

    def getMapId(self, _options):
        return {'mapid': 'projects/test/maps/test'}

    def getThumbURL(self, _options):
        return 'test-preview'


class LayerScopeTests(unittest.TestCase):
    def setUp(self):
        ee = SimpleNamespace(Image=Image, Geometry=lambda geometry: geometry)
        self.enterContext(patch.object(gee_worker, 'earth_engine', return_value=ee))

    def test_map_and_thumbnail_use_task_scope_even_if_script_rebinds_it(self):
        code = 'analysis_region = ee.Geometry({})\nresult = ee.Image(1)'
        payload = {'project': 'test', 'layer_code': code, 'analysis_context': CONTEXT,
                   'bounds': [-1, -1, 5, 3], 'defer_thumbnail': True}
        map_images = []
        get_map = Image.getMapId

        def record_map(image, options):
            map_images.append(image)
            return get_map(image, options)

        with patch.object(Image, 'getMapId', record_map), patch.object(
                gee_worker, 'save_thumbnail_recipe', return_value='thumbnail') as thumbnail:
            result = gee_worker.execute(payload)

        self.assertEqual(map_images[0].region, AREA)
        self.assertIs(thumbnail.call_args.args[0], map_images[0])
        self.assertEqual(result['thumbnail_ref'], 'thumbnail')

    def test_preview_clips_pixels_and_keeps_optional_framing(self):
        context = {'bounds': [0, 0, 2, 2],
                   'analysis_region': {'type': 'Polygon', 'coordinates': [OUTER, HOLE]}}
        local_frame = [0.1, 0.1, 1.5, 1.5]
        calls = []

        def record_preview(image, options):
            calls.append((image.region, options['region']))
            return 'test-preview'

        header = b'\x89PNG\r\n\x1a\n' + b'\0' * 16
        payload = {'operation': 'preview', 'project': 'test', 'code': 'result = ee.Image(1)',
                   'analysis_context': context}
        with patch.object(Image, 'getThumbURL', record_preview), patch.object(
                gee_worker, 'download_png', return_value=header), patch.object(gee_worker, 'save_png'):
            gee_worker.execute(payload)
            gee_worker.execute({**payload, 'region': local_frame})

        self.assertEqual(calls, [(context['analysis_region'], context['bounds']),
                                 (context['analysis_region'], local_frame)])

    def test_reload_clips_to_saved_viewport_and_legacy_without_scope_still_works(self):
        render = gee_worker.create_map_layer
        viewport = {'bounds': [0, 0, 2, 2]}
        layer = {'name': 'Test layer'}
        with patch.object(gee_worker, 'create_map_layer', wraps=render) as create_map:
            for context in (viewport, None):
                recipe = generation_recipe('result = ee.Image(1)', layer, context)
                gee_worker.execute({'project': 'test', **replay_payload(recipe)})

        first, second = (call.args[0] for call in create_map.call_args_list)
        self.assertEqual(first.region, {'type': 'Polygon', 'coordinates': [OUTER]})
        self.assertFalse(hasattr(second, 'region'))

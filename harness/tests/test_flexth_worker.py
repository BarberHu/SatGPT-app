import unittest
from importlib.util import find_spec
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from harness.app.flexth_worker import aligned_dtm, depth_products, write_tif


class FlexthWorkerTests(unittest.TestCase):
    def test_depth_converts_units_and_preserves_evidence_classes(self):
        pixels = np.array([[0, 1, 2, 2], [255, 254, 1, 1]], dtype=np.uint8)
        raw = np.array([[90, 125, 85, 110], [200, 300, 9999, 10]], dtype=np.uint16)
        terrain = np.array([[1, 1, 1, 1], [1, 1, 1, 0]], dtype=bool)
        eligible = np.array([[0, 0, 1, 0], [0, 0, 0, 0]], dtype=bool)
        depth, classes, observed, estimated, added = depth_products(pixels, raw, terrain, eligible)
        np.testing.assert_allclose(depth, [[np.nan, 1.25, .85, np.nan], [np.nan] * 4])
        np.testing.assert_array_equal(classes, [[0, 1, 3, 2], [255, 254, 1, 1]])
        self.assertEqual(observed.sum(), 3)
        self.assertEqual(estimated.sum(), 2)
        self.assertEqual(added.sum(), 1)

    @unittest.skipUnless(find_spec('rasterio'), 'requires the independent FLEXTH environment')
    def test_dtm_aligns_to_target_grid_and_preserves_uncovered_cells(self):
        import rasterio
        from rasterio.transform import from_origin

        with TemporaryDirectory() as directory:
            path = Path(directory) / 'terrain.tif'
            src = {'driver': 'GTiff', 'count': 1, 'height': 2, 'width': 2,
                   'crs': 'EPSG:32636', 'transform': from_origin(450000, 5200020, 20, 20)}
            write_tif(path, np.full((2, 2), 12, dtype='float32'), src,
                      nodata=np.nan, description='Elevation', unit='m')
            target = {**src, 'width': 6, 'height': 4, 'transform': from_origin(449990, 5200020, 10, 10)}
            dtm, metadata = aligned_dtm(path, target)
            self.assertEqual(metadata['dtm_native_resolution'], [20, 20])
            np.testing.assert_array_equal(dtm[:, 1:5], 12)
            self.assertTrue(np.isnan(dtm[:, [0, 5]]).all())
            with rasterio.open(path) as source:
                self.assertEqual(source.units, ('m',))


if __name__ == '__main__':
    unittest.main()

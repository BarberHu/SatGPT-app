"""Run pinned FLEXTH in its own Python process and publish task-owned rasters."""

from contextlib import redirect_stdout
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
from uuid import uuid4

FLEXTH_COMMIT = 'a409e3ba14ba6833539f1a6f6076bdb865cd5207'
SOURCE_SHA256 = '8dbdb5dadd3abb2c1efae340975eb3e6b0a0f02bcdc295cb011d6d861b23031c'
MAX_PIXELS = 1_000_000
MIN_DTM_COVERAGE = 0.95
PALETTE = ('e0f3ff', '56b4e9', '1864ab', '301860')

# A Conda interpreter started directly by the worker pool has no activation shell.
_dll_directory = None
if os.name == 'nt':
    conda_library = Path(sys.prefix) / 'Library'
    if (conda_library / 'bin').is_dir():
        _dll_directory = os.add_dll_directory(str(conda_library / 'bin'))
        os.environ.setdefault('PROJ_DATA', str(conda_library / 'share' / 'proj'))
        os.environ.setdefault('GDAL_DATA', str(conda_library / 'share' / 'gdal'))

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def run_upstream(script, inputs, outputs, *, expand):
    try:
        source = Path(script).read_bytes().replace(b'\r\n', b'\n')
    except OSError:
        raise ValueError('The configured FLEXTH script is unavailable.') from None
    if sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError('The configured FLEXTH script does not match the supported upstream commit.')
    flexth = ModuleType('satgpt_flexth_upstream')
    with redirect_stdout(sys.stderr):
        exec(compile(source, 'FLEXTH.py', 'exec'), flexth.__dict__)
        flexth.input_dir = inputs
        flexth.output_dir = outputs
        flexth.param_output_map = 'WD'
        flexth.param_spread_outside_exclusion_mask = False
        if not expand:
            flexth.param_max_propagation_distance = 0
        flexth.flood_processing(*(inputs / f'{name}.tif' for name in
                                  ('flood', 'dtm', 'exclusion', 'obswater', 'permanent_water')))
    (depth,) = outputs.glob('WD_*.tif')
    return depth


def write_tif(path, array, profile, *, nodata=None, description, unit=None):
    import rasterio

    with rasterio.open(path, 'w', **profile, dtype=array.dtype, nodata=nodata) as image:
        image.write(array, 1)
        image.set_band_description(1, description)
        if unit:
            image.set_band_unit(1, unit)


def aligned_dtm(path, profile):
    import numpy as np
    import rasterio
    from rasterio.warp import Resampling, reproject

    destination = np.full((profile['height'], profile['width']), np.nan, dtype='float32')
    try:
        with rasterio.open(path, driver='GTiff') as source:
            if not source.crs or not source.count:
                raise ValueError('The configured DTM needs an identified CRS and an elevation band.')
            reproject(rasterio.band(source, 1), destination, dst_transform=profile['transform'],
                      dst_crs=profile['crs'], dst_nodata=np.nan, resampling=Resampling.bilinear)
            native = {'dtm_crs': source.crs.to_string(), 'dtm_native_resolution': list(source.res),
                      'dtm_xy_unit': 'degrees' if source.crs.is_geographic else source.crs.linear_units}
    except (OSError, rasterio.errors.RasterioError):
        raise ValueError('The configured DTM GeoTIFF could not be read or aligned.') from None
    return destination, native


def depth_products(pixels, raw_cm, valid_terrain, eligible_exclusion):
    import numpy as np

    observed = pixels == 1
    valid_depth = (raw_cm > 0) & (raw_cm != 9999) & valid_terrain & (observed | eligible_exclusion)
    added = eligible_exclusion & valid_depth
    depth = np.full(pixels.shape, np.nan, dtype='float32')
    depth[valid_depth] = raw_cm[valid_depth].astype('float32') / 100
    classes = pixels.copy()
    classes[added] = 3
    return depth, classes, observed, valid_depth, added


def render_overlay(path, depth, profile, maximum):
    import numpy as np
    from PIL import Image
    from rasterio.transform import array_bounds, from_bounds
    from rasterio.warp import Resampling, reproject, transform_bounds

    extent = array_bounds(*depth.shape, profile['transform'])
    projected = transform_bounds(profile['crs'], 'EPSG:3857', *extent)
    w, s, e, n = projected
    size = min(1024, max(depth.shape))
    width = max(1, round(size * (e - w) / max(e - w, n - s)))
    height = max(1, round(size * (n - s) / max(e - w, n - s)))
    target = np.full((height, width), np.nan, dtype='float32')
    warp = {'src_transform': profile['transform'], 'src_crs': profile['crs'], 'src_nodata': np.nan,
            'dst_transform': from_bounds(*projected, width, height), 'dst_crs': 'EPSG:3857', 'dst_nodata': np.nan}
    reproject(depth, target, **warp, resampling=Resampling.nearest)
    if not np.isfinite(target).any():
        reproject(depth, target, **warp, resampling=Resampling.max)
    rgba = np.zeros((*target.shape, 4), dtype='uint8')
    ramp = np.array([list(bytes.fromhex(color)) for color in PALETTE])
    depths = np.nan_to_num(target)
    for channel in range(3):
        rgba[:, :, channel] = np.interp(depths, np.linspace(0, maximum, len(ramp)), ramp[:, channel])
    rgba[:, :, 3] = np.isfinite(target) * 255
    Image.fromarray(rgba).save(path)
    return transform_bounds('EPSG:3857', 'EPSG:4326', *projected)


def estimate(payload):
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    from harness.app.flood_results import OUTSIDE, load
    from harness.app.geo_index import artifact_directory, get

    context = payload['geo_context']
    source_ref = payload['flood_data_ref']
    record = get(context, source_ref, ('flood',))
    recipe, pixels = load(artifact_directory(context, record['task_id']), record['legacy_ref'])
    if pixels.size > MAX_PIXELS or min(pixels.shape) < 3:
        return {'status': 'grid_out_of_budget', 'max_pixels': MAX_PIXELS}
    if not (pixels == 1).any():
        return {'status': 'no_detected_flood'}
    if not (pixels == 0).any():
        return {'status': 'no_observed_dry_terrain'}

    grid = recipe['grid']
    profile = {'driver': 'GTiff', 'height': grid['height'], 'width': grid['width'], 'count': 1,
               'crs': grid['crs'], 'transform': from_origin(grid['x'], grid['y'], grid['scale'], grid['scale']),
               'compress': 'deflate'}
    requested_expansion = payload.get('expand_excluded') is True
    known_blindness = recipe['provenance'].get('exclusion_role') == 'sensor_blindness'
    eligible = (pixels == 2) & requested_expansion & known_blindness
    if requested_expansion and not eligible.any():
        return {'status': 'no_eligible_exclusion', 'flood_data_ref': source_ref}
    domain = (pixels <= 1) | eligible
    terrain, dtm_metadata = aligned_dtm(payload['dtm'], profile)
    terrain[~domain] = np.nan
    valid_terrain = np.isfinite(terrain)
    coverage = np.count_nonzero(valid_terrain) / np.count_nonzero(domain)
    if coverage < MIN_DTM_COVERAGE or not ((pixels == 1) & valid_terrain).any() or not ((pixels == 0) & valid_terrain).any():
        return {'status': 'insufficient_dtm_coverage', 'dtm_coverage_fraction': coverage,
                'minimum_coverage_fraction': MIN_DTM_COVERAGE}

    directory = Path(payload['artifact_dir'])
    directory.mkdir(parents=True, exist_ok=True)
    ref = uuid4().hex
    with TemporaryDirectory(prefix='flexth-', dir=directory) as temporary:
        work = Path(temporary)
        write_tif(work / 'flood.tif', ((pixels == 1) & valid_terrain).astype('uint8'), profile,
                  description='Input candidate inundation')
        write_tif(work / 'dtm.tif', terrain, profile, nodata=np.nan, description='Terrain elevation', unit='m')
        # FLEXTH uses exclusion for both wet/dry interpolation and propagation.
        # Invalid terrain blocks propagation while also excluding unsupported border pixels.
        excluded = eligible | ~valid_terrain
        if excluded.any():
            write_tif(work / 'exclusion.tif', excluded.astype('uint8'), profile,
                      description='Eligible sensor-blind or unavailable terrain pixels')
        result = run_upstream(payload['script'], work, work, expand=requested_expansion)
        with rasterio.open(result) as raw:
            if raw.shape != pixels.shape or raw.crs != rasterio.crs.CRS.from_string(grid['crs']) or raw.transform != profile['transform']:
                raise ValueError('FLEXTH returned a water depth raster on an unexpected grid.')
            depth, classes, observed, valid_depth, added = depth_products(pixels, raw.read(1), valid_terrain, eligible)
        if not valid_depth.any():
            return {'status': 'no_depth_estimate', 'dtm_coverage_fraction': coverage}

        depth_name, extent_name, image_name = f'{ref}-depth.tif', f'{ref}-extent.tif', f'{ref}.png'
        write_tif(work / depth_name, depth, profile, nodata=np.nan, description='Estimated water depth', unit='m')
        write_tif(work / extent_name, classes, profile, nodata=OUTSIDE,
                  description='0 dry; 1 observed flood; 2 excluded; 3 inferred flood; 255 unknown')
        display_max = max(0.1, round(float(np.percentile(depth[valid_depth], 98)), 2))
        image_bounds = render_overlay(work / image_name, depth, profile, display_max)
        for name in (depth_name, extent_name, image_name):
            (work / name).replace(directory / name)

    area = grid['scale'] ** 2 / 1_000_000
    observed_pixels = np.count_nonzero(observed)
    estimated_observed_pixels = np.count_nonzero(observed & valid_depth)
    depth_coverage = estimated_observed_pixels / observed_pixels
    summary = {'status': 'ready', 'flood_data_ref': source_ref, 'upstream_commit': FLEXTH_COMMIT,
               'dtm_source': payload['dtm_source'], **dtm_metadata,
               'dtm_coverage_fraction': coverage, 'grid': grid, 'depth_unit': 'm',
               'observed_flood_km2': observed_pixels * area,
               'observed_flood_with_depth_km2': estimated_observed_pixels * area,
               'observed_flood_depth_coverage_fraction': depth_coverage,
               'inferred_flood_km2': np.count_nonzero(added) * area,
               'depth_max_m': round(float(np.nanmax(depth)), 2), 'expansion_performed': requested_expansion}
    layer = {'kind': 'image', 'name': 'FLEXTH estimated water depth', 'artifact_ref': ref,
             'bounds': recipe['bounds'], 'image_bounds': image_bounds, 'visible': True,
             'visualization': {'bands': ['estimated_water_depth'], 'min': 0, 'max': display_max, 'palette': PALETTE},
             'metadata': {'source': 'FLEXTH · ' + payload['dtm_source'], 'unit': 'm',
                          'observed_at': record.get('observed_at'),
                          'description': f'Terrain-based depth is available for {depth_coverage:.1%} of the original '
                                         'candidate inundation. The extent GeoTIFF distinguishes observed and inferred inundation.'}}
    return {'summary': summary, 'layer': layer}


def main():
    for line in sys.stdin:
        request = json.loads(line)
        try:
            result = estimate(request['payload'])
            if 'summary' not in result:
                result = {'summary': result}
        except ImportError:
            result = {'summary': {'status': 'unavailable', 'reason': 'The FLEXTH Python environment lacks required libraries.'}}
        except ValueError as exc:
            result = {'summary': {'status': 'invalid_inputs', 'reason': str(exc)[:400]}}
        except Exception as exc:
            print(f'FLEXTH calculation failed ({type(exc).__name__})', file=sys.stderr)
            result = {'summary': {'status': 'calculation_failed', 'reason': 'FLEXTH could not produce a valid depth raster.'}}
        print(json.dumps({'id': request['id'], 'ok': True, 'data': result}, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()

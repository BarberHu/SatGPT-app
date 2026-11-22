/** GEE tools for the SDK profile, adapted from cdllI/dsh-gee (MIT). */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool } from './worker-pool.js';
import { CatalogCoordinator } from './catalog-coordinator.js';
import { floodResultFor, GEOCODE_TOOL_NAME, mountControl, OSM_TOOL_NAMES, readBinding } from './runtime-control.js';

export const name = 'webgis-gee-tools';
export const inject = ['agents', 'llm', 'systemPrompt', 'tools'];

const root = process.env.WEBGIS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const project = process.env.GEE_PROJECT_ID;
const workerOptions = {
  python: process.env.SATGPT_HARNESS_PYTHON || 'python',
  worker: path.join(root, 'app', 'gee_worker.py'),
  cwd: root,
};
const pool = new WorkerPool(workerOptions, Number(process.env.SATGPT_GEE_WORKERS || 16), Number(process.env.SATGPT_GEE_QUEUE_LIMIT || 128));
const catalogReaders = new WorkerPool(workerOptions, 1);
const catalogRefreshers = new WorkerPool(workerOptions, 1);
const thumbnailWorkers = new WorkerPool(workerOptions, 1, 16);
const catalogDir = process.env.SATGPT_CATALOG_CACHE;
const catalog = new CatalogCoordinator(
  (owner, payload, signal, observe) => catalogReaders.run(owner, { ...payload, operation: 'catalog_read', catalog_dir: catalogDir },
    { signal, timeout: 10_000, observe }),
  (owner, observe) => catalogRefreshers.run(owner, { operation: 'catalog_refresh', catalog_dir: catalogDir },
    { timeout: 240_000, observe }),
);
const timingLog = process.env.SATGPT_HARNESS_TIMING_LOG;
let timingWriteFailed = false;

const OSM_ANALYSIS_TOOL = 'gee_osm_analyze';
const ROAD_FLOOD_TOOL = 'road_flood_exposure';
const osmEnabled = process.env.SATGPT_OSM_TOOLS === '1';
const TOOL_NAMES = ['gee_check', 'gee_status', 'gee_catalog', 'gee_eval', 'gee_preview', 'gee_layer', 'gee_publish_flood',
  'geo_data_search', 'geo_data_info',
  ...(osmEnabled ? [...OSM_TOOL_NAMES, OSM_ANALYSIS_TOOL, ROAD_FLOOD_TOOL] : []),
  ...(process.env.SATGPT_GEOCODING_URL?.trim() ? [GEOCODE_TOOL_NAME] : [])];
const SKILL_NAMES = new Set(['flood-extent', 'flood-exposure', 'sentinel2-latest', 'rainfall-analysis']);
const CODE_PARAMETER = { type: 'string', description: 'Restricted Earth Engine Python script.' };
const DATA_REF = { type: 'string', pattern: '^g_[a-f0-9]{32}$' };
const INPUTS = { type: 'object', maxProperties: 6, additionalProperties: DATA_REF,
  description: 'Python variable name to indexed area or flood data reference.' };
function execute(owner, payload, signal, toolCallId) {
  const operation = payload.operation || 'layer';
  const taskId = payload.analysis_context?.task_id;
  const callId = timingLog ? toolCallId || randomUUID() : null;
  const observe = timingLog && (point => {
    if (timingWriteFailed) return;
    try {
      appendFileSync(timingLog, JSON.stringify({ component: 'gee', operation, task_id: taskId,
        call_id: callId, ...point }) + '\n', { mode: 0o600 });
    } catch {
      timingWriteFailed = true;
      process.stderr.write('SatGPT could not write GEE timing events.\n');
    }
  });
  if (operation === 'catalog') return catalog.search(owner, payload, { signal, observe });
  if (operation === 'layer_thumbnail' || operation === 'layer_thumbnail_warmup') {
    const timeout = operation === 'layer_thumbnail_warmup' ? 15_000 : 45_000;
    return thumbnailWorkers.run(owner, { ...payload, project }, { signal, timeout, observe });
  }
  return pool.run(owner, { ...payload, project }, { signal, timeout: 150000, observe });
}

function focusBounds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) {
    throw new Error('bounds must be [west, south, east, north]');
  }
  const [west, south, east, north] = value;
  if (west < -180 || east > 180 || west >= east || south < -85 || north > 85 || south >= north) {
    throw new Error('bounds is outside valid geographic coordinates');
  }
  return value;
}

export async function runWithContext(payload, exec) {
  const id = exec?.agent?.session?.id;
  const binding = id && readBinding(String(id));
  if (!binding) throw new Error('No active SatGPT run is registered for this session');
  const { owner_id, conversation_id, task_id, run_id, bounds, analysis_region, analysis_aoi, artifact_dir } = binding;
  const roadExposure = payload.operation === ROAD_FLOOD_TOOL;
  const flood = roadExposure && payload.flood_ref ? floodResultFor(binding, payload.flood_ref) : null;
  const result = await execute(owner_id, { ...payload, artifact_dir,
    geo_context: binding.geo_context, area_ref: binding.area_ref,
    ...(payload.operation === 'flood_publish' && { bounds }),
    ...(roadExposure && { operation: 'road_flood' }), ...(flood && { flood_directory: flood.artifact_dir }),
    artifact_url: '/api/previews/' + conversation_id + '/' + task_id,
    analysis_context: { task_id, conversation_id, bounds, analysis_region, ...(analysis_aoi && { analysis_aoi }) },
  }, exec.signal, exec.callId);
  if (exec.signal?.aborted) throw new Error('Tool call cancelled');
  if (result.layer || result.preview) return { ...result, reference: { task_id, run_id } };
  return result;
}

export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'satgpt:analysis', order: 50, interpolate: false,
    text: readFileSync(new URL('./system-prompt.md', import.meta.url), 'utf8').trim() });

  ctx.on('agent/request', async ({ agent }, next) => {
    const request = await next();
    const binding = readBinding(String(agent.session.id));
    if (!binding || !Object.hasOwn(binding, 'reasoning_effort')) return request;
    const { reasoningEffort: inherited, ...config } = request;
    return binding.reasoning_effort === null ? config : { ...config, reasoningEffort: binding.reasoning_effort };
  });
  ctx.tools.register({
    name: 'gee_check',
    description: 'Optional local debugging for restricted GEE Python. Checks syntax, allowed statements and builtins, result assignment, and selected Earth Engine argument mistakes without a remote request. If valid is false, fix the reported error. gee_eval, gee_preview, and gee_layer already validate Python before executing routine code.',
    parameters: { type: 'object', properties: { code: CODE_PARAMETER }, required: ['code'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: {
        valid: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      }, required: ['valid', 'errors', 'warnings'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) { return runWithContext({ operation: 'check', code: args.code }, exec); },
  });

  ctx.tools.register({
    name: 'gee_status',
    description: 'Check the configured service account, Cloud project, Earth Engine API, and a real server-side round trip. Use when a GEE tool fails or credentials appear unavailable.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) { return runWithContext({ operation: 'status' }, exec); },
  });

  ctx.tools.register({
    name: 'gee_catalog',
    description: 'Search the public Earth Engine STAC dataset catalog by id, title, keywords, and description. A cached result can be marked stale while the catalog refreshes in the background. Only a cold cache or explicit refresh waits for a rebuild.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords, e.g. Sentinel-1 GRD.' },
        limit: { type: 'integer', description: 'Maximum results, 1-50; default 20.' },
        type: { type: 'string', enum: ['image_collection', 'image', 'table'] },
        refresh: { type: 'boolean', description: 'Rebuild the seven-day cache.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      return runWithContext({ operation: 'catalog', query: args.query || '', limit: args.limit || 20,
        type: args.type, refresh: Boolean(args.refresh) }, exec);
    },
  });

  ctx.tools.register({
    name: 'gee_eval',
    description: 'Return bounded metadata or statistics from read-only Earth Engine Python. Preserve source masks. Use gee_layer for map layers.',
    parameters: { type: 'object', properties: { code: CODE_PARAMETER, inputs: INPUTS }, required: ['code'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { result: {} }, required: ['result'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.result) }],
    },
    async execute(args, exec) {
      return runWithContext({ operation: 'eval', code: args.code, inputs: args.inputs }, exec);
    },
  });

  ctx.tools.register({
    name: 'gee_preview',
    description: 'Render a PNG preview in the conversation from an ee.Image. Use gee_layer for an interactive map.',
    parameters: {
      type: 'object',
      properties: {
        code: CODE_PARAMETER, name: { type: 'string' },
        bands: { type: 'array', items: { type: 'string' } },
        min: { type: 'number' }, max: { type: 'number' },
        palette: { type: 'array', items: { type: 'string' } },
        region: { type: 'array', items: { type: 'number' }, description: '[west, south, east, north]' },
        dimensions: { type: 'integer', description: 'Longest side 64-1024 pixels.' },
      },
      required: ['code'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { preview: { type: 'object', additionalProperties: true }, reference: { type: 'object' } }, required: ['preview', 'reference'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: `Preview ${value.preview.width}x${value.preview.height} PNG saved and shown in WebGIS.` }],
      presentationMeta: (args, value) => ({ ...value.reference, preview: value.preview, code: args.code }),
    },
    async execute(args, exec) {
      const visualization = {};
      for (const key of ['bands', 'min', 'max', 'palette']) if (args[key] !== undefined) visualization[key] = args[key];
      const value = await runWithContext({ operation: 'preview', code: args.code, name: args.name,
        visualization, region: args.region, dimensions: args.dimensions }, exec);
      return value;
    },
  });

  ctx.tools.register({
    name: 'gee_layer',
    description: 'Create an interactive layer and thumbnail from an ee.Image. Palette/min/max drive the legend. For consecutive integer classes, use legend.type=categorical with labels in palette order.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, code: CODE_PARAMETER, inputs: INPUTS,
        bounds: { type: 'array', items: { type: 'number' }, description: '[west, south, east, north] of the layer area' },
        bands: { type: 'array', items: { type: 'string' } },
        min: { type: 'number' }, max: { type: 'number' },
        palette: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object', properties: {
          source: { type: 'string' }, dataset_id: { type: 'string' },
          observed_at: { type: 'string' }, unit: { type: 'string' }, description: { type: 'string' },
        }, additionalProperties: false },
        legend: { type: 'object', properties: {
          type: { type: 'string', enum: ['categorical'] },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels for consecutive integer values min..max, exactly matching palette order.' },
        }, required: ['type', 'labels'], additionalProperties: false },
      },
      required: ['name', 'code', 'bounds'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { layer: { type: 'object', additionalProperties: true } }, required: ['layer'], additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `Map layer ${value.layer.name} created and sent to WebGIS.` }],
      presentationMeta: (args, value) => ({ ...value.reference, layer: value.layer,
        ...(value.thumbnail_ref && { thumbnail_ref: value.thumbnail_ref }), code: args.code,
        ...(args.inputs && { indexed_inputs: args.inputs }) }),
    },
    async execute(args, exec) {
      const bounds = focusBounds(args.bounds);
      const visualization = { name: args.name };
      for (const key of ['bands', 'min', 'max', 'palette']) if (args[key] !== undefined) visualization[key] = args[key];
      const value = await runWithContext({ layer_code: args.code, inputs: args.inputs, visualization, bounds, defer_thumbnail: true,
        metadata: args.metadata, legend: args.legend }, exec);
      if (bounds) value.layer.bounds = bounds;
      return value;
    },
  });
  registerFloodTools(ctx);
  registerSpatialIndex(ctx);
  if (osmEnabled) registerOsmAnalysis(ctx);
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: [...TOOL_NAMES, 'skill'] });
  });
  ctx.tools.guard(exec => {
    const id = exec.agent?.session?.id;
    const allowed = exec.name === 'skill'
      ? SKILL_NAMES.has(exec.arguments?.name)
      : TOOL_NAMES.includes(exec.name);
    if (!allowed || !id || !readBinding(String(id))) {
      return 'This tool is unavailable in this SatGPT session';
    }
  });
  let thumbnailRequested = false;
  mountControl(ctx, (owner, payload, signal, callId) => {
    if (payload.operation === 'layer_thumbnail') thumbnailRequested = true;
    return execute(owner, payload, signal, callId);
  });
  if (catalogDir) execute('catalog-startup', { operation: 'catalog', limit: 1 }).catch(() => {});
  const thumbnailWarmup = project ? setImmediate(() => {
    if (!thumbnailRequested) execute('thumbnail-startup', { operation: 'layer_thumbnail_warmup' }).catch(() => {});
  }) : null;
  ctx.on('dispose', () => {
    if (thumbnailWarmup) clearImmediate(thumbnailWarmup);
    return Promise.all([pool.close(), catalogReaders.close(), catalogRefreshers.close(), thumbnailWorkers.close()]);
  });
}

function registerSpatialIndex(ctx) {
  const output = { schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  ctx.tools.register({ name: 'geo_data_search',
    description: 'Find study areas, saved flood masks and OSM roads, buildings or POIs in this conversation. Search before reusing prior data. Only metadata and references are returned. Omit area_ref for a previous result when the viewport moved. Dates are half-open [start,end).',
    parameters: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['area', 'flood', 'roads', 'buildings', 'pois'] }, query: { type: 'string', maxLength: 160 },
      area_ref: DATA_REF, start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      limit: { type: 'integer', minimum: 1, maximum: 16 },
    } }, output,
    async execute(filters, exec) { return runWithContext({ operation: 'geo_search', filters }, exec); },
  });
  ctx.tools.register({ name: 'geo_data_info',
    description: 'Read the safe metadata, grid, bands and supported analysis tools of an indexed data reference.',
    parameters: { type: 'object', additionalProperties: false, properties: { data_ref: DATA_REF }, required: ['data_ref'] }, output,
    async execute({ data_ref }, exec) { return runWithContext({ operation: 'geo_info', data_ref }, exec); },
  });
}

function registerFloodTools(ctx) {
  const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
  ctx.tools.register({
    name: 'gee_publish_flood',
    description: 'Publish a flood map and reusable classification for the confirmed polygon. Return one band on the stated UTM grid using fixed scene IDs. Use 0 for observed dry, 1 for flood, 2 for excluded and masked pixels for unknown. Preserve dry zeros. This tool validates coverage and computes areas.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        name: text(100), code: CODE_PARAMETER, inputs: INPUTS, event: text(160), observed_at: text(120),
        source: text(120), dataset_id: text(160), method: text(500),
        scene_ids: { type: 'array', minItems: 1, maxItems: 16, items: text(240) },
        crs: { type: 'string', pattern: '^EPSG:32[67][0-9]{2}$' },
        scale: { type: 'integer', minimum: 5, maximum: 120 },
        minimum_coverage: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['name', 'code', 'event', 'observed_at', 'source', 'dataset_id', 'method', 'scene_ids', 'crs', 'scale'],
    },
    output: {
      schema: { type: 'object', properties: { flood_result: { type: 'object', additionalProperties: true } }, required: ['flood_result'], additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.flood_result) }],
      presentationMeta: (args, value) => ({ ...value.reference, layer: value.layer,
        ...(args.inputs && { indexed_inputs: args.inputs }), ...(value.thumbnail_ref && { thumbnail_ref: value.thumbnail_ref }),
        code: value.display_code, flood_result: value.flood_result }),
    },
    async execute({ name, code, inputs, ...settings }, exec) {
      return runWithContext({ operation: 'flood_publish', layer_code: code, inputs, flood_settings: settings,
        visualization: { name, min: 1, max: 1, palette: ['21a8ef'] }, defer_thumbnail: true,
        metadata: { source: settings.source, dataset_id: settings.dataset_id, observed_at: settings.observed_at,
          description: settings.method },
        legend: { type: 'categorical', labels: ['Newly inundated'] },
      }, exec);
    },
  });
  if (!osmEnabled) return;
  ctx.tools.register({
    name: ROAD_FLOOD_TOOL,
    description: 'Measure and map potential road flood exposure in metres using flood_data_ref and road_data_ref from the index. If roads are missing, call osm_roads with the flood_data_ref first. Both must cover the same study area. Legacy flood_ref with osm_ref also works.',
    parameters: { type: 'object', additionalProperties: false,
      properties: { flood_ref: { type: 'string', pattern: '^[a-f0-9]{32}$' },
        osm_ref: { type: 'string', pattern: '^[a-f0-9]{32}$' }, flood_data_ref: DATA_REF, road_data_ref: DATA_REF,
        show_on_map: { type: 'boolean' } },
    },
    output: {
      schema: { type: 'object', properties: { summary: { type: 'object', additionalProperties: true } }, required: ['summary'], additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.summary) }],
      presentationMeta: (_args, value) => value.layer ? { ...value.reference, layer: value.layer } : {},
    },
    async execute(args, exec) {
      const { flood_ref, osm_ref, flood_data_ref, road_data_ref } = args;
      if (!(flood_ref && osm_ref && !flood_data_ref && !road_data_ref)
          && !(flood_data_ref && road_data_ref && !flood_ref && !osm_ref)) {
        throw new Error('Provide both indexed references or both legacy references');
      }
      return runWithContext({ operation: ROAD_FLOOD_TOOL, ...args }, exec);
    },
  });
}

function registerOsmAnalysis(ctx) {
  ctx.tools.register({
    name: OSM_ANALYSIS_TOOL,
    description: 'Sample a raster at OSM POIs or calculate flood overlap per OSM building. ' +
      'Use osm_data_ref from geo_data_search to reuse indexed POIs or buildings, or osm_ref for an artifact_ref in this task. Supply the verified image recipe, ' +
      'raster source, observation dates and working grid. Building flood requires a band with 0 dry, 1 flooded, ' +
      'and masked unobserved pixels. Set hit_value to 1 for POI sampling of the same flood band.',
    parameters: {
      type: 'object',
      properties: {
        osm_ref: { type: 'string', pattern: '^[a-f0-9]{32}$' },
        osm_data_ref: DATA_REF,
        mode: { type: 'string', enum: ['point_sample', 'building_flood'] },
        code: CODE_PARAMETER,
        band: { type: 'string' },
        crs: { type: 'string' },
        scale: { type: 'number', exclusiveMinimum: 0, description: 'Nominal scale in metres. Supply scale or crs_transform.' },
        crs_transform: { type: 'array', items: { type: 'number' }, minItems: 6, maxItems: 6,
          description: 'Row-major affine transform [a,b,c,d,e,f] for the analysis grid.' },
        hit_value: { type: 'number', description: 'Optional pixel value to count and identify in point_sample mode.' },
        raster_source: { type: 'string', description: 'Verified raster dataset ID or reproducible source.' },
        observed_at: { type: 'string', description: 'Verified raster observation date or date range.' },
        show_on_map: { type: 'boolean', description: 'Display the annotated OSM features on the map.' },
      },
      required: ['mode', 'code', 'band', 'crs', 'raster_source', 'observed_at'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: {
        summary: { type: 'object', additionalProperties: true },
        layer: { type: 'object', additionalProperties: true },
        reference: { type: 'object', additionalProperties: true },
      }, required: ['summary'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.summary) }],
      presentationMeta: (_args, value) => value.layer ? { ...value.reference, layer: value.layer } : {},
    },
    async execute(args, exec) {
      if (Boolean(args.osm_ref) === Boolean(args.osm_data_ref)) throw new Error('Provide exactly one OSM reference');
      return runWithContext({ operation: 'osm_analysis', ...args }, exec);
    },
  });
}

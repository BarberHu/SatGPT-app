/** GEE tools for the SDK profile, adapted from cdllI/dsh-gee (MIT). */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool } from './worker-pool.js';
import { mountControl, readBinding } from './runtime-control.js';

export const name = 'webgis-gee-tools';
export const inject = ['agents', 'tools'];

const root = process.env.WEBGIS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const project = process.env.GEE_PROJECT_ID;
const pool = new WorkerPool({
  python: process.env.SATGPT_HARNESS_PYTHON || 'python',
  worker: path.join(root, 'app', 'gee_worker.py'),
  cwd: root,
}, Number(process.env.SATGPT_GEE_WORKERS || 16), Number(process.env.SATGPT_GEE_QUEUE_LIMIT || 128));
const timingLog = process.env.SATGPT_HARNESS_TIMING_LOG;
let timingWriteFailed = false;

const TOOL_NAMES = ['gee_check', 'gee_status', 'gee_catalog', 'gee_eval', 'gee_preview', 'gee_layer'];
const CODE_PARAMETER = {
  type: 'string',
  description: 'Restricted Python script. Write result = expression (e.g. result = {"count": collection.size()}). A bare final expression or dictionary does not return a value. Use preloaded ee and analysis_region. No import, print, or def.',
};
const PYTHON_RULES = 'ee and the exact task geometry analysis_region (ee.Geometry) / analysis_region_geojson are preloaded. Assign the output to result. No import, print, def, file access, or private attributes. For a simple .map() callback use an inline lambda. Run gee_check before executing complex code.';

function execute(owner, payload, signal) {
  const operation = payload.operation || 'layer';
  const taskId = payload.analysis_context?.task_id;
  const callId = timingLog ? randomUUID() : null;
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
  return pool.run(owner, { ...payload, project, catalog_dir: process.env.SATGPT_CATALOG_CACHE }, { signal,
    timeout: operation === 'catalog' ? 240000 : 150000, observe });
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
  const result = await execute(owner_id, { ...payload, artifact_dir,
    artifact_url: '/api/previews/' + conversation_id + '/' + task_id,
    analysis_context: { task_id, conversation_id, bounds, analysis_region, ...(analysis_aoi && { analysis_aoi }) },
  }, exec.signal);
  if (result.layer || result.preview) return { ...result, reference: { task_id, run_id } };
  return result;
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'gee_check',
    description: 'Fast local preflight for restricted GEE Python. Run before executing complex code in gee_eval, gee_preview, or gee_layer. If valid is false, fix the reported error and check again before execution. Checks syntax, allowed statements and builtins, and result assignment without an Earth Engine request.',
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
    description: 'Search the complete public Earth Engine STAC dataset catalog by id, title, keywords, and description. Use it to verify dataset IDs before analysis instead of guessing. First call builds a cache and may take 1-2 minutes.',
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
    description: `Evaluate read-only Earth Engine Python. ${PYTHON_RULES} Use analysis_region for filterBounds, clip and reduceRegion. Query image dates using lightweight collection metadata. Run any requested large-area pixel statistics separately at an appropriate scale. Use gee_layer for map layers.`,
    parameters: { type: 'object', properties: { code: CODE_PARAMETER }, required: ['code'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { result: {} }, required: ['result'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.result) }],
    },
    async execute(args, exec) {
      return runWithContext({ operation: 'eval', code: args.code }, exec);
    },
  });

  ctx.tools.register({
    name: 'gee_preview',
    description: `Render a PNG preview in the WebGIS conversation. ${PYTHON_RULES} The result must be an ee.Image. Use gee_layer for an interactive map.`,
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
    description: `Create an interactive Earth Engine layer and a static thumbnail. ${PYTHON_RULES} The result must be an ee.Image. Set bounds to the actual layer area [west,south,east,north]. Supply verified source, dataset_id, observed_at (observation date/range), unit and description in metadata. Palette/min/max generate the numeric legend. For consecutive integer classes only, provide legend.type=categorical and labels in palette order.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, code: CODE_PARAMETER,
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
      presentationMeta: (args, value) => ({ ...value.reference, layer: value.layer, code: args.code }),
    },
    async execute(args, exec) {
      const bounds = focusBounds(args.bounds);
      const visualization = { name: args.name };
      for (const key of ['bands', 'min', 'max', 'palette']) if (args[key] !== undefined) visualization[key] = args[key];
      const value = await runWithContext({ layer_code: args.code, visualization, bounds,
        metadata: args.metadata, legend: args.legend }, exec);
      if (bounds) value.layer.bounds = bounds;
      return value;
    },
  });
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: TOOL_NAMES });
  });
  ctx.tools.guard(exec => {
    const id = exec.agent?.session?.id;
    if (!TOOL_NAMES.includes(exec.name) || !id || !readBinding(String(id))) {
      return 'This tool is unavailable in this SatGPT session';
    }
  });
  mountControl(ctx, execute);
  ctx.on('dispose', () => pool.close());
}

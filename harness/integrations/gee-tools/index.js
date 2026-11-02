/** GEE tools for the SDK profile, adapted from cdllI/dsh-gee (MIT). */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerClient } from './worker-client.js';

export const name = 'webgis-gee-tools';
export const inject = ['tools'];

const root = process.env.WEBGIS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const eventFile = path.join(root, 'state', 'gee-tool-events.jsonl');
const project = process.env.GEE_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
const workerClient = new WorkerClient({
  python: process.env.SATGPT_HARNESS_PYTHON || 'python',
  worker: path.join(root, 'app', 'gee_worker.py'),
  cwd: root,
});
export function stopWorker() { workerClient.close(); }

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

function runWorker(payload, signal) {
  return workerClient.run({ ...payload, project }, {
    signal, timeout: payload.operation === 'catalog' ? 240000 : 150000,
  });
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'gee_check',
    description: 'Fast local preflight for this restricted GEE Python runner. Checks Python syntax, allowed statements/builtins, and result assignment without credentials or any Earth Engine request. Use when code is complex or a local error is suspected; ordinary short code can go directly to gee_eval, gee_preview, or gee_layer, which also preflight automatically. Warnings are advisory.',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: {
        valid: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      }, required: ['valid', 'errors', 'warnings'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) { return runWorker({ operation: 'check', code: args.code }, exec.signal); },
  });

  ctx.tools.register({
    name: 'gee_status',
    description: 'Check the configured service account, Cloud project, Earth Engine API, and a real server-side round trip. Use when a GEE tool fails or credentials appear unavailable.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) { return runWorker({ operation: 'status' }, exec.signal); },
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
      return runWorker({ operation: 'catalog', query: args.query || '', limit: args.limit || 20,
        type: args.type, refresh: Boolean(args.refresh) }, exec.signal);
    },
  });

  ctx.tools.register({
    name: 'gee_eval',
    description: 'Evaluate read-only Google Earth Engine Python code for catalog queries or statistics. ee is already available. Assign the final value to result. This restricted runner does not allow import, print, def/class/try, or underscore-prefixed attributes; use result to return data. Do not use this tool for a map layer.',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { result: {} }, required: ['result'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.result) }],
    },
    async execute(args, exec) {
      return runWorker({ operation: 'eval', code: args.code }, exec.signal);
    },
  });

  ctx.tools.register({
    name: 'gee_preview',
    description: 'Render an ee.Image as a PNG preview and show it in the WebGIS conversation. ee is already available; assign an ee.Image to result. The restricted runner does not allow import, print, def/class/try, or underscore-prefixed attributes. Use gee_layer for an interactive map.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string' }, name: { type: 'string' },
        bands: { type: 'array', items: { type: 'string' } },
        min: { type: 'number' }, max: { type: 'number' },
        palette: { type: 'array', items: { type: 'string' } },
        region: { type: 'array', items: { type: 'number' }, description: '[west, south, east, north]' },
        dimensions: { type: 'integer', description: 'Longest side 64-1024 pixels.' },
      },
      required: ['code'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { preview: { type: 'object', additionalProperties: true } }, required: ['preview'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: `Preview ${value.preview.width}x${value.preview.height} PNG saved and shown in WebGIS.` }],
    },
    async execute(args, exec) {
      const visualization = {};
      for (const key of ['bands', 'min', 'max', 'palette']) if (args[key] !== undefined) visualization[key] = args[key];
      const value = await runWorker({ operation: 'preview', code: args.code, name: args.name,
        visualization, region: args.region, dimensions: args.dimensions }, exec.signal);
      await fs.appendFile(eventFile, JSON.stringify({ preview: value.preview, code: args.code, created_at: Date.now() }) + '\n');
      return value;
    },
  });

  ctx.tools.register({
    name: 'gee_layer',
    description: 'Create an interactive Earth Engine raster map layer from read-only Python code. ee is available; assign an ee.Image to result. Set bounds to the actual layer area [west,south,east,north], especially when it differs from the current map view or the code has no literal ee.Geometry.Rectangle. The runner disallows imports, file access, definitions, and private attributes.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, code: { type: 'string' },
        bounds: { type: 'array', items: { type: 'number' }, description: '[west, south, east, north] of the layer area' },
        bands: { type: 'array', items: { type: 'string' } },
        min: { type: 'number' }, max: { type: 'number' },
        palette: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'code'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { layer: { type: 'object', additionalProperties: true } }, required: ['layer'], additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `Map layer ${value.layer.name} created and sent to WebGIS.` }],
    },
    async execute(args, exec) {
      const bounds = focusBounds(args.bounds);
      const visualization = { name: args.name };
      for (const key of ['bands', 'min', 'max', 'palette']) if (args[key] !== undefined) visualization[key] = args[key];
      const value = await runWorker({ layer_code: args.code, visualization }, exec.signal);
      if (bounds) value.layer.bounds = bounds;
      await fs.appendFile(eventFile, JSON.stringify({ layer: value.layer, code: args.code,
        created_at: Date.now() }) + '\n');
      return value;
    },
  });
}

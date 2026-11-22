import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'satgpt-geocoding-tools';
export const inject = ['tools'];

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.WEBGIS_ROOT || path.resolve(directory, '..', '..');
const sharedDir = path.basename(directory) === name ? '../webgis-gee-tools/' : '../gee-tools/';
const { GEOCODE_TOOL_NAME, readBinding } = await import(new URL(sharedDir + 'runtime-control.js', import.meta.url));
const { WorkerPool } = await import(new URL(sharedDir + 'worker-pool.js', import.meta.url));

export function registerTools(ctx, pool, bindingFor = readBinding, publicEndpoint = false) {
  ctx.tools.register({
    name: GEOCODE_TOOL_NAME,
    description: 'Find candidate locations for a named place without changing the task area. Use the returned administrative context to disambiguate. The WGS84 position [longitude, latitude] and optional bounds [west, south, east, north] support orientation, not exact boundary analysis.'
      + (publicEndpoint ? ' Use public Nominatim only for a lookup explicitly requested by the user. Send only publicly known place names, omitting private addresses and confidential information. Do not use this tool for autocomplete, bulk or systematic lookups, or automatic retries.' : ''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'A place name with any known administrative qualifier.' },
        country_code: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'Optional ISO 3166-1 alpha-2 country filter.' },
        language: { type: 'string', pattern: '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$', maxLength: 35,
          description: 'Preferred language, such as zh-CN or en.' },
        limit: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'no_match', 'invalid_query', 'upstream_error', 'upstream_timeout', 'rate_limited'] },
          attribution: { type: 'string' },
          candidates: { type: 'array', items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              type: { type: 'string' },
              administrative: { type: 'object', additionalProperties: true },
              position: { type: 'array', items: { type: 'number' } },
              bounds: { type: 'array', items: { type: 'number' } },
              osm_ref: { type: 'string' },
            },
            required: ['label', 'type', 'position'],
            additionalProperties: false,
          } },
          message: { type: 'string' },
        },
        required: ['status', 'attribution', 'candidates'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute({ query, country_code, language, limit }, exec) {
      const id = exec.agent?.session?.id;
      const binding = id && bindingFor(String(id));
      if (!binding) throw new Error('Geocoding requires an active SatGPT task.');
      const result = await pool.run(binding.owner_id, { query, country_code, language, limit },
        { signal: exec.signal, timeout: 12_000 });
      if (exec.signal?.aborted) throw new Error('Tool call cancelled');
      return result;
    },
  });
}

export function apply(ctx) {
  const endpoint = process.env.SATGPT_GEOCODING_URL?.trim();
  if (!endpoint) return;
  const publicEndpoint = new URL(endpoint).hostname.replace(/\.+$/, '') === 'nominatim.openstreetmap.org';
  const pool = new WorkerPool({
    python: process.env.SATGPT_HARNESS_PYTHON || 'python',
    worker: path.join(root, 'app', 'geocoding_worker.py'),
    cwd: root, service: 'Geocoding', endpoint,
    geocodingLockFile: process.env.SATGPT_GEOCODING_LOCK_FILE,
  }, 1, 12);
  registerTools(ctx, pool, readBinding, publicEndpoint);
  ctx.on('dispose', () => pool.close());
}

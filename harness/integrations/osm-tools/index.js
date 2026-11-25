import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'satgpt-osm-tools';
export const inject = ['tools'];

const root = process.env.WEBGIS_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const sharedDir = new URL('.', import.meta.url).pathname.endsWith('/satgpt-osm-tools/')
  ? '../webgis-gee-tools/' : '../gee-tools/';
const shared = file => new URL(sharedDir + file, import.meta.url).href;
const { OSM_TOOL_NAMES, readBinding, floodResultFor } = await import(shared('runtime-control.js'));
const { WorkerPool } = await import(shared('worker-pool.js'));
const DEFAULT_QUERY_TIMEOUT_MS = 90_000;

const summaryFields = ['status', 'count', 'by_category', 'source', 'source_mode', 'fallback_reason', 'source_version',
  'osm_data_time', 'osm_data_time_range', 'partition_count', 'attribution', 'license_url', 'skipped_geometry',
  'snapshot_skipped_geometry', 'data_ref'];

const definitions = [
  { name: OSM_TOOL_NAMES[0], kind: 'roads', renderAs: 'line', title: 'OSM roads',
    description: 'Find major or local OpenStreetMap road ways', categories: ['major', 'local'] },
  { name: OSM_TOOL_NAMES[1], kind: 'pois', renderAs: 'circle', title: 'OSM points of interest',
    description: 'Find OpenStreetMap points of interest in one supported category',
    categories: ['hospital', 'clinic', 'pharmacy', 'school', 'university', 'police', 'fire_station', 'shelter', 'supermarket'] },
  { name: OSM_TOOL_NAMES[2], kind: 'buildings', renderAs: 'fill', title: 'OSM buildings',
    description: 'Find OpenStreetMap building footprints' },
];

export function registerTools(ctx, pool, bindingFor = readBinding) {
  for (const { name, kind, renderAs, title, description, categories } of definitions) {
    ctx.tools.register({
      name,
      description: description + ' within the current task map area. Set show_on_map when the user asks for a map.'
        + (kind === 'roads' ? ' Pass flood_data_ref from geo_data_search to query the original flood area and return indexed roads. flood_ref is a legacy option.' : ''),
      parameters: {
        type: 'object',
        properties: {
          ...(categories && { category: { type: 'string', enum: categories } }),
          ...(kind === 'roads' && { flood_ref: { type: 'string', pattern: '^[a-f0-9]{32}$' },
            flood_data_ref: { type: 'string', pattern: '^g_[a-f0-9]{32}$' } }),
          show_on_map: { type: 'boolean', description: 'Show the resulting layer when the task completes.' },
        },
        ...(kind === 'pois' && { required: ['category'] }),
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
        const id = exec.agent?.session?.id;
        const binding = id && bindingFor(String(id));
        if (!binding) throw new Error('OSM tools require an active SatGPT task.');
        const { owner_id, task_id, run_id, analysis_region, bounds, artifact_dir } = binding;
        const floodRef = kind === 'roads' ? args.flood_ref : undefined;
        const indexedFlood = kind === 'roads' ? args.flood_data_ref : undefined;
        if (indexedFlood && floodRef) throw new Error('Provide one flood reference');
        const flood = floodRef === undefined ? null : floodResultFor(binding, floodRef);
        const category = args.category ?? (kind === 'roads' ? 'major' : null);
        const value = await pool.run(owner_id, { kind, category, artifact_dir,
          analysis_region: flood?.analysis_region ?? analysis_region, bounds: flood?.bounds ?? bounds,
          ...(binding.geo_context && { geo_context: binding.geo_context, analysis_aoi: binding.analysis_aoi }),
          ...(indexedFlood && { flood_data_ref: indexedFlood }),
          ...(flood && { flood_ref: floodRef, selected_region: analysis_region }) },
          { signal: exec.signal, timeout: kind === 'buildings' ? 90_000 : DEFAULT_QUERY_TIMEOUT_MS });
        if (exec.signal?.aborted) throw new Error('Tool call cancelled');
        if (value.error) return { summary: { status: value.error.code, message: value.error.message } };
        const summary = Object.fromEntries(summaryFields.filter(key => Object.hasOwn(value.summary, key))
          .map(key => [key, value.summary[key]]));
        if (!value.artifact_ref) return { summary };
        const visible = args.show_on_map === true;
        return {
          summary: { ...summary, artifact_ref: value.artifact_ref,
            map_layer: visible ? 'show_on_completion' : 'available' },
          layer: { kind: 'geojson', renderAs, name: category ? title + ' · ' + category.replaceAll('_', ' ') : title,
            artifact_ref: value.artifact_ref, bounds: value.bounds ?? flood?.bounds ?? bounds, visible,
            metadata: { source: [value.summary.source, value.summary.attribution].filter(Boolean).join(' · '), observed_at: value.summary.osm_data_time,
              description: `${value.summary.count} OSM objects in the task area.` } },
          reference: { task_id, run_id },
        };
      },
    });
  }
}

export function apply(ctx) {
  if (process.env.SATGPT_OSM_TOOLS !== '1') return;
  const endpoint = process.env.SATGPT_OVERPASS_URL || '';
  const osmSnapshotDir = process.env.SATGPT_OSM_SNAPSHOT_DIR;
  const roadSnapshot = process.env.SATGPT_ROAD_SNAPSHOT;
  if (!endpoint && !osmSnapshotDir && !roadSnapshot) throw new Error('SatGPT OSM tools require a configured data source.');
  const pool = new WorkerPool({
    python: process.env.SATGPT_HARNESS_PYTHON || 'python',
    worker: path.join(root, 'app', 'osm_worker.py'),
    cwd: root, service: 'OSM', endpoint, osmSnapshotDir, roadSnapshot,
  }, 1, 12);
  registerTools(ctx, pool);
  ctx.on('dispose', () => pool.close());
}

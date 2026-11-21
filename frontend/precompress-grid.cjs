const { createHash } = require('node:crypto');
const { readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');

const grid = path.join(__dirname, 'build/assets/data/HFMT_Fishnet_3_FeaturesToJSO.geojson');
const destination = `${grid}.gz`;
const temporaryGrid = `${grid}.${process.pid}.tmp`;
const temporary = `${destination}.${process.pid}.tmp`;
const metadata = `${grid}.etag.json`;
const temporaryMetadata = `${metadata}.${process.pid}.tmp`;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

try {
  const original = readFileSync(grid);
  const collection = JSON.parse(original);
  // The click handler uses FID to recover the full, untiled geometry.
  const compact = Buffer.from(JSON.stringify({
    ...collection,
    features: collection.features.map(({ type, geometry, properties }) => ({
      type,
      properties: { FID: properties.FID },
      geometry,
    })),
  }));
  const compressed = gzipSync(compact, { level: 6 });
  writeFileSync(temporaryGrid, compact);
  writeFileSync(temporary, compressed);
  writeFileSync(temporaryMetadata, JSON.stringify({ identity: sha256(compact), gzip: sha256(compressed) }));
  rmSync(metadata, { force: true });
  rmSync(destination, { force: true });
  renameSync(temporaryGrid, grid);
  renameSync(temporary, destination);
  renameSync(temporaryMetadata, metadata);
  console.log(`Map grid: ${original.length} bytes → ${compact.length} bytes (${compressed.length} bytes gzip).`);
} catch (error) {
  console.error(`Could not precompress the map grid: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temporaryGrid, { force: true });
  rmSync(temporary, { force: true });
  rmSync(temporaryMetadata, { force: true });
}

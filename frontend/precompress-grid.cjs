const { createHash } = require('node:crypto');
const { readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');

const grid = path.join(__dirname, 'build/assets/data/HFMT_Fishnet_3_FeaturesToJSO.geojson');
const destination = `${grid}.gz`;
const temporary = `${destination}.${process.pid}.tmp`;
const metadata = `${grid}.etag.json`;
const temporaryMetadata = `${metadata}.${process.pid}.tmp`;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

try {
  rmSync(metadata, { force: true });
  const original = readFileSync(grid);
  const compressed = gzipSync(original, { level: 6 });
  writeFileSync(temporary, compressed);
  writeFileSync(temporaryMetadata, JSON.stringify({ identity: sha256(original), gzip: sha256(compressed) }));
  renameSync(temporary, destination);
  renameSync(temporaryMetadata, metadata);
  console.log(`Precompressed map grid: ${original.length} bytes to ${compressed.length} bytes.`);
} catch (error) {
  console.error(`Could not precompress the map grid: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { force: true });
  rmSync(temporaryMetadata, { force: true });
}

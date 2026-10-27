import { createRequire } from 'node:module';

const require = createRequire(process.execPath);
let standalone = false;
let embeddedAssets = new Map();

try {
  const sea = require('node:sea');
  standalone = sea.isSea();
  if (standalone) {
    const encoded = JSON.parse(sea.getAsset('public-assets', 'utf8'));
    embeddedAssets = new Map(
      Object.entries(encoded).map(([path, base64]) => [path, Buffer.from(base64, 'base64')]),
    );
  }
} catch {
  // Source mode does not expose node:sea on every supported Node.js version.
}

export function isStandalone() {
  return standalone;
}

export function getEmbeddedAsset(path) {
  return embeddedAssets.get(path) || null;
}
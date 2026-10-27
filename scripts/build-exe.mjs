import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const ROOT = resolve(process.cwd());
const DIST = resolve(ROOT, 'dist');
const RELEASE = resolve(ROOT, 'release');
const PUBLIC_DIR = resolve(ROOT, 'public');
const SERVER_ENTRY = resolve(ROOT, 'server.mjs');
const BUNDLED_SERVER = resolve(DIST, 'server.cjs');
const SEA_CONFIG = resolve(DIST, 'sea-config.json');
const SEA_BLOB = resolve(DIST, 'sea-prep.blob');
const OUTPUT_EXE = resolve(RELEASE, 'DeepSeek-Search-Console.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function assertWorkspacePath(target) {
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    throw new Error(`Refusing to modify a path outside the workspace: ${target}`);
  }
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

assertWorkspacePath(DIST);
assertWorkspacePath(RELEASE);
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
mkdirSync(RELEASE, { recursive: true });

const manifest = {};
for (const file of walk(PUBLIC_DIR).sort()) {
  const key = relative(PUBLIC_DIR, file).replaceAll('\\', '/');
  manifest[key] = readFileSync(file).toString('base64');
}
const manifestPath = resolve(DIST, 'public-assets.json');
writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

await build({
  entryPoints: [SERVER_ENTRY],
  outfile: BUNDLED_SERVER,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
});

writeFileSync(SEA_CONFIG, JSON.stringify({
  main: BUNDLED_SERVER,
  output: SEA_BLOB,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
  assets: {
    'public-assets': manifestPath,
  },
}, null, 2));

execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { stdio: 'inherit' });
rmSync(OUTPUT_EXE, { force: true });
copyFileSync(process.execPath, OUTPUT_EXE);

const postjectCli = resolve(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
if (!existsSync(postjectCli)) throw new Error('postject is not installed. Run npm ci first.');

execFileSync(process.execPath, [
  postjectCli,
  OUTPUT_EXE,
  'NODE_SEA_BLOB',
  SEA_BLOB,
  '--sentinel-fuse',
  FUSE,
], { stdio: 'inherit' });

const sizeMb = (statSync(OUTPUT_EXE).size / 1024 / 1024).toFixed(1);
console.log(`Built ${OUTPUT_EXE} (${sizeMb} MB)`);
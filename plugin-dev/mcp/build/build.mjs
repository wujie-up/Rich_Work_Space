import { build } from 'esbuild';
import { mkdir, readFile, copyFile, cp, rm } from 'node:fs/promises';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { packPackage } from '../../../desk/src/main/common/plugin-package.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
// Version HTML, scripts and styles together so upgrades cannot reuse the previous list UI.
const output = dirname(join(root, manifest.views[0].entry));
await rm(join(root, 'dist/renderer'), { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({ entryPoints: [join(root, manifest.renderer)], bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome145', outfile: join(output, 'app.js'), minify: true });
await copyFile(join(root, 'src/resource/index.html'), join(output, 'index.html'));
// Ship the pinned browser runtime inside the plugin; production hosts do not include development dependencies.
const browserRuntime = dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
await rm(join(root, 'dist/browser'), { recursive: true, force: true });
await cp(browserRuntime, join(root, 'dist/browser'), { recursive: true });
const staging = resolve(root, '../dist/.staging-mcp');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const name of ['plugin.json', 'src', 'dist', 'ico']) {
  await cp(join(root, name), join(staging, name), { recursive: true, filter: path => basename(path) !== '.DS_Store' });
}
const target = resolve(root, '../dist', `${manifest.id}-${manifest.version}.plg`);
await packPackage(staging, target);
console.log(`Packaged: ${target}`);

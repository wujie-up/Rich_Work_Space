import { build } from 'esbuild';
import { mkdir, cp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import { packPackage } from '../../../desk/src/main/common/plugin-package.js';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
execFileSync(process.execPath, [join(root, 'assistants/build/package-mac.mjs')], { stdio: 'inherit' });
await mkdir(join(root, 'dist/renderer'), { recursive: true });
await build({ entryPoints: [join(root, 'src/renderer/app.js')], bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome145', outfile: join(root, 'dist/renderer/app.js') });
await cp(join(root, 'src/resource/index.html'), join(root, 'dist/renderer/index.html'));
const staging = join(root, '../dist/.staging-web-access');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
// Explicit inventory excludes development tools, Apple build caches, tests and all user data.
for (const name of ['plugin.json', 'package.json', 'README.md', 'ico', 'src/main', 'dist/renderer', 'dist/assistant', 'node_modules/@number0']) {
  await cp(join(root, name), join(staging, name), { recursive: true, filter: path => basename(path) !== '.DS_Store' });
}
await packPackage(staging, join(root, '../dist', `${manifest.id}-${manifest.version}.plg`));
console.log(`Packaged web-access ${manifest.version}`);

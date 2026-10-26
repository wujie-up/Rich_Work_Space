import { build } from 'esbuild';
import { mkdir, copyFile, cp, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPackage } from '../../../desk/src/main/common/plugin-package.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'dist/renderer');
await mkdir(join(root, 'dist/main'), { recursive: true });
await build({ entryPoints: [join(root, 'src/main/common/capture/proxy.js')], outfile: join(root, 'dist/main/capture-proxy.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['bufferutil', 'utf-8-validate'] });
await mkdir(out, { recursive: true });
for (const [entry, resource, output] of [['app.js', 'index.html', 'app.js'], ['conversation.js', 'conversation.html', 'conversation.js'], ['settings.js', 'settings.html', 'settings.js']]) {
  await build({ entryPoints: [join(root, 'src/renderer', entry)], outfile: join(out, output), bundle: true,
    format: 'esm', platform: 'browser', target: 'chrome145' });
  await copyFile(join(root, 'src/resource', resource), join(out, resource));
}
// Stage runtime files only; Finder metadata is removed by macOS packaging and cannot enter the hash inventory.
const staging = await mkdtemp(join(tmpdir(), 'work-desk-ai-package-'));
try {
  for (const name of ['plugin.json', 'package.json', 'src', 'dist', 'ico', 'title.md']) {
    await cp(join(root, name), join(staging, name), { recursive: true, filter: path => basename(path) !== '.DS_Store' });
  }
  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  await packPackage(staging, fileURLToPath(new URL(`../../../plugin-dev/dist/${manifest.id}-${manifest.version}.plg`, import.meta.url)));
} finally {
  await rm(staging, { recursive: true, force: true });
}

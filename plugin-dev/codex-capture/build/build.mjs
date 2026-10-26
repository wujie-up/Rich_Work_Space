import { build } from 'esbuild';
import { mkdir, copyFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { packPackage } from '../../../desk/src/main/common/plugin-package.js';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, 'dist/renderer'), { recursive: true });
await mkdir(join(root, 'dist/main'), { recursive: true });
await build({ entryPoints: [join(root, 'src/renderer/app.js')], outfile: join(root, 'dist/renderer/app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome145' });
await copyFile(join(root, 'src/resource/index.html'), join(root, 'dist/renderer/index.html'));
await build({ entryPoints: [join(root, 'src/main/common/index.js')], outfile: join(root, 'dist/main/index.cjs'),
  bundle: true, format: 'cjs', platform: 'node', target: 'node22', external: ['bufferutil', 'utf-8-validate'] });
const staging = await mkdtemp(join(tmpdir(), 'codex-capture-package-'));
try {
  for (const name of ['plugin.json', 'package.json', 'dist', 'ico', 'README.md']) {
    await cp(join(root, name), join(staging, name), { recursive: true });
  }
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(join(staging, 'plugin.json'), 'utf8'));
  manifest.main = 'dist/main/index.cjs';
  await writeFile(join(staging, 'plugin.json'), JSON.stringify(manifest, null, 2));
  await packPackage(staging, join(root, '../dist', `${manifest.id}-${manifest.version}.plg`));
} finally {
  await rm(staging, { recursive: true, force: true });
}

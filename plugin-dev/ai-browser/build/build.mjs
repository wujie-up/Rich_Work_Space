import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { packPackage } from '../../../desk/src/main/common/plugin-package.js';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, 'dist/renderer'), { recursive: true });
await build({ entryPoints: [join(root, 'src/renderer/app.js')], outfile: join(root, 'dist/renderer/app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome145' });
const html = await readFile(join(root, 'src/resource/index.html'), 'utf8');
await writeFile(join(root, 'dist/renderer/index.html'), html);
await writeFile(join(root, 'dist/renderer/settings.html'), html.replace('<body>', '<body data-page="settings">'));
await build({ entryPoints: [join(root, 'src/main/common/index.js')], outfile: join(root, 'dist/main/index.js'),
  bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['playwright-core'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
const staging = join(root, 'dist/package');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const name of ['plugin.json', 'package.json', 'README.md', 'ico']) {
  await cp(join(root, name), join(staging, name), { recursive: true });
}
for (const name of ['main', 'renderer']) {
  await cp(join(root, 'dist', name), join(staging, 'dist', name), { recursive: true });
}
// Ship the pinned control runtime; browser binaries live in plugin data and are installed explicitly.
const runtime = dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
await cp(runtime, join(staging, 'node_modules/playwright-core'), { recursive: true });
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
await packPackage(staging, join(root, '../dist', `${manifest.id}-${manifest.version}.plg`));

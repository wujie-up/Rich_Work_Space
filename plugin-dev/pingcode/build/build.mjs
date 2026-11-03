import { build } from 'esbuild';
import { mkdir, copyFile, cp, rm, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPackage } from '../../../desk/src/main/common/plugin-package.js';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, 'dist/renderer'), { recursive: true });
await mkdir(join(root, 'dist/main'), { recursive: true });
for (const entry of ['app', 'settings']) {
  await build({ entryPoints: [join(root, `src/renderer/${entry}.js`)], outfile: join(root, `dist/renderer/${entry}.js`),
    bundle: true, format: 'esm', platform: 'browser', target: 'chrome145' });
}
for (const entry of ['index', 'settings']) {
  await copyFile(join(root, `src/resource/${entry}.html`), join(root, `dist/renderer/${entry}.html`));
}
await build({ entryPoints: [join(root, 'src/main/common/index.js')], outfile: join(root, 'dist/main/index.js'),
  bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['playwright-core', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
const extension = join(root, 'dist/pingcode-browser-extension');
await rm(extension, { recursive: true, force: true });
await mkdir(extension, { recursive: true });
for (const name of ['manifest.json', 'popup.html', 'pair.html']) {
  await copyFile(join(root, 'src/browser-extension', name), join(extension, name));
}
await copyFile(join(root, 'ico/icon.svg'), join(extension, 'icon.svg'));
for (const entry of ['worker', 'content', 'popup', 'pair']) {
  await build({ entryPoints: [join(root, `src/browser-extension/${entry}.js`)], outfile: join(extension, `${entry}.js`),
    bundle: true, format: entry === 'content' ? 'iife' : 'esm', platform: 'browser', target: 'chrome116' });
}
await build({ entryPoints: [join(root, 'src/browser-extension/popup.css')], outfile: join(extension, 'popup.css'), bundle: true });
const staging = join(root, 'dist/package');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const name of ['plugin.json', 'package.json', 'ico', 'README.md']) {
  await cp(join(root, name), join(staging, name), { recursive: true });
}
for (const name of ['renderer', 'main']) {
  await cp(join(root, 'dist', name), join(staging, 'dist', name), { recursive: true });
}
await cp(extension, join(staging, 'browser-extension'), { recursive: true });
// This is a runtime browser-control dependency, copied into the independent distribution package.
await cp(join(root, '../../node_modules/playwright-core'), join(staging, 'node_modules/playwright-core'), { recursive: true });
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
const extensionRelease = join(root, '../dist', `pingcode-browser-extension-${manifest.version}`);
await rm(extensionRelease, { recursive: true, force: true });
await cp(extension, extensionRelease, { recursive: true });
// System zip is a build-time tool only; the companion extension has no runtime native installer.
const zipTarget = join(root, '../dist', `pingcode-browser-extension-${manifest.version}.zip`);
await rm(zipTarget, { force: true });
const zipped = spawnSync('zip', ['-q', '-r', zipTarget, ...await readdir(extension)], { cwd: extension });
if (zipped.error || zipped.status !== 0) {
  throw Error('无法生成浏览器扩展压缩包，请确认构建环境提供 zip 命令');
}
await packPackage(staging, join(root, '../dist', `${manifest.id}-${manifest.version}.plg`));

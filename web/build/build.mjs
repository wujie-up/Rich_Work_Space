import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
export async function buildWeb() {
  await mkdir(join(root, 'web/dist'), { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ['web/src/browser/plugin-input.js'], bundle: true,
    outfile: 'web/dist/plugin-input.js', format: 'esm', platform: 'browser', target: 'chrome145' });
  const inputFiles = Object.fromEntries(await Promise.all(['plugin-input.js', 'plugin-input.css'].map(async name =>
    [name, createHash('sha256').update(await readFile(join(root, 'web/dist', name))).digest('hex')])));
  await writeFile(join(root, 'web/dist/plugin-input-manifest.json'), JSON.stringify({
    version: createHash('sha256').update(JSON.stringify(inputFiles)).digest('hex'), files: inputFiles
  }));
  await build({ absWorkingDir: root, entryPoints: ['web/src/browser/app.js'], bundle: true, outfile: 'web/dist/app.js', format: 'esm',
    platform: 'browser', target: 'chrome145', sourcemap: false });
  const html = (await readFile(join(root, 'desk/src/resource/index.html'), 'utf8'))
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '')
    .replace('width=device-width,initial-scale=1', 'width=device-width,initial-scale=1,viewport-fit=cover');
  await writeFile(join(root, 'web/dist/index.html'), html);
  const files = Object.fromEntries(await Promise.all(['app.js', 'app.css'].map(async name =>
    [name, createHash('sha256').update(await readFile(join(root, 'web/dist', name))).digest('hex')])));
  await writeFile(join(root, 'web/dist/shell-manifest.json'), JSON.stringify({
    version: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files
  }));
}

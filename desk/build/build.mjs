import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

async function bundle(entry, resource, output) {
  await mkdir(output, { recursive: true });
  await build({ entryPoints: [entry], bundle: true, outfile: join(output, 'app.js'), format: 'esm', platform: 'browser',
    target: 'chrome145', sourcemap: false, minify: false });
  await copyFile(resource, join(output, 'index.html'));
}

await bundle('desk/src/renderer/app.js', 'desk/src/resource/index.html', 'desk/dist/renderer');
// Discover domain packages instead of importing a particular plugin into the host bundle.
const packages = process.argv.includes('--desk-only') ? [] : await readdir('plugins/plugins', { withFileTypes: true });
for (const entry of packages) {
  const directory = join('plugins/plugins', entry.name);
  const manifestPath = join(directory, 'plugin.json');
  if (!entry.isDirectory() || !await access(manifestPath).then(() => true, () => false)) {
    continue;
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.renderer) {
    await bundle(join(directory, manifest.renderer), join(directory, 'src/resource/index.html'), join(directory, 'dist/renderer'));
  }
}

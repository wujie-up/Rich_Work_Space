import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile, access, cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { packPackage, withPackageSource } from '../src/main/common/plugin-package.js';

async function bundle(entry, resource, output) {
  await mkdir(output, { recursive: true });
  await build({ entryPoints: [entry], bundle: true, outfile: join(output, 'app.js'), format: 'esm', platform: 'browser',
    target: 'chrome145', sourcemap: false, minify: false });
  await copyFile(resource, join(output, 'index.html'));
}

await bundle('desk/src/renderer/app.js', 'desk/src/resource/index.html', 'desk/dist/renderer');
// Discover domain packages instead of importing a particular plugin into the host bundle.
const packages = process.argv.includes('--desk-only') ? [] : await readdir('plugin-dev', { withFileTypes: true });
for (const entry of packages) {
  const directory = join('plugin-dev', entry.name);
  const manifestPath = join(directory, 'plugin.json');
  if (!entry.isDirectory() || !await access(manifestPath).then(() => true, () => false)) {
    continue;
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const customBuild = join(directory, 'build/build.mjs');
  const custom = await access(customBuild).then(() => true, () => false);
  if (custom) {
    execFileSync(process.execPath, [customBuild], { stdio: 'inherit' });
  } else if (manifest.renderer) {
    await bundle(join(directory, manifest.renderer), join(directory, 'src/resource/index.html'), join(directory, 'dist/renderer'));
  }
  // Built-in distribution assets are staged separately from development sources and user installations.
  const target = join('desk/dist/plugins', entry.name);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const archive = join('plugin-dev/dist', `${manifest.id}-${manifest.version}.plg`);
  if (custom) {
    await withPackageSource(archive, source => cp(source, target, { recursive: true }));
    continue;
  }
  for (const name of ['plugin.json', 'package.json', 'src', 'dist', 'ico', 'title.md', 'README.md']) {
    const source = join(directory, name);
    if (await access(source).then(() => true, () => false)) {
      // Finder metadata is excluded by electron-builder and must not enter the payload hash inventory.
      await cp(source, join(target, name), { recursive: true, filter: path => basename(path) !== '.DS_Store' });
    }
  }
  await packPackage(target, archive);
  await withPackageSource(archive, source => cp(source, target, { recursive: true }));
}

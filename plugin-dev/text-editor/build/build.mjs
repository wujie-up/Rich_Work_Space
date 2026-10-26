import { build } from 'esbuild';
import { mkdir, copyFile, cp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { packPackage } from '../../../desk/src/main/common/plugin-package.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/renderer');
await mkdir(output, { recursive: true });
await build({ entryPoints: [join(root, 'src/renderer/app.js')], bundle: true, format: 'esm', platform: 'browser',
  target: 'chrome145', outfile: join(output, 'app.js'), minify: true });
await build({ stdin: { contents: "export { default } from 'mermaid';", resolveDir: root },
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome145', outfile: join(output, 'mermaid.js'), minify: true });
await copyFile(join(root, 'src/resource/index.html'), join(output, 'index.html'));
await mkdir(join(output, 'plantuml'), { recursive: true });
for (const name of ['plantuml', 'viz-global', 'themes', 'openiconic', 'emoji']) {
  await copyFile(join(root, 'node_modules/@plantuml/core', `${name}.js`), join(output, 'plantuml', `${name}.js`));
}
const staging = resolve(root, '../../plugin-dev/dist/.staging-text-editor');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await copyFile(join(root, 'plugin.json'), join(staging, 'plugin.json'));
await cp(join(root, 'ico'), join(staging, 'ico'), { recursive: true });
await cp(join(root, 'src/main'), join(staging, 'src/main'), { recursive: true });
await cp(join(root, 'dist'), join(staging, 'dist'), { recursive: true });
await copyFile(join(root, 'README.md'), join(staging, 'README.md'));
// Include licenses for every resolved package, including transitive browser dependencies.
const licenses = join(staging, 'licenses');
await mkdir(licenses, { recursive: true });
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) { await collect(path, `${entry.name}-`); continue; }
    for (const file of await readdir(path)) {
      if (/^(licen[sc]e|copying|notice)(\.|$)/i.test(file)) {
        await copyFile(join(path, file), join(licenses, `${prefix}${entry.name}-${file}`));
      }
    }
  }
}
await collect(join(root, 'node_modules'));
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
await writeFile(join(staging, 'THIRD-PARTY.json'), JSON.stringify(JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages, null, 2));
const target = resolve(root, '../../plugin-dev/dist', `${manifest.id}-${manifest.version}.plg`);
await packPackage(staging, target);
console.log(`Packaged: ${target}`);

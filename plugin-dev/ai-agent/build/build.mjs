import { build } from 'esbuild';
import { mkdir, copyFile, cp, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPackage } from '../../../desk/src/main/common/plugin-package.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
const out = join(root, 'dist/renderer');
await mkdir(join(root, 'dist/main'), { recursive: true });
await build({ entryPoints: [join(root, 'src/main/common/capture/proxy.js')], outfile: join(root, 'dist/main/capture-proxy.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['bufferutil', 'utf-8-validate'] });
await build({ entryPoints: [join(root, 'src/main/common/claude-session-delete.js')],
  outfile: join(root, 'dist/main/claude-session-delete.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' });
await copyFile(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/README.md'), join(root, 'dist/main/claude-sdk-license.md'));
await mkdir(out, { recursive: true });
for (const [source, name] of [['marked/LICENSE.md', 'marked-license.md'], ['dompurify/LICENSE', 'dompurify-license.txt'],
  ['dompurify/LICENSE-MPL', 'dompurify-license-mpl.txt']]) {
  await copyFile(join(root, 'node_modules', source), join(out, name));
}
for (const [entry, resource, output] of [['app.js', 'index.html', 'app.js'], ['conversation.js', 'conversation.html', 'conversation.js'], ['settings-page.js', 'settings.html', 'settings.js']]) {
  await build({ entryPoints: [join(root, 'src/renderer', entry)], outfile: join(out, output), bundle: true,
    format: 'esm', platform: 'browser', target: 'chrome145', loader: { '.html': 'text' } });
  // Stable plugin origins can retain old modules across upgrades; each release needs distinct asset URLs.
  const html = await readFile(join(root, 'src/resource', resource), 'utf8');
  await writeFile(join(out, resource), html.replaceAll(/(src|href)="([^"]+\.(?:js|css))"/g, `$1="$2?v=${manifest.version}"`));
}
// Stage runtime files only; Finder metadata is removed by macOS packaging and cannot enter the hash inventory.
const staging = await mkdtemp(join(tmpdir(), 'work-desk-ai-package-'));
try {
  for (const name of ['plugin.json', 'package.json', 'src', 'dist', 'ico', 'title.md']) {
    await cp(join(root, name), join(staging, name), { recursive: true, filter: path => basename(path) !== '.DS_Store' });
  }
  await packPackage(staging, fileURLToPath(new URL(`../../../plugin-dev/dist/${manifest.id}-${manifest.version}.plg`, import.meta.url)));
} finally {
  await rm(staging, { recursive: true, force: true });
}

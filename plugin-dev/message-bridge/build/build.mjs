import { build } from 'esbuild';
import { mkdir, copyFile, cp, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPackage } from '../../../desk/src/main/common/plugin-package.js';
import { excludedNames, excludedExts } from 'app-builder-lib/out/fileMatcher.js';
import { createTransformer } from 'app-builder-lib/out/fileTransformer.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'dist/renderer');
await mkdir(out, { recursive: true });
await build({ entryPoints: [join(root, 'src/renderer/app.js')], outfile: join(out, 'app.js'), bundle: true,
  format: 'esm', platform: 'browser', target: 'chrome145' });
const sourceManifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
const html = await readFile(join(root, 'src/resource/index.html'), 'utf8');
await writeFile(join(out, 'index.html'), html.replaceAll(/(src|href)="([^"]+\.(?:js|css))"/g, `$1="$2?v=${sourceManifest.version}"`));
const staging = await mkdtemp(join(tmpdir(), 'message-bridge-package-'));
try {
  for (const name of ['plugin.json', 'package.json', 'package-lock.json', 'src', 'dist', 'ico', 'README.md']) {
    await cp(join(root, name), join(staging, name), { recursive: true, filter: path => basename(path) !== '.DS_Store' });
  }
  // Install the locked production closure into staging; SDK protocol resources must remain next to their modules.
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, stdio: 'pipe' });
  await rm(join(staging, 'package-lock.json'));
  await rm(join(staging, 'node_modules/.bin'), { recursive: true, force: true });
  // Hash only files that the desktop packager keeps, so built-in and standalone packages share one integrity inventory.
  const desktopExcludedNames = new Set(excludedNames.split(','));
  const desktopExcludedExtensions = excludedExts.split(',').map(extension => `.${extension}`);
  const transform = createTransformer(staging, {}, null);
  const clean = async directory => {
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || desktopExcludedNames.has(entry.name)
        || desktopExcludedExtensions.some(extension => entry.name.endsWith(extension))
        || ['test', 'tests', '__tests__', 'example', 'examples', 'docs', 'demo', 'coverage', 'benchmark', 'benchmarks',
        '.github', '.vscode', '.DS_Store', '@types'].includes(entry.name)
        || (entry.isFile() && /\.(map|ts|md)$/.test(entry.name) && !/^(licen[cs]e|copying|notice)/i.test(entry.name))) {
        await rm(path, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        await clean(path);
      } else if (entry.name === 'package.json') {
        const transformed = await transform(path);
        if (transformed !== null) {
          await writeFile(path, transformed);
        }
      }
    }
  };
  await clean(join(staging, 'node_modules'));
  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  const output = fileURLToPath(new URL(`../../../plugin-dev/dist/${manifest.id}-${manifest.version}.plg`, import.meta.url));
  await packPackage(staging, output);
  console.log(output);
} finally {
  await rm(staging, { recursive: true, force: true });
}

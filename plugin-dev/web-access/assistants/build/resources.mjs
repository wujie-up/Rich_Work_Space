import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildWeb } from '../../../../web/build/build.mjs';

// Both assistants embed the exact server build; generated resources are never a second source tree.
export async function prepareResources() {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  await buildWeb();
  const target = join(root, 'plugin-dev/web-access/assistants/Shared/Client/Resources/WebShell');
  await mkdir(target, { recursive: true });
  for (const name of ['app.js', 'app.css', 'shell-manifest.json']) {
    await copyFile(join(root, 'web/dist', name), join(target, name));
  }
  // Reuse the desktop artwork; keep the resized Apple asset catalog in generated output.
  const catalog = join(root, 'plugin-dev/web-access/dist/ios/Assets.xcassets');
  const icon = join(catalog, 'AppIcon.appiconset');
  await mkdir(icon, { recursive: true });
  execFileSync('/usr/bin/sips', ['-z', '1024', '1024', join(root, 'desk/src/resource/icons/app.png'),
    '--out', join(icon, 'AppIcon.png')], { stdio: 'pipe' });
  await writeFile(join(catalog, 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 } }));
  await writeFile(join(icon, 'Contents.json'), JSON.stringify({
    images: [{ filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
    info: { author: 'xcode', version: 1 }
  }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareResources();
}

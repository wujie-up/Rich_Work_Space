import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPackageSource } from '../../../desk/src/main/common/plugin-package.js';

test('distribution includes the executable signed helper under integrity protection and excludes development/user data', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  await withPackageSource(join(root, '../dist', `${manifest.id}-${manifest.version}.plg`), async (directory, packaged) => {
    assert.equal(packaged.version, manifest.version);
    const bundle = join(directory, 'dist/assistant/Work Desk Assistant.app');
    const binary = join(bundle, 'Contents/MacOS/DeskLinkMac');
    assert.ok((await stat(binary)).mode & 0o111, 'extraction must preserve executable permission');
    assert.match(execFileSync('/usr/bin/file', [binary], { encoding: 'utf8' }), /Mach-O 64-bit executable arm64/);
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', bundle], { stdio: 'pipe' });
    assert.ok((await readFile(join(bundle, 'Contents/Info.plist'), 'utf8')).includes(`<string>${manifest.version}</string>`));
    const { files } = JSON.parse(await readFile(join(directory, 'integrity.json'), 'utf8'));
    assert.ok(files['dist/assistant/Work Desk Assistant.app/Contents/MacOS/DeskLinkMac']);
    assert.ok(files['dist/assistant/Work Desk Assistant.app/Contents/_CodeSignature/CodeResources']);
    const resources = 'dist/assistant/Work Desk Assistant.app/Contents/Resources/DeskLink_DeskLinkClient.bundle/Contents/Resources/WebShell';
    const shell = JSON.parse(await readFile(join(directory, resources, 'shell-manifest.json'), 'utf8'));
    for (const name of ['app.js', 'app.css', 'shell-manifest.json']) {
      assert.ok(files[`${resources}/${name}`], `embedded ${name} must be integrity protected`);
    }
    assert.equal(shell.version, JSON.parse(await readFile(join(root, '../../web/dist/shell-manifest.json'), 'utf8')).version);
    assert.deepEqual(Object.keys(files).filter(name => /^(assistants|test|plugin-data)\/|(^|\/)(\.build|xcuserdata)(\/|$)|\.(swift|key|pem)$/.test(name)), []);
  });
});

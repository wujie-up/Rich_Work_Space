import { constants } from 'node:fs';
import { access, chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export default async function prepareNativeRuntime(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }
  const directory = join(context.packager.getResourcesDir(context.appOutDir), 'app.asar.unpacked/node_modules/node-pty');
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const helpers = entries.filter(entry => entry.isFile() && entry.name === 'spawn-helper');
    if (!helpers.length) {
      throw new Error(`Missing node-pty spawn-helper: ${directory}`);
    }
    // node-pty may ship helpers without executable bits; repair the unpacked payload before macOS signing.
    for (const entry of helpers) {
      const helper = join(entry.parentPath, entry.name);
      const { mode } = await stat(helper);
      await chmod(helper, mode | 0o111);
      await access(helper, constants.X_OK);
      console.info('[build:native-runtime:ready]', { helper });
    }
  } catch (error) {
    console.error('[build:native-runtime:failed]', { directory, error });
    throw error;
  }
}

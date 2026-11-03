import { readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { fail } from '../../shared/contracts.js';
import { withPackageSource } from './plugin-package.js';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;

// Compare numeric identifiers without rounding large version components through Number.
export function compareVersions(left, right) {
  const a = versionPattern.exec(left);
  const b = versionPattern.exec(right);
  if (!a || !b) {
    return null;
  }
  for (let index = 1; index <= 3; index++) {
    if (BigInt(a[index]) !== BigInt(b[index])) {
      return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1;
    }
  }
  if (a[4] === b[4]) {
    return 0;
  }
  if (!a[4] || !b[4]) {
    return a[4] ? -1 : 1;
  }
  const first = a[4].split('.');
  const second = b[4].split('.');
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    if (first[index] === second[index]) {
      continue;
    }
    if (first[index] === undefined || second[index] === undefined) {
      return first[index] === undefined ? -1 : 1;
    }
    const numericA = /^\d+$/.test(first[index]);
    const numericB = /^\d+$/.test(second[index]);
    if (numericA !== numericB) {
      return numericA ? -1 : 1;
    }
    return (numericA ? BigInt(first[index]) > BigInt(second[index]) : first[index] > second[index]) ? 1 : -1;
  }
  return 0;
}

async function fingerprint(path) {
  const file = await stat(path, { bigint: true });
  return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');
}

export class PluginUpdates {
  constructor({ storage, plugins }) {
    this.storage = storage;
    this.plugins = plugins;
    this.pending = null;
    this.result = { directory: '', updates: [], errors: [] };
  }

  async configure(directory) {
    if (typeof directory !== 'string' || (directory && !isAbsolute(directory))) {
      throw fail('INVALID_ARGUMENT', '插件扫描目录必须是绝对路径');
    }
    await this.pending;
    const preferences = await this.storage.readJson('preferences.json', {});
    await this.storage.writeJson('preferences.json', { ...preferences, pluginPackageDirectory: directory });
    if (preferences.pluginPackageDirectory !== directory) {
      this.result = { directory, updates: [], errors: [] };
    }
    console.info('[plugin:updates-directory]', { directory });
    return this.snapshot();
  }

  // UI reads never inspect archives or wait for a background scan.
  async snapshot() {
    const directory = (await this.storage.readJson('preferences.json', {})).pluginPackageDirectory || '';
    if (directory !== this.result.directory) {
      return { directory, updates: [], errors: [] };
    }
    const installed = this.plugins.list();
    return { ...this.result, updates: this.result.updates.filter(update => installed.some(record =>
      record.id === update.id && record.state !== 'uninstalled' && !record.cleanupPending
      && compareVersions(update.version, record.version) === 1)) };
  }

  // Concurrent manual checks share one directory listing.
  scan() {
    if (!this.pending) {
      this.pending = this.inspectDirectory().then(result => {
        this.result = result;
        return result;
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async inspectDirectory() {
    let directory = '';
    const result = { directory, updates: [], errors: [] };
    try {
      directory = (await this.storage.readJson('preferences.json', {})).pluginPackageDirectory || '';
      result.directory = directory;
      if (!directory) {
        return result;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      const paths = entries.filter(entry => entry.isFile() && entry.name.endsWith('.plg')).map(entry => join(directory, entry.name)).sort();
      result.updates = this.selectUpdates(paths);
      console.info('[plugin:updates-scan]', { directory, packages: paths.length, updates: result.updates.length });
    } catch (error) {
      console.error('[plugin:updates-scan]', { directory, error: error.stack });
      result.updates = [];
      result.errors.push('无法读取插件扫描目录，请检查路径和权限。');
    }
    return result;
  }

  // Discovery trusts only the conventional filename; installation still validates the entire private package snapshot.
  selectUpdates(paths) {
    return this.plugins.list().filter(record => record.state !== 'uninstalled' && !record.cleanupPending).flatMap(record => {
      const prefix = `${record.id}-`;
      const compatible = paths.flatMap(path => {
        const name = basename(path);
        const version = name.startsWith(prefix) ? name.slice(prefix.length, -4) : '';
        return compareVersions(version, record.version) === 1 ? [{ id: record.id, version, path }] : [];
      });
      compatible.sort((a, b) => compareVersions(b.version, a.version));
      return compatible.slice(0, 1);
    });
  }

  async upgrade(id, version, token) {
    const before = this.result.updates.find(candidate => candidate.id === id && candidate.version === version);
    const result = await this.scan();
    const update = result.updates.find(candidate => candidate.id === id && candidate.version === version);
    if (!update || before?.path !== update.path) {
      throw fail('UPDATE_CHANGED', '插件包已变化，请重新检查更新。');
    }
    // Upgrade from a private inspected snapshot, closing the file-replacement race before stopping any runtime.
    const stamp = await fingerprint(update.path);
    return withPackageSource(update.path, async (directory, manifest) => {
      const current = this.plugins.list().find(record => record.id === id && record.state !== 'uninstalled');
      if (stamp !== await fingerprint(update.path) || manifest.id !== id || manifest.version !== version
        || !current || current.dataVersion !== manifest.dataVersion || compareVersions(version, current.version) !== 1) {
        throw fail('UPDATE_CHANGED', '插件包已变化，请重新检查更新。');
      }
      return this.plugins.upgrade(id, directory, token);
    });
  }
}

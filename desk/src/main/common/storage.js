import * as fs from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, pluginId } from '../../shared/contracts.js';

export class Storage {
  constructor(root) {
    this.root = resolve(root);
    this.io = fs;
    this.pending = new Map();
  }

  pluginDir(id) {
    return join(this.root, 'plugin-data', pluginId(id));
  }

  // Prefer the current installation root while keeping existing packages readable in place.
  async packageDirectory(id) {
    const current = await this.path(`plugins/${pluginId(id)}`);
    try {
      await this.io.lstat(current);
      return current;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return this.path(`packages/${id}`);
    }
  }

  // Check every existing component, because even a controlled leaf can have a linked parent.
  async path(key) {
    const path = resolve(this.root, key);
    const subpath = relative(this.root, path);
    if (!subpath || subpath.startsWith('..') || subpath.startsWith(sep)) {
      throw fail('INVALID_ARGUMENT', '数据路径越界');
    }
    let current = this.root;
    for (const part of subpath.split(sep)) {
      current = join(current, part);
      const info = await this.io.lstat(current).catch((error) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        return null;
      });
      if (info?.isSymbolicLink()) {
        throw fail('INVALID_ARGUMENT', '数据路径不能包含符号链接');
      }
    }
    return path;
  }

  async readJson(key, fallback = null) {
    try {
      return JSON.parse(await this.io.readFile(await this.path(key), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return fallback;
      }
      throw error;
    }
  }

  // Serialize writes of the same record; atomic replacement alone does not preserve ordering.
  writeJson(key, value) {
    const json = JSON.stringify(value);
    const pending = (this.pending.get(key) || Promise.resolve()).catch(() => {}).then(() => this.replace(key, json));
    this.pending.set(key, pending);
    pending.finally(() => {
      if (this.pending.get(key) === pending) {
        this.pending.delete(key);
      }
    }).catch(() => {});
    return pending;
  }

  async replace(key, json) {
    const path = await this.path(key);
    await this.io.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await this.io.writeFile(temp, json, { mode: 0o600 });
      await this.io.rename(temp, path);
    } finally {
      await this.io.rm(temp, { force: true });
    }
  }

  async clearPluginData(id) {
    await this.io.rm(await this.path(`plugin-data/${pluginId(id)}`), { recursive: true, force: true });
  }
}

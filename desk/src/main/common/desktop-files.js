import { constants } from 'node:fs';
import { mkdir, readdir, lstat, writeFile, copyFile, chmod, link, unlink, open } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { fail } from '../../shared/contracts.js';

// Desktop resources live outside plugin installations, so upgrades cannot replace user files.
export class DesktopFiles {
  constructor(storage) {
    this.storage = storage;
  }

  async directory() {
    const path = await this.storage.path('desktop-files');
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  async path(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[/\\\x00-\x1f\x7f]/.test(name)
      || ['.', '..'].includes(name)) {
      throw fail('INVALID_ARGUMENT', '文件名无效');
    }
    await this.directory();
    return this.storage.path(`desktop-files/${name}`);
  }

  async list() {
    const entries = await readdir(await this.directory(), { withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => ({ name: entry.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(name) {
    const path = await this.path(name);
    const entry = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') {
        console.info('[desktop:file-missing]', { name });
        throw fail('FILE_NOT_FOUND', '文件已被移走或删除');
      }
      throw error;
    });
    if (!entry.isFile()) {
      throw fail('INVALID_ARGUMENT', '仅支持普通文件');
    }
    return path;
  }

  // Read metadata from the owned file rather than cached desktop entries.
  async properties(name) {
    const path = await this.resolve(name);
    const entry = await lstat(path);
    return { name, path, size: entry.size, modified: entry.mtimeMs, created: entry.birthtimeMs };
  }

  // Bound the actual read as well as stat size: a selected file may change while its picker is open.
  async read(name) {
    const file = await open(await this.resolve(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) {
        throw fail('INVALID_ARGUMENT', '仅支持普通文件');
      }
      const limit = 2 * 1024 * 1024;
      const bytes = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await file.read(bytes, size, bytes.length - size, null);
        if (!result.bytesRead) {
          break;
        }
        size += result.bytesRead;
      }
      if (size > limit) {
        throw fail('FILE_TOO_LARGE', '请选择不超过 2 MB 的文件');
      }
      console.info('[desktop:file-selected]', { name, size });
      return { name, size, bytes: new Uint8Array(bytes.subarray(0, size)) };
    } finally {
      await file.close();
    }
  }

  // Exclusive creation protects both existing resources and concurrent drops from overwrites.
  async store(name, write) {
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    for (let index = 0; ; index += 1) {
      const suffix = index ? ` (${index})` : '';
      const candidate = index ? `${stem.slice(0, 200 - suffix.length - extension.length)}${suffix}${extension}` : name;
      const path = await this.path(candidate);
      try {
        await write(path);
        console.info('[desktop:file-saved]', { name: candidate });
        return { name: candidate };
      } catch (error) {
        if (error.code !== 'EEXIST') {
          console.error('[desktop:file-save]', { name: candidate, message: error.message });
          throw error;
        }
      }
    }
  }

  async rename(name, nextName) {
    const source = await this.resolve(name);
    const target = await this.path(nextName);
    if (name === nextName) {
      return { name };
    }
    // A hard link reserves the destination atomically without overwriting an existing file.
    await link(source, target);
    try {
      await unlink(source);
    } catch (error) {
      await unlink(target);
      throw error;
    }
    console.info('[desktop:file-renamed]', { name, nextName });
    return { name: nextName };
  }

  create(name) {
    return this.store(name, path => writeFile(path, '', { flag: 'wx', mode: 0o600 }));
  }

  async import(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 100) {
      throw fail('INVALID_ARGUMENT', '每次支持导入 1–100 个普通文件');
    }
    // Validate the whole selection before copying any file; directories and links are never traversed.
    for (const path of paths) {
      if (typeof path !== 'string' || !isAbsolute(path) || !(await lstat(path)).isFile()) {
        throw fail('INVALID_ARGUMENT', '仅支持导入普通文件');
      }
    }
    const imported = [];
    for (const source of paths) {
      imported.push(await this.store(basename(source), async target => {
        await copyFile(source, target, constants.COPYFILE_EXCL);
        await chmod(target, 0o600);
      }));
    }
    return imported;
  }
}

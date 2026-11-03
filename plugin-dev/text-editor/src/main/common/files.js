import { readdir, realpath, stat, lstat, readFile, writeFile, rename, link, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, basename, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Whole-document editing keeps a memory bound while allowing ordinary multi-megabyte text files.
const limit = 16 * 1024 * 1024;
const revision = bytes => createHash('sha256').update(bytes).digest('hex');

export class Files {
  // Missing status is transient: permission and other access errors must not imply deletion.
  static async describe(file) {
    try {
      await stat(resolve(file.root, file.path));
      return { ...file, missing: false };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
        return { ...file, missing: true };
      }
      console.error('[text-editor:files] status failed', { pluginId: 'text-editor', root: file.root, path: file.path }, error);
      return { ...file, missing: false };
    }
  }

  // A contributed document entry gets its own client and directory, preserving other windows' drafts.
  async openDocument({ path, cwd }) {
    if (!isAbsolute(path) && (!cwd || !isAbsolute(cwd))) { throw Error('文档需要绝对路径或有效工作目录'); }
    const target = await realpath(resolve(cwd || '', path));
    const files = new Files();
    // A direct file open needs its original save directory, not a scan of sibling files.
    files.root = dirname(target);
    const file = await files.read(basename(target));
    // A missing or invalid historical file must not change the current document's save directory.
    this.root = files.root;
    return { ...file, root: this.root };
  }

  async workspace(root) {
    this.root = await realpath(root);
    return this.list('');
  }

  // Resolve symlinks before access so a selected directory remains the file boundary.
  async target(path, creating = false) {
    if (!this.root) { throw Error('请先打开工作目录'); }
    const target = resolve(this.root, path);
    this.contained(target);
    const actual = await realpath(target).catch(async error => {
      if (!creating || error.code !== 'ENOENT') { throw error; }
      return resolve(await realpath(dirname(target)), target.slice(dirname(target).length + 1));
    });
    this.contained(actual);
    return actual;
  }

  contained(path) {
    const child = relative(this.root, path);
    if (child === '..' || child.startsWith('../') || isAbsolute(child)) { throw Error('文件必须位于工作目录内'); }
  }

  async list(path) {
    const directory = await this.target(path);
    const entries = await readdir(directory, { withFileTypes: true });
    return { root: this.root, path, entries: entries.filter(entry => entry.isDirectory() || entry.isFile()).map(entry => ({
      name: entry.name, directory: entry.isDirectory(), path: [path, entry.name].filter(Boolean).join('/')
    })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
  }

  async read(path) {
    const target = await this.target(path);
    if ((await stat(target)).size > limit) {
      throw Error('文件超过 16 MiB，请使用专用大文件编辑器');
    }
    const bytes = await readFile(target);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw Error('仅支持 UTF-8 文本，请先转换文件编码'); }
    if (text.includes('\0')) { throw Error('不支持二进制文件'); }
    return { path, text: text.replace(/\r\n/g, '\n'), revision: revision(bytes),
      bom: bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])), newline: text.includes('\r\n') ? '\r\n' : '\n' };
  }

  // File actions never follow a symbolic link or operate on a directory.
  async regularFile(path) {
    await this.target(path);
    const target = resolve(this.root, path);
    if (!(await lstat(target)).isFile()) { throw Error('仅支持操作普通文件'); }
    return target;
  }

  async renameFile(path, name) {
    if (!name.trim() || ['.', '..'].includes(name) || /[/\\\0]/.test(name)) { throw Error('文件名称不能包含路径'); }
    const source = await this.regularFile(path);
    const destination = resolve(dirname(source), name);
    if (source !== destination) {
      // Exclusive linking prevents a concurrent rename from overwriting another file.
      await link(source, destination);
      try { await unlink(source); }
      catch (error) {
        await unlink(destination);
        throw error;
      }
    }
    return { path: relative(this.root, destination), name };
  }

  async deleteFile(path) {
    await unlink(await this.regularFile(path));
  }

  async save({ path, text, revision: expected }) {
    const target = await this.target(path, true);
    const current = await this.read(path).catch(error => {
      if (error.code === 'ENOENT') { return null; }
      throw error;
    });
    if (current && expected == null) { throw Error('文件已存在，请选择其他名称或先打开文件'); }
    if (expected != null && current?.revision !== expected) { throw Error('文件已被修改或删除，请先重新打开，草稿仍保留'); }
    const bytes = Buffer.from(`${current?.bom ? '\ufeff' : ''}${text.replace(/\r\n/g, '\n').replace(/\n/g, current?.newline || '\n')}`);
    if (bytes.length > limit) {
      throw Error('文件超过 16 MiB');
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: current ? (await stat(target)).mode : 0o600 });
      // A new file uses exclusive creation; existing files are replaced atomically after conflict checking.
      if (current) { await rename(temporary, target); }
      else { await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
    } finally { await unlink(temporary).catch(() => {}); }
    console.info('[text-editor] saved', { path, bytes: bytes.length });
    return this.read(path);
  }
}

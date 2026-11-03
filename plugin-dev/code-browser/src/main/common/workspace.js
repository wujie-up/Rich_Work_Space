import { open, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const maxFileBytes = 1024 * 1024;
const maxTextBytes = 128 * 1024;
const maxResultBytes = 768 * 1024;
const ignoredDirectories = new Set(['.git', '.idea', 'node_modules', 'dist', 'build', 'target', '.next', 'coverage']);
const sourceExtension = /\.(java|vue|[cm]?js|jsx|tsx?|json|html?|css|scss|less|xml|ya?ml|properties|sql|md|txt|kt)$/i;
export const fail = (code, message) => Object.assign(Error(message), { code });

function boundedEntries(entries) {
  const items = [];
  let bytes = 0;
  for (const entry of entries) {
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > maxResultBytes || items.length === 2000) {
      return { items, truncated: true };
    }
    items.push(entry);
  }
  return { items, truncated: false };
}

export function integer(value, fallback, min, max) {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw fail('INVALID_INPUT', `数值范围应为 ${min}–${max}`);
  }
  return number;
}

// Git also uses this lexical check for paths that have already been deleted from disk.
export function relativePath(value = '', allowEmpty = true) {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('\0') || value.includes('\\')
    || isAbsolute(value) || value.split('/').includes('..') || (!allowEmpty && !value)) {
    throw fail('INVALID_PATH', '路径必须位于已选项目内，并使用相对路径');
  }
  return value;
}

export function sourceLines(text, input) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const startLine = integer(input.startLine, 1, 1, Math.max(1, lines.length));
  const endLine = integer(input.endLine, Math.min(startLine + 499, Math.max(1, lines.length)), startLine,
    Math.max(startLine, Math.min(startLine + 499, lines.length)));
  const selected = lines.slice(startLine - 1, endLine).join('\n');
  if (Buffer.byteLength(selected) > maxTextBytes) {
    throw fail('OUTPUT_LIMIT', '所选内容超过 128 KiB，请缩小行范围');
  }
  return { text: selected, startLine, endLine: lines.length ? endLine : 0, totalLines: lines.length };
}

export class Workspace {
  constructor(root) {
    this.root = root;
  }

  static async open(directory) {
    const root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) {
      throw fail('INVALID_DIRECTORY', '请选择项目目录');
    }
    return new Workspace(root);
  }

  async locate(path = '') {
    const actual = await realpath(resolve(this.root, relativePath(path)));
    const inside = relative(this.root, actual);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw fail('INVALID_PATH', '符号链接指向项目目录之外');
    }
    return actual;
  }

  async list({ path = '', compact = false } = {}) {
    const entries = (await readdir(await this.locate(path), { withFileTypes: true }))
      .filter(entry => (entry.isDirectory() || entry.isFile()) && !ignoredDirectories.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const bounded = boundedEntries(entries.map(entry => ({ name: entry.name,
      path: [path, entry.name].filter(Boolean).join('/'), directory: entry.isDirectory() })));
    // A shared read budget bounds lookahead; only visible single-directory chains are folded.
    let reads = 0;
    if (compact) {
      for (const entry of bounded.items.filter(entry => entry.directory)) {
        for (let depth = 0; depth < 16 && reads < 256; depth++) {
          reads++;
          const children = await this.list({ path: entry.path });
          if (children.truncated || children.entries.length !== 1 || !children.entries[0].directory) {
            break;
          }
          entry.name += `/${children.entries[0].name}`;
          entry.path = children.entries[0].path;
        }
      }
    }
    return { path, entries: bounded.items, truncated: bounded.truncated };
  }

  async text(path) {
    relativePath(path, false);
    // Non-blocking open lets fstat reject FIFOs without waiting for an external writer.
    const handle = await open(await this.locate(path), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxFileBytes) {
        throw fail('FILE_LIMIT', '仅支持不超过 1 MiB 的文本文件');
      }
      // Read a bounded buffer even if another process grows the file after stat.
      const buffer = Buffer.alloc(Math.min(info.size + 1, maxFileBytes + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxFileBytes) {
        throw fail('FILE_LIMIT', '文件超过 1 MiB');
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
        if (text.includes('\0')) {
          throw Error('binary');
        }
        return text;
      } catch {
        throw fail('NOT_TEXT', '仅支持 UTF-8 文本文件');
      }
    } finally {
      await handle.close();
    }
  }

  async read(input) {
    return { path: input.path, ...sourceLines(await this.text(input.path), input) };
  }

  async search({ query, limit = 100, path = '' }, signal) {
    if (typeof query !== 'string' || !query || query.length > 256) {
      throw fail('INVALID_INPUT', '搜索内容须为 1–256 个字符');
    }
    integer(limit, 100, 1, 100);
    await this.locate(path);
    const pending = [relativePath(path)];
    const matches = [];
    const deadline = Date.now() + 10000;
    let scanned = 0;
    while (pending.length) {
      signal?.throwIfAborted();
      const current = pending.pop();
      const listing = await this.list({ path: current });
      if (listing.truncated) {
        return { matches, scanned, truncated: true, reason: '目录条目超过 2000，请缩小目录' };
      }
      for (const entry of listing.entries) {
        signal?.throwIfAborted();
        if (++scanned > 10000 || Date.now() > deadline) {
          return { matches, scanned, truncated: true, reason: '达到搜索数量或时间上限，请缩小目录' };
        }
        if (entry.directory) {
          pending.push(entry.path);
          continue;
        }
        if (!sourceExtension.test(entry.name)) {
          continue;
        }
        const text = await this.text(entry.path).catch(error => {
          if (['NOT_TEXT', 'FILE_LIMIT', 'ENOENT', 'EACCES'].includes(error.code)) {
            return '';
          }
          throw error;
        });
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (line.includes(query)) {
            matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 300) });
            if (Buffer.byteLength(JSON.stringify(matches)) > maxResultBytes) {
              matches.pop();
              return { matches, scanned, truncated: true, reason: '达到输出大小上限，请缩小目录' };
            }
            if (matches.length === limit) {
              return { matches, scanned, truncated: true, reason: '达到匹配数量上限' };
            }
          }
        }
      }
    }
    return { matches, scanned, truncated: false };
  }
}

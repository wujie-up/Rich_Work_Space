import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../../shared/contracts.js';

export async function resolveFileReferences(paths, cwd) {
  if (!Array.isArray(paths) || paths.length > 32
    || paths.some(path => typeof path !== 'string' || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path))) {
    throw fail('INVALID_ARGUMENT', '文件路径无效或过多');
  }
  const references = [];
  for (const value of paths) {
    const path = resolve(cwd, value.startsWith('file:') ? fileURLToPath(value) : value.replace(/^~(?=\/|$)/, homedir()));
    try {
      if (!(await stat(path)).isFile()) {
        return [];
      }
    } catch (error) {
      // A path-shaped message can still be ordinary text; do not consume it when no local file exists.
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
        return [];
      }
      throw error;
    }
    if (!references.some(reference => reference.path === path)) {
      references.push({ path, name: basename(path) });
    }
  }
  return references;
}

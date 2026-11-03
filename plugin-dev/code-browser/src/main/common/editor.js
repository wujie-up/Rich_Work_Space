import { constants } from 'node:fs';
import { open, writeFile, rename, unlink, stat, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from './workspace.js';

const limit = 128 * 1024;
const revision = bytes => createHash('sha256').update(bytes).digest('hex');

/** Full snapshots avoid overwriting a file with only its currently visible page. */
export async function editFile(workspace, { path }) {
  const handle = await open(await workspace.locate(path), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) {
      throw fail('EDIT_LIMIT', '仅支持编辑不超过 128 KiB 的普通文本文件');
    }
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) {
      throw fail('EDIT_LIMIT', '文件超过 128 KiB，请使用外部编辑器');
    }
    const bytes = buffer.subarray(0, bytesRead);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw fail('NOT_TEXT', '仅支持 UTF-8 文本文件');
    }
    if (text.includes('\0')) {
      throw fail('NOT_TEXT', '仅支持 UTF-8 文本文件');
    }
    return { path, text: text.replace(/\r\n/g, '\n'), revision: revision(bytes),
      bom: bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])), newline: text.includes('\r\n') ? '\r\n' : '\n' };
  } finally {
    await handle.close();
  }
}

/** Preserve the source format and reject stale drafts before atomic replacement. */
export async function saveFile(workspace, { path, text, revision: expected }) {
  if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > limit) {
    throw fail('EDIT_LIMIT', '编辑内容须为不超过 128 KiB 的文本');
  }
  const current = await editFile(workspace, { path });
  if (typeof expected !== 'string' || current.revision !== expected) {
    throw fail('FILE_CHANGED', '文件已被修改，请保留草稿并重新打开文件');
  }
  const target = await workspace.locate(path);
  const bytes = Buffer.from(`${current.bom ? '\ufeff' : ''}${text.replace(/\r\n/g, '\n').replace(/\n/g, current.newline)}`);
  if (bytes.length > limit) {
    throw fail('EDIT_LIMIT', '保存后的文件超过 128 KiB');
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const mode = (await stat(target)).mode;
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    await chmod(temporary, mode);
    if ((await editFile(workspace, { path })).revision !== expected) {
      throw fail('FILE_CHANGED', '文件已被修改，请保留草稿并重新打开文件');
    }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
  console.info('[coding:save]', { pluginId: 'code-browser', root: workspace.root, path, bytes: bytes.length });
  return editFile(workspace, { path });
}

import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '../../shared/contracts.js';

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const invalid = () => fail('INVALID_ARGUMENT', '图片数据无效、分块顺序错误或超过 20 MB');

function imageHeader(bytes, type) {
  switch (type) {
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    case 'image/jpeg': return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString());
    case 'image/webp': return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    default: return false;
  }
}

// Keep image files with plugin data so restored CLI contexts can still read pasted paths.
export async function saveImageChunk(storage, session, chunk) {
  const { id, type, offset, data, complete } = chunk;
  if (!/^[a-f0-9-]{36}$/.test(id) || !Object.hasOwn(extensions, type) || !Number.isInteger(offset) || offset < 0
    || typeof data !== 'string' || data.length > 349528 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw invalid();
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || offset + bytes.length > 20 * 1024 * 1024 || offset === 0 && !imageHeader(bytes, type)) {
    throw invalid();
  }
  const directory = await storage.path(`plugin-data/${session.pluginId}/tmp/images/${session.id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `clipboard-${id}.${extensions[type]}`);
  const file = await open(`${path}.part`, offset === 0 ? 'wx' : 'a', 0o600);
  try {
    if ((await file.stat()).size !== offset) {
      throw invalid();
    }
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  if (!complete) {
    return null;
  }
  await rename(`${path}.part`, path);
  console.info('[session:image-saved]', { pluginId: session.pluginId, sessionId: session.id, path, bytes: offset + bytes.length });
  return path;
}

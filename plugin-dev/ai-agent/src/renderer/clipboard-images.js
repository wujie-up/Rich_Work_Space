import { api } from './api.js';

const CHUNK_SIZE = 256 * 1024;

function imageChunk(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Stay below the generic host message limit without adding clipboard access to the host.
export async function saveClipboardImage(session, file) {
  if (file.size > 20 * 1024 * 1024) {
    throw Error('图片不能超过 20 MB');
  }
  const id = crypto.randomUUID();
  let path;
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    path = await api.sessions.saveImage(session.pluginId, session.id, { id, type: file.type, offset,
      data: await imageChunk(file.slice(offset, offset + CHUNK_SIZE)), complete: offset + CHUNK_SIZE >= file.size });
  }
  return path;
}

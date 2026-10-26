import { mkdir, appendFile, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const secret = /authorization|cookie|api[-_]?key|token|secret/i;
export function safeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, secret.test(key) ? '[REDACTED]' : value]));
}

export class CaptureLog {
  constructor(root, onEvent = () => {}) {
    this.root = root;
    this.onEvent = onEvent;
    this.pending = Promise.resolve();
    this.sequence = 0;
    this.error = null;
  }

  async start() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) { throw Error('无效记录 ID'); }
    return join(this.root, `${id}.jsonl`);
  }

  write(id, type, value = {}) {
    const event = { id, sequence: ++this.sequence, at: new Date().toISOString(), type, ...value };
    this.pending = this.pending.then(async () => {
      await appendFile(this.file(id), `${JSON.stringify(event)}\n`, { mode: 0o600 });
      this.onEvent({ id, type, sequence: event.sequence, at: event.at });
    }).catch(error => {
      this.error = error.code || 'LOG_WRITE_FAILED';
      this.onEvent({ type: 'capture.error', code: this.error });
    });
  }

  flush() { return this.pending; }

  async list() {
    await this.flush();
    const files = (await readdir(this.root)).filter(name => /^[a-f0-9-]{36}\.jsonl$/.test(name));
    const entries = await Promise.all(files.map(async name => {
      const info = await stat(join(this.root, name));
      return { id: name.slice(0, -6), bytes: info.size, at: info.mtime.toISOString() };
    }));
    return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
  }

  async read(id, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) { throw Error('无效读取位置'); }
    await this.flush();
    const file = await open(this.file(id), 'r');
    try {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const bytes = (await file.stat()).size;
      return { data: buffer.subarray(0, bytesRead).toString('base64'), offset: offset + bytesRead, bytes };
    } finally {
      await file.close();
    }
  }
}

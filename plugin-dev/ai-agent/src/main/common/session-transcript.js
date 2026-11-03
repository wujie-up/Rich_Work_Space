import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const limit = 512 * 1024;

async function locate(directory, suffix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(suffix)) { return path; }
    if (entry.isDirectory()) {
      const found = await locate(path, suffix);
      if (found) { return found; }
    }
  }
}

// Keep dialogue in order; structured records take precedence over duplicate engine events per role.
export function transcriptMessages(lines, adapterId) {
  const messages = [];
  const structuredRoles = new Set();
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const item = adapterId === 'claude' ? record.message : record.payload;
    const role = adapterId === 'claude' ? record.type : item?.role;
    const structured = (adapterId === 'claude' || record.type === 'response_item')
      && ['user', 'assistant'].includes(role) && item?.channel !== 'analysis';
    if (structured) {
      const text = item?.content?.filter(part => ['text', 'input_text', 'output_text'].includes(part.type))
        .map(part => part.text).join('\n').trim();
      if (text) {
        structuredRoles.add(role);
        messages.push({ role, text, structured: true });
      }
    }
    if (adapterId === 'codex' && record.type === 'event_msg') {
      const role = item?.type === 'user_message' ? 'user' : 'assistant';
      const text = ['user_message', 'agent_message'].includes(item?.type) ? item.message
        : item?.type === 'task_complete' ? item.last_agent_message : '';
      // Completion repeats the last reply; identical messages in later turns remain distinct.
      const previous = messages.at(-1);
      if (text && !(item.type === 'task_complete' && previous?.role === role && previous.text === text)) {
        messages.push({ role, text, structured: false });
      }
    }
  }
  return messages.filter(message => message.structured || !structuredRoles.has(message.role))
    .slice(-60).map(({ role, text }) => ({ role, text }));
}

export function sessionTranscript(root) {
  const cache = new Map();
  return async session => {
    if (!['codex', 'claude'].includes(session.adapterId) || !session.contextId) {
      return { available: false, messages: [] };
    }
    const key = `${session.adapterId}:${session.profileId || 'default'}:${session.contextId}`;
    try {
      const directory = join(...(session.adapterId === 'claude' ? [root, 'engines', 'claude'] : [root]), 'profiles', session.profileId || 'default', session.adapterId,
        session.adapterId === 'codex' ? 'sessions' : 'projects');
      const previous = cache.get(key);
      const path = previous?.path || await locate(directory, `${session.adapterId === 'codex' ? '-' : ''}${session.contextId}.jsonl`);
      if (!path) { return { available: false, messages: [] }; }
      const info = await stat(path);
      const revision = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (previous?.revision === revision) { return previous.result; }
      const file = await open(path, 'r');
      let text;
      try {
        const offset = Math.max(0, info.size - limit);
        const buffer = Buffer.alloc(Math.min(info.size, limit));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        text = buffer.subarray(0, bytesRead).toString('utf8');
        if (offset) { text = text.slice(text.indexOf('\n') + 1); }
      } finally { await file.close(); }
      const lines = text.split('\n');
      lines.pop();
      const result = { available: true, messages: transcriptMessages(lines, session.adapterId), truncated: info.size > limit };
      if (cache.size >= 64) { cache.delete(cache.keys().next().value); }
      cache.set(key, { path, revision, result });
      return result;
    } catch (error) {
      cache.delete(key);
      if (error.code === 'ENOENT') { return { available: false, messages: [] }; }
      console.error('[session:transcript]', { sessionId: session.id, adapterId: session.adapterId }, error);
      throw error;
    }
  };
}

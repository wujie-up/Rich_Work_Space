import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { needsUserConfirmation } from './text-confirmation.js';

// Idle sessions keep polling for native changes, but unchanged logs need no new buffer or JSON objects.
async function completion(path, cached) {
  const file = await open(path, 'r');
  try {
    const { dev, ino, size, mtimeMs, ctimeMs } = await file.stat();
    const version = `${dev}:${ino}:${size}:${mtimeMs}:${ctimeMs}`;
    if (cached?.version === version) {
      return cached;
    }
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return { version, final: latestCompletion(text, start) };
  } finally {
    await file.close();
  }
}

// Read bounded native records, never terminal replay, reasoning, tool output or an earlier turn's final answer.
function latestCompletion(text, start) {
  if (!text.endsWith('\n')) {
    return null;
  }
  const lines = text.trimEnd().split('\n');
  if (start) {
    lines.shift();
  }
  for (const line of lines.reverse()) {
    const record = JSON.parse(line);
    if (record.type !== 'event_msg') {
      continue;
    }
    if (['task_started', 'turn_aborted'].includes(record.payload.type)) {
      return null;
    }
    if (record.payload.type === 'task_complete') {
      return record.payload.error ? null : { text: record.payload.last_agent_message || '', timestamp: record.timestamp };
    }
  }
  return null;
}

// Background terminal events can report working after completion; reconcile against the latest native turn.
export function prepareCodexActivity(changed, session, dataRoot) {
  if (!dataRoot) {
    return;
  }
  let path;
  let contextId;
  let cached;
  let pending;
  let closed = false;
  const timer = setInterval(() => {
    if (pending || session.blocked || !['idle', 'done', 'working'].includes(session.activity) || !session.contextId || session.exited) {
      return;
    }
    const sequence = session.sequence;
    const inputAt = session.lastInputAt;
    const context = session.contextId;
    pending = (async () => {
      try {
        if (context !== contextId) {
          path = undefined;
          cached = undefined;
          contextId = context;
        }
        if (!path) {
          const directory = join(dataRoot, 'profiles', session.profileId || 'default', 'codex', 'sessions');
          const files = await readdir(directory, { recursive: true });
          const name = files.find(name => name.endsWith(`-${context}.jsonl`));
          path = name && join(directory, name);
        }
        cached = path ? await completion(path, cached) : undefined;
        const final = cached?.final;
        // Input and native events take precedence over an asynchronous read of the previous answer.
        if (closed || sequence !== session.sequence || context !== session.contextId || inputAt !== session.lastInputAt
          || session.blocked || !['idle', 'done', 'working'].includes(session.activity) || session.exited || session.closing) {
          return;
        }
        if (final && Date.parse(final.timestamp) >= (inputAt || 0)) {
          if (needsUserConfirmation(final.text)) {
            changed({ activity: session.activity, blocked: 'question', question: final.text });
            console.info('[codex:confirmation]', { pluginId: session.pluginId, sessionId: session.id, contextId: context });
          } else if (session.activity === 'working') {
            changed({ activity: 'done', blocked: null, question: null });
            console.info('[codex:activity-complete]', { pluginId: session.pluginId, sessionId: session.id,
              contextId: context, completedAt: final.timestamp });
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('[codex:confirmation]', { pluginId: session.pluginId, sessionId: session.id, contextId: context,
            stack: error.stack });
        }
      }
    })().finally(() => { pending = null; });
  }, 750);
  timer.unref();
  return { close: async () => {
    closed = true;
    clearInterval(timer);
    await pending;
  } };
}

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fail } from '../../../shared/contracts.js';

export const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function readCodexSession(path, savedContext) {
  return (await readCodexLog(path, savedContext)).contextId;
}

// Only a complete, explicit initialization with no submissions proves an unsaved window is empty.
async function readCodexLog(path, savedContext) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = [];
  let contextId = savedContext;
  let seenRoot = false;
  let emptyContextId;
  let submitted = false;
  try {
    for await (const line of lines) {
      submitted ||= line.includes(':submission_dispatch{');
      const initialization = line.match(/\bINFO\s+(.*?thread_spawn\{[^}]*\}):session_init:session_init\.thread_persistence\{[^}]*session_init\.ephemeral=(true|false)\}: codex_core::session::session: new(?:\s|$)/i);
      if (initialization) {
        // Persisted subagents inherit a parent span; only a top-level spawn changes the foreground conversation.
        pending.push(!initialization[1].startsWith('thread_spawn{') || initialization[2] === 'true');
      }
      const match = line.match(/\bINFO\s+session_loop\{thread_id=([a-f0-9-]{36})\}: codex_core::session: new(?:\s|$)/i);
      if (match && SESSION_ID.test(match[1])) {
        // Concurrent initializations have no correlation ID; guessing could restore a different conversation.
        if (pending.length > 1) {
          pending.fill(null);
        }
        const ephemeral = pending.shift();
        emptyContextId = !seenRoot && ephemeral === false ? match[1] : undefined;
        if (ephemeral !== true) {
          contextId = ephemeral === false || (!seenRoot && ephemeral === undefined) ? match[1] : undefined;
        }
        seenRoot = true;
      }
    }
    // Native /new and /resume replace the foreground root; ephemeral background threads do not.
    contextId = pending.some((ephemeral) => ephemeral !== true) ? undefined : contextId;
    return { contextId, emptyContextId: !submitted && contextId === emptyContextId ? emptyContextId : undefined };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    // A resumed CLI may not have created its new log yet; its persisted context remains valid.
    return { contextId: savedContext };
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function restoreCodexSession(session, home, logsRoot) {
  const saved = new Set();
  for (const directory of ['sessions', 'archived_sessions']) {
    try {
      const files = await readdir(join(home, directory), { recursive: true });
      files.forEach(file => {
        const match = file.match(/-([a-f0-9-]{36})\.jsonl$/i);
        if (match && SESSION_ID.test(match[1])) {
          saved.add(match[1]);
        }
      });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  if (saved.has(session.contextId)) {
    return session.contextId;
  }
  // Earlier releases could replace a recoverable conversation with an unsaved empty one; inspect only its own lineage.
  const logIds = [...new Set([...(session.logIds || []), session.logId].filter(id => SESSION_ID.test(id || '')))];
  let empty = logIds.length > 0;
  for (const [index, logId] of logIds.reverse().entries()) {
    const { contextId, emptyContextId } = await readCodexLog(join(logsRoot, logId, 'codex-tui.log'));
    if (saved.has(contextId)) {
      console.info('[session:repair-context]', { sessionId: session.id, previousContextId: session.contextId, contextId, logId });
      return contextId;
    }
    empty &&= !!emptyContextId && (index !== 0 || contextId === session.contextId);
  }
  // Missing older logs or an unrecognized format cannot establish that the entire conversation was empty.
  if (empty) {
    console.info('[session:restore-empty]', { sessionId: session.id, contextId: session.contextId, logId: session.logId });
    return undefined;
  }
  if (session.contextId) {
    throw fail('CONTEXT_NOT_FOUND', '未找到此会话的引擎上下文，历史输出已保留，请从历史中选择原会话');
  }
}

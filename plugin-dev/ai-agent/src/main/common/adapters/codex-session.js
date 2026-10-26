import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function readCodexSession(path) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = [];
  let contextId;
  let seenRoot = false;
  try {
    for await (const line of lines) {
      const initialization = line.match(/\bINFO\s+thread_spawn\{[^}]*\}:session_init:session_init\.thread_persistence\{[^}]*session_init\.ephemeral=(true|false)\}: codex_core::session::session: new(?:\s|$)/i);
      if (initialization) {
        pending.push(initialization[1] === 'true');
      }
      const match = line.match(/\bINFO\s+session_loop\{thread_id=([a-f0-9-]{36})\}: codex_core::session: new(?:\s|$)/i);
      if (match && SESSION_ID.test(match[1])) {
        // Concurrent initializations have no correlation ID; guessing could restore a different conversation.
        if (pending.length > 1) {
          pending.fill(null);
        }
        const ephemeral = pending.shift();
        if (ephemeral !== true) {
          contextId = ephemeral === false || (!seenRoot && ephemeral === undefined) ? match[1] : undefined;
        }
        seenRoot = true;
      }
    }
    // Native /new and /resume replace the foreground root; ephemeral background threads do not.
    return pending.some((ephemeral) => ephemeral !== true) ? undefined : contextId;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    // Missing native metadata leaves restore unavailable rather than selecting a different conversation.
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }
}

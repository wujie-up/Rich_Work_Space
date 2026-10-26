const PREFIX = '\x1b]7501;';
const STATES = new Set(['idle', 'working', 'done', 'error']);
const BLOCKED = new Set(['permission', 'question', 'auth']);

// Codex reports lifecycle explicitly; quiet output and terminal redraws are not completion signals.
export function readActivity(session, data) {
  const buffer = (session.statusBuffer || '') + data;
  let activity = session.blocked || session.activity || 'unknown';
  for (const match of buffer.matchAll(/\x1b\]7501;([^\x07\x1b]{0,512})(?:\x07|\x1b\\)/g)) {
    const fields = Object.fromEntries(match[1].split(':').map((field) => field.split('=')));
    if (fields.state === 'clear') {
      activity = 'unknown';
    } else if (fields.app === 'codex') {
      activity = STATES.has(fields.state) ? fields.state : 'unknown';
      if (fields.state === 'blocked') {
        activity = BLOCKED.has(fields.kind) ? fields.kind : 'blocked';
      }
    }
  }
  // Keep only an unfinished control (or split prefix), never retain ordinary terminal output here.
  const start = buffer.lastIndexOf(PREFIX);
  const tail = start < 0 ? '' : buffer.slice(start);
  session.statusBuffer = tail && tail.length <= 530 && !/\x07|\x1b\\/.test(tail)
    ? tail : buffer.slice(-(PREFIX.length - 1));
  return activity;
}

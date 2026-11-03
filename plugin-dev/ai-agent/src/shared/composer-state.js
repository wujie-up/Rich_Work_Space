// Unknown layouts stay queued: a cursor in old scrollback or a multiline draft is never an empty composer.
export function emptyComposer(buffer) {
  const row = buffer.baseY + buffer.cursorY;
  const line = buffer.getLine(row);
  const text = line?.translateToString(true) || '';
  const prompt = text.match(/^(\s*[›❯>])(?:[ \u00a0](.*))?$/u);
  if (!prompt || line.isWrapped || buffer.cursorX !== prompt[1].length + 1) { return false; }
  if (prompt[2]?.trim() && (prompt[2] !== 'Ask Codex to do anything'
    || ![...prompt[2]].every((_, index) => line.getCell(prompt[1].length + 1 + index)?.isDim()))) { return false; }
  for (let index = row + 1; index < buffer.length; index++) {
    const below = buffer.getLine(index)?.translateToString(true).trim() || '';
    if (!below) { continue; }
    return /^(?:GPT-|Claude|\? for shortcuts|[─━]+$)|^.+ · (?:\/|~)/i.test(below);
  }
  return true;
}

// Working output is not an input acknowledgement, even when it moves the terminal cursor.
export function occupiedComposer(buffer) {
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  const prompt = line?.translateToString(true).match(/^(\s*[›❯>])[ \u00a0](.*)$/u);
  return !!prompt && !line.isWrapped && !!prompt[2].trim() && buffer.cursorX > prompt[1].length + 1;
}

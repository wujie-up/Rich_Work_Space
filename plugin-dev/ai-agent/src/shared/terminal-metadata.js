// Read native chrome without changing the buffer used for input readiness and automatic delivery.
export function terminalMetadata(buffer) {
  const rows = [];
  let model = '';
  let composer = -1;
  for (let row = buffer.baseY; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    const text = line?.translateToString(true).trim() || '';
    if (!line?.isWrapped && /^[›❯>]\s/u.test(text)) { composer = row; }
    if (composer >= 0 && row > composer && row <= composer + 8 && !line?.isWrapped) {
      let footer = text;
      let end = row;
      while (buffer.getLine(end + 1)?.isWrapped) {
        footer += buffer.getLine(++end).translateToString(true);
      }
      const match = footer.match(/^([^·]+?)\s+·\s*(?:\/|~)/u);
      if (match) {
        model = match[1].trim();
        for (let index = row; index <= end; index++) { rows.push(index); }
      }
    }
    // The startup banner repeats the working directory already shown by the card footer.
    if (/^(?:\/|~)/u.test(text) && /OpenAI Codex/.test(buffer.getLine(row - 1)?.translateToString(true) || '')) {
      rows.push(row);
      for (let index = row + 1; buffer.getLine(index)?.isWrapped; index++) { rows.push(index); }
    }
  }
  return { model, rows };
}

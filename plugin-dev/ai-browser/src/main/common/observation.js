import { createHash } from 'node:crypto';

export function safeUrl(value) {
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Error('只允许不含内嵌凭据的 HTTP/HTTPS 地址');
  }
  return url.href;
}

// Bound characters rather than claiming a tokenizer-independent token count.
export function compactSnapshot(source, { mode = 'elements', query = '', offset = 0, maxChars = 4000 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 12000) {
    throw Error('offset 必须非负，maxChars 必须在 1–12000 之间');
  }
  const roles = /^\s*- (?:heading|button|link|textbox|searchbox|checkbox|radio|combobox|option|menuitem\w*|tab|switch|slider|spinbutton|alert|dialog)\b/;
  const text = source.split('\n').filter(line => (mode !== 'elements' || roles.test(line))
    && (!query || line.toLocaleLowerCase().includes(query.toLocaleLowerCase()))).map(line => line.trim()).join('\n');
  const end = Math.min(text.length, offset + maxChars);
  return { text: text.slice(offset, end), totalChars: text.length, offset, nextOffset: end < text.length ? end : null };
}

export function snapshotId(scope, text) {
  return createHash('sha256').update(JSON.stringify(scope)).update(text).digest('hex').slice(0, 16);
}

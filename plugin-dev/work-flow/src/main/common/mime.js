const DECODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

// A first version only needs readable text; structure is intentionally kept shallow.
export function parseMessage(raw) {
  const separator = raw.search(/\r?\n\r?\n/);
  const headerText = separator < 0 ? raw : raw.slice(0, separator);
  const body = separator < 0 ? '' : raw.slice(separator).replace(/^\r?\n\r?\n/, '');
  const headers = parseHeaders(headerText);
  return { messageId: headers.get('message-id') || '', from: decodeWords(headers.get('from') || ''),
    subject: decodeWords(headers.get('subject') || ''), date: headers.get('date') || '', text: bodyText(headers, body) };
}

export function parseHeaders(headerText) {
  const headers = new Map();
  let last = null;
  for (const line of String(headerText).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      headers.set(last, `${headers.get(last)} ${line.trim()}`);
      continue;
    }
    const index = line.indexOf(':');
    if (index <= 0) {
      continue;
    }
    last = line.slice(0, index).toLowerCase();
    headers.set(last, line.slice(index + 1).trim());
  }
  return headers;
}

function contentType(value) {
  const parts = String(value || 'text/plain').split(';');
  const params = Object.fromEntries(parts.slice(1).map(part => {
    const index = part.indexOf('=');
    return index < 0 ? [] : [part.slice(0, index).trim().toLowerCase(), unquote(part.slice(index + 1))];
  }));
  return { type: parts[0].trim().toLowerCase(), params };
}

const unquote = value => String(value).trim().replace(/^"(.*)"$/, '$1');

function bodyText(headers, body) {
  const { type, params } = contentType(headers.get('content-type'));
  const transfer = String(headers.get('content-transfer-encoding') || '').toLowerCase();
  if (type.startsWith('multipart/') && params.boundary) {
    return multipartText(body, params.boundary);
  }
  const text = decodeBody(body, transfer, params.charset);
  return type === 'text/html' ? htmlToText(text) : text;
}

function multipartText(body, boundary) {
  const candidates = body.split(`--${boundary}`).slice(1).map(part => {
    const clean = part.replace(/--\s*$/, '');
    const separator = clean.search(/\r?\n\r?\n/);
    if (separator < 0) {
      return ['text/plain', ''];
    }
    const headers = parseHeaders(clean.slice(0, separator));
    const chunk = clean.slice(separator).replace(/^\r?\n\r?\n/, '');
    const { type } = contentType(headers.get('content-type'));
    return [type, bodyText(headers, chunk)];
  }).filter(([, text]) => text.trim());
  const preferred = candidates.find(([type]) => type === 'text/plain');
  return (preferred || candidates[0] || ['', ''])[1];
}

function decodeBody(body, transfer, charset) {
  if (transfer.includes('base64')) {
    return decodeBytes(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset);
  }
  if (transfer.includes('quoted-printable')) {
    return decodeBytes(decodeQuotedPrintable(body), charset);
  }
  return body;
}

function decodeQuotedPrintable(body) {
  const collapsed = body.replace(/=(?:\r?\n|$)/g, '').replace(/=([0-9A-Fa-f]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(collapsed, 'latin1');
}

// Crypto-free conversion: Node's TextDecoder covers UTF-8 and common legacy charsets when ICU is complete.
function decodeBytes(bytes, charset) {
  const name = String(charset || 'utf-8').replace(/"/g, '').trim().toLowerCase();
  try {
    return new TextDecoder(name).decode(bytes);
  } catch (error) {
    return bytes.toString('utf8');
  }
}

function decodeWords(value) {
  return String(value).replace(DECODED_WORD, (match, charset, encoding, text) => {
    if (encoding.toUpperCase() === 'B') {
      return decodeBytes(Buffer.from(text, 'base64'), charset);
    }
    const bytes = Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (full, hex) =>
      String.fromCharCode(parseInt(hex, 16))), 'latin1');
    return decodeBytes(bytes, charset);
  }).replace(/\s+/g, ' ').trim();
}

function htmlToText(html) {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const extension = /\.(?:md|markdown|txt|sql|jsonc?|ya?ml|xml|csv|tsv|puml|plantuml|html?|log|js|mjs|ts|py)(?::\d+(?::\d+)?)?$/i;

export function documentLinks(text = '') {
  const links = [];
  const pattern = /\[[^\]\n]+\]\(([^)\n]+)\)|`([^`\n]+)`|(?:[\p{L}\p{N}_~.@:/-]+\.)[a-zA-Z]+(?::\d+(?::\d+)?)?/gu;
  for (const match of text.matchAll(pattern)) {
    const path = (match[1] || match[2] || match[0]).replace(/^<|>$/g, '');
    if (!extension.test(path) || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) { continue; }
    links.push({ path: path.replace(/:\d+(?::\d+)?$/, ''), start: match.index, end: match.index + match[0].length });
  }
  return links;
}

// Soft wraps split paths visually; only explicit line breaks separate document links.
export function terminalDocumentLinks(buffer, row) {
  let first = row - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) {
    first--;
  }
  let text = '';
  const positions = [];
  for (let index = first; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (index > first && !line.isWrapped) {
      break;
    }
    let end = line.length;
    // Empty cells can pad a wrap before a wide character; literal spaces still belong to the path.
    while (end > 0 && !line.getCell(end - 1).getChars()) {
      end--;
    }
    for (let column = 0; column < end; column++) {
      const cell = line.getCell(column);
      if (!cell.getWidth()) {
        continue;
      }
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let offset = 0; offset < chars.length; offset++) {
        positions.push({ x: column + 1, y: index + 1, width: cell.getWidth() });
      }
    }
  }
  return documentLinks(text).map(link => {
    const start = positions[link.start];
    const end = positions[link.end - 1];
    return { path: link.path, text: text.slice(link.start, link.end),
      range: { start: { x: start.x, y: start.y }, end: { x: end.x + end.width - 1, y: end.y } } };
  }).filter(link => link.range.start.y <= row && link.range.end.y >= row);
}

export async function openDocument(path, cwd) {
  const { api } = await import('./api.js');
  return api.host.openView(documentEntry(path), { path, cwd });
}

export const documentEntry = path => /\.html?$/i.test(path) ? 'browser-document' : 'text-document';

// Build DOM nodes rather than HTML so generated output never becomes executable markup.
export function renderDocumentLinks(node, text = '', cwd) {
  node.replaceChildren();
  let offset = 0;
  for (const link of documentLinks(text)) {
    node.append(document.createTextNode(text.slice(offset, link.start)));
    const anchor = document.createElement('a');
    anchor.href = '#';
    anchor.textContent = text.slice(link.start, link.end);
    anchor.title = documentEntry(link.path) === 'browser-document' ? '在 AI 浏览器中打开' : '在文本编辑器中浏览';
    anchor.onclick = async event => {
      event.preventDefault();
      try { await openDocument(link.path, cwd); }
      catch (error) { window.dispatchEvent(new CustomEvent('document-open-error', { detail: error })); }
    };
    node.append(anchor);
    offset = link.end;
  }
  node.append(document.createTextNode(text.slice(offset)));
}

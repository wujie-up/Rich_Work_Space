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

export async function openDocument(path, cwd) {
  const { api } = await import('./api.js');
  return api.host.openView('text-document', { path, cwd });
}

// Build DOM nodes rather than HTML so generated output never becomes executable markup.
export function renderDocumentLinks(node, text = '', cwd) {
  node.replaceChildren();
  let offset = 0;
  for (const link of documentLinks(text)) {
    node.append(document.createTextNode(text.slice(offset, link.start)));
    const anchor = document.createElement('a');
    anchor.href = '#';
    anchor.textContent = text.slice(link.start, link.end);
    anchor.title = '在文本编辑器中浏览';
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

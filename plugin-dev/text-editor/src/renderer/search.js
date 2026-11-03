import { selectEditorRange } from './text-position.js';

// Keep only the current match so repetitive large documents do not create millions of ranges.
export function findMatch(text, query, index = 0) {
  if (!query) {
    return { total: 0, index: 0 };
  }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  let total = 0;
  let first;
  let last;
  let selected;
  for (const match of text.matchAll(pattern)) {
    last = { start: match.index, end: match.index + match[0].length, index: total };
    first ||= last;
    if (total === index) {
      selected = last;
    }
    total++;
  }
  return { ...(selected || (index < 0 ? last : first)), total };
}

function previewContent(preview) {
  const nodes = [];
  const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement.closest('svg,button,script,style,[hidden]')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  let text = '';
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
    text += walker.currentNode.textContent;
  }
  return { text, nodes };
}

function previewRange(nodes, match) {
  const range = document.createRange();
  let offset = 0;
  for (const node of nodes) {
    const end = offset + node.length;
    if (match.start >= offset && match.start < end) {
      range.setStart(node, match.start - offset);
    }
    if (match.end <= end) {
      range.setEnd(node, match.end - offset);
      break;
    }
    offset = end;
  }
  return range;
}

export function setupSearch(panes) {
  const editor = panes.querySelector('#editor');
  const preview = panes.querySelector('#preview');
  const bar = document.querySelector('#search-bar');
  const query = bar.querySelector('input');
  const count = bar.querySelector('output');
  const button = document.querySelector('#search');
  const previous = bar.querySelector('#search-previous');
  const next = bar.querySelector('#search-next');
  let documentId;
  let index = 0;
  let timer;
  let returnFocus;

  function guard(work) {
    try {
      work();
    } catch (error) {
      CSS.highlights.delete('document-search');
      count.textContent = '搜索失败';
      previous.disabled = true;
      next.disabled = true;
      console.error('[text-editor:search]', { pluginId: 'text-editor', documentId }, error);
    }
  }

  function refresh() {
    CSS.highlights.delete('document-search');
    if (bar.hidden) {
      return;
    }
    const reading = panes.dataset.mode === 'read' || Boolean(document.body.dataset.presenting);
    const content = reading ? previewContent(preview) : { text: editor.value };
    const match = findMatch(content.text, query.value, index);
    index = match.index || 0;
    count.textContent = match.total ? `${index + 1} / ${match.total}` : (query.value ? '无结果' : '0 / 0');
    previous.disabled = !match.total;
    next.disabled = !match.total;
    if (!match.total) {
      return;
    }
    if (reading) {
      const range = previewRange(content.nodes, match);
      CSS.highlights.set('document-search', new Highlight(range));
      preview.scrollTop += range.getBoundingClientRect().top - preview.getBoundingClientRect().top - preview.clientHeight / 2;
    } else if (document.activeElement !== editor) {
      // Updating counts during typing must not replace the user's caret or selection.
      selectEditorRange(editor, match.start, match.end);
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (!bar.hidden) {
      timer = setTimeout(() => guard(refresh), 150);
    }
  }

  function move(step) {
    clearTimeout(timer);
    index += step;
    guard(refresh);
  }

  function open() {
    if (button.disabled) {
      return;
    }
    if (bar.hidden) {
      returnFocus = document.activeElement;
      bar.hidden = false;
      console.info('[text-editor:search-open]', { pluginId: 'text-editor', documentId });
    }
    query.focus();
    query.select();
    guard(refresh);
  }

  function close() {
    clearTimeout(timer);
    bar.hidden = true;
    CSS.highlights.delete('document-search');
    returnFocus?.focus({ preventScroll: true });
    console.info('[text-editor:search-close]', { pluginId: 'text-editor', documentId });
  }

  button.onclick = open;
  query.oninput = () => {
    index = 0;
    schedule();
  };
  query.onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  };
  previous.onclick = () => move(-1);
  next.onclick = () => move(1);
  bar.querySelector('#search-close').onclick = close;
  window.addEventListener('keydown', event => {
    if (event.isComposing || document.querySelector('dialog[open]')) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      open();
    } else if (event.key === 'Escape' && !bar.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  });
  // Preview renders asynchronously; rebuild ranges against the replacement text nodes.
  new MutationObserver(schedule).observe(preview, { childList: true, subtree: true, characterData: true });
  return state => {
    button.disabled = !state.id;
    if (state.id !== documentId) {
      index = 0;
    }
    documentId = state.id;
    if (!documentId) {
      clearTimeout(timer);
      bar.hidden = true;
      CSS.highlights.delete('document-search');
    }
    schedule();
  };
}

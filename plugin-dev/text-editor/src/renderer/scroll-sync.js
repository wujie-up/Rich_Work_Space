import { marked } from 'marked';
import { measureEditorOffsets } from './text-position.js';

// Top-level Markdown blocks retain their source order even when tables and diagrams change height.
function sourceAnchors(text, preview) {
  const anchors = [];
  const elements = [...preview.children];
  let offset = 0;
  let index = 0;
  for (const token of marked.lexer(text)) {
    const tag = ({ heading: `H${token.depth}`, paragraph: 'P', text: 'P', table: 'TABLE',
      code: ['mermaid', 'plantuml', 'puml'].includes((token.lang || '').trim().toLowerCase()) ? 'FIGURE' : 'PRE',
      list: token.ordered ? 'OL' : 'UL', blockquote: 'BLOCKQUOTE', hr: 'HR' })[token.type];
    if (tag && elements[index]?.tagName === tag) {
      const node = elements[index++];
      anchors.push({ offset, node });
      if (token.type === 'table') {
        const lines = token.raw.split('\n');
        let rowOffset = offset + lines[0].length + 1 + lines[1].length + 1;
        [...node.querySelectorAll('tbody tr')].forEach((row, rowIndex) => {
          anchors.push({ offset: rowOffset, node: row });
          rowOffset += lines[rowIndex + 2].length + 1;
        });
      }
    }
    offset += token.raw.length;
  }
  return anchors;
}

export function setupScrollSync(panes, enabled) {
  const editor = panes.querySelector('#editor');
  const preview = panes.querySelector('#preview');
  const assigned = new WeakMap();
  let points = [];
  let source = '';
  let leader = editor;
  let frame;

  function sync(pane) {
    if (!enabled() || source !== editor.value || points.length < 2) {
      return;
    }
    const target = pane === editor ? preview : editor;
    const axis = pane === editor ? 0 : 1;
    const end = points.at(-1);
    let top = 0;
    if (pane.scrollTop >= end[axis] - 1) {
      top = end[1 - axis];
    } else {
      const next = points.findIndex(point => point[axis] > pane.scrollTop);
      const from = points[Math.max(0, next - 1)];
      const to = points[next];
      top = from[1 - axis] + (to[1 - axis] - from[1 - axis]) * (pane.scrollTop - from[axis]) / (to[axis] - from[axis]);
    }
    target.scrollTop = top;
    // Consume the resulting scroll event so the two panes cannot feed back into each other.
    assigned.set(target, target.scrollTop);
  }

  function rebuild() {
    frame = undefined;
    if (!enabled()) {
      points = [];
      return;
    }
    try {
      if (source !== editor.value) {
        leader = editor;
      }
      source = editor.value;
      const anchors = sourceAnchors(source, preview);
      const positions = measureEditorOffsets(editor, anchors.map(anchor => anchor.offset));
      const bounds = preview.getBoundingClientRect();
      const end = [editor.scrollHeight - editor.clientHeight, preview.scrollHeight - preview.clientHeight];
      points = [[0, 0]];
      anchors.forEach((anchor, index) => {
        const point = [positions[index], anchor.node.getBoundingClientRect().top - bounds.top + preview.scrollTop];
        if (point.every((value, axis) => value > points.at(-1)[axis] && value < end[axis])) {
          points.push(point);
        }
      });
      if (end.every(value => value > 0)) {
        points.push(end);
        sync(leader);
      }
    } catch (error) {
      points = [];
      console.error('[text-editor:scroll-sync] mapping failed', { pluginId: 'text-editor' }, error);
    }
  }

  function refresh() {
    if (!frame) {
      frame = requestAnimationFrame(rebuild);
    }
  }

  [editor, preview].forEach(pane => pane.addEventListener('scroll', () => {
    const expected = assigned.get(pane);
    assigned.delete(pane);
    if (expected !== undefined && Math.abs(expected - pane.scrollTop) < 1) {
      return;
    }
    if (enabled()) {
      leader = pane;
      try {
        sync(pane);
      } catch (error) {
        points = [];
        console.error('[text-editor:scroll-sync] scroll failed', { pluginId: 'text-editor', pane: pane.id }, error);
      }
    }
  }, { passive: true }));
  preview.addEventListener('preview-render', refresh);
  // Keep the visible pane's position when returning from editing or reading to split mode.
  new MutationObserver(records => {
    leader = records[0].oldValue === 'read' ? preview : editor;
    refresh();
  }).observe(panes, { attributes: true, attributeFilter: ['data-mode'], attributeOldValue: true });
  new MutationObserver(() => {
    leader = editor;
    refresh();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-presenting'] });
  new ResizeObserver(refresh).observe(panes);
  new ResizeObserver(refresh).observe(editor);
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}

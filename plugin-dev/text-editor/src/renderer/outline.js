import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { createMarkdownRenderer } from './preview.js';
import { selectEditorRange } from './text-position.js';

export function setupOutline(panes) {
  const zone = panes.querySelector('#outline-zone');
  const outline = zone.querySelector('nav');
  const editor = panes.querySelector('#editor');
  const preview = panes.querySelector('#preview');
  let documentId;
  let renderTimer;
  let hideTimer;
  let hovered = false;

  function leave() {
    clearTimeout(hideTimer);
    // Mouse and keyboard users keep the list until they leave its controls.
    if (hovered || zone.matches(':focus-visible') || outline.querySelector(':focus-visible')) {
      return;
    }
    delete zone.dataset.visible;
  }

  function show() {
    clearTimeout(hideTimer);
    zone.dataset.visible = 'true';
    hideTimer = setTimeout(leave, 3000);
  }

  function render() {
    try {
      let offset = 0;
      const buttons = [];
      // Only document sections belong in the outline; quoted and fenced examples stay in the body.
      for (const token of marked.lexer(editor.value)) {
        if (token.type === 'heading') {
          const button = document.createElement('button');
          const inline = marked.Parser.parseInline(token.tokens, { renderer: createMarkdownRenderer() });
          button.textContent = DOMPurify.sanitize(inline, {
            ALLOWED_TAGS: [], ALLOWED_ATTR: [], RETURN_DOM_FRAGMENT: true
          }).textContent || '未命名标题';
          button.title = button.textContent;
          button.dataset.depth = token.depth;
          button.dataset.offset = offset;
          button.style.paddingInlineStart = `${8 + (token.depth - 1) * 12}px`;
          buttons.push(button);
        }
        offset += token.raw.length;
      }
      const entering = zone.hidden;
      outline.replaceChildren(...buttons);
      zone.hidden = !buttons.length;
      if (entering && buttons.length) {
        show();
        console.info('[text-editor:outline-open]', { pluginId: 'text-editor', documentId, headings: buttons.length });
      }
    } catch (error) {
      zone.hidden = true;
      outline.replaceChildren();
      console.error('[text-editor:outline-render]', { pluginId: 'text-editor', documentId }, error);
    }
  }

  function navigate(button) {
    const offset = Number(button.dataset.offset);
    if (panes.dataset.mode === 'edit' && !document.body.dataset.presenting) {
      editor.focus();
      selectEditorRange(editor, offset);
    } else {
      const index = [...outline.children].indexOf(button);
      preview.querySelectorAll(':scope > :is(h1,h2,h3,h4,h5,h6)')[index]?.scrollIntoView({ block: 'start' });
    }
    console.info('[text-editor:outline-navigate]', { pluginId: 'text-editor', documentId, offset });
  }

  outline.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) {
      return;
    }
    try {
      navigate(button);
    } catch (error) {
      editor.focus();
      console.error('[text-editor:outline-navigate]', { pluginId: 'text-editor', documentId }, error);
    }
  });
  zone.addEventListener('pointerenter', event => {
    // Touch hover can remain active until another tap, so it must not pin the outline open.
    if (event.pointerType === 'touch') {
      return;
    }
    hovered = true;
    show();
  });
  zone.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch') {
      return;
    }
    hovered = false;
    leave();
  });
  zone.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') {
      hovered = false;
      show();
    }
  });
  zone.addEventListener('focusin', show);
  zone.addEventListener('focusout', () => queueMicrotask(leave));
  return state => {
    clearTimeout(renderTimer);
    if (state.id !== documentId || state.type !== 'md') {
      clearTimeout(hideTimer);
      zone.hidden = true;
      delete zone.dataset.visible;
      outline.replaceChildren();
    }
    documentId = state.id;
    if (state.id && state.type === 'md') {
      renderTimer = setTimeout(render, 280);
    }
  };
}

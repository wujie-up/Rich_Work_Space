import { createEditorMirror } from './text-position.js';

// Only visible logical lines get gutter nodes; wrapped continuations keep the original line number.
export function setupLineNumbers(editor) {
  const gutter = document.querySelector('#line-numbers');
  let source;
  let offsets = [];
  let mirror;
  let frame;

  function render() {
    frame = undefined;
    if (!editor.clientHeight) {
      return;
    }
    try {
      if (source !== editor.value) {
        source = editor.value;
        mirror?.remove();
        mirror = undefined;
        offsets = [0];
        let newline = source.indexOf('\n');
        while (newline !== -1) {
          offsets.push(newline + 1);
          newline = source.indexOf('\n', newline + 1);
        }
        editor.parentElement.style.setProperty('--line-number-width', `${String(offsets.length).length + 2}ch`);
      }
      const style = getComputedStyle(editor);
      renderVisible(style, linePositions(style));
    } catch (error) {
      gutter.replaceChildren();
      mirror?.remove();
      mirror = undefined;
      console.error('[text-editor:line-numbers]', { pluginId: 'text-editor', name: document.querySelector('#document-name').textContent }, error);
    }
  }

  function linePositions(style) {
    const paddingTop = parseFloat(style.paddingTop);
    const lineHeight = parseFloat(style.lineHeight);
    const unwrappedHeight = offsets.length * lineHeight + paddingTop + parseFloat(style.paddingBottom);
    // Native scroll height proves there are no wrapped lines, avoiding a second large text layout.
    if (editor.scrollHeight > editor.clientHeight && Math.abs(editor.scrollHeight - unwrappedHeight) < 2) {
      mirror?.remove();
      mirror = undefined;
      return index => paddingTop + index * lineHeight;
    }
    if (!mirror || mirror.style.width !== `${editor.clientWidth}px` || mirror.style.font !== style.font
      || mirror.style.padding !== style.padding) {
      mirror?.remove();
      mirror = createEditorMirror(editor);
      Object.assign(mirror.style, { top: '0', left: '0', pointerEvents: 'none' });
      // The sentinel preserves the final empty line's range geometry without entering the document.
      mirror.textContent = `${source}\u200b`;
      editor.parentElement.append(mirror);
    }
    const range = document.createRange();
    const text = mirror.firstChild;
    const topAt = index => {
      range.setStart(text, offsets[index]);
      range.setEnd(text, offsets[index] + 1);
      return range.getBoundingClientRect().top;
    };
    const origin = topAt(0) - paddingTop;
    return index => topAt(index) - origin;
  }

  function renderVisible(style, topAt) {
    const lineHeight = parseFloat(style.lineHeight);
    let first = 0;
    let end = offsets.length;
    // Binary search skips offscreen lines even when the user jumps to the end of a large file.
    while (first < end) {
      const middle = (first + end) >>> 1;
      if (topAt(middle) + lineHeight < editor.scrollTop) {
        first = middle + 1;
      } else {
        end = middle;
      }
    }
    const numbers = document.createDocumentFragment();
    for (let index = first; index < offsets.length; index++) {
      const top = topAt(index) - editor.scrollTop;
      if (top > editor.clientHeight) {
        break;
      }
      const number = document.createElement('span');
      number.dataset.line = String(index + 1);
      number.textContent = number.dataset.line;
      number.style.top = `${top}px`;
      numbers.append(number);
    }
    gutter.replaceChildren(numbers);
  }

  function refresh() {
    if (!frame) {
      frame = requestAnimationFrame(render);
    }
  }

  editor.addEventListener('scroll', refresh, { passive: true });
  new ResizeObserver(refresh).observe(editor);
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  return refresh;
}

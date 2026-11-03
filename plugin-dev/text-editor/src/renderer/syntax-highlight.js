// Keep the native textarea responsible for input, selection and undo; only its presentation is mirrored.
export function setupSyntaxHighlight(editor) {
  const layer = document.querySelector('#source-highlight');
  let worker;
  let generation = 0;
  let timer;
  let previousText;
  let previousFormat;
  let documentId;

  function syncGeometry() {
    layer.style.width = `${editor.clientWidth}px`;
    layer.scrollTop = editor.scrollTop;
    layer.scrollLeft = editor.scrollLeft;
  }

  function showPlainText() {
    editor.classList.remove('syntax-colored');
    layer.hidden = true;
    layer.replaceChildren();
  }

  try {
    worker = new Worker(new URL('./syntax-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.generation !== generation || data.html === null) {
        return;
      }
      layer.innerHTML = `${data.html}\n`;
      layer.hidden = false;
      editor.classList.add('syntax-colored');
      syncGeometry();
    };
    worker.onerror = error => {
      console.error('[text-editor:syntax]', { pluginId: 'text-editor', documentId }, error.error || error.message);
      worker.terminate();
      worker = null;
      showPlainText();
    };
  } catch (error) {
    worker = null;
    showPlainText();
    console.error('[text-editor:syntax]', { pluginId: 'text-editor', documentId }, error);
  }
  editor.addEventListener('scroll', syncGeometry);
  new ResizeObserver(syncGeometry).observe(editor);

  return document => {
    documentId = document.id;
    const format = document.name || document.type;
    if (previousText === editor.value && previousFormat === format) {
      return;
    }
    previousText = editor.value;
    previousFormat = format;
    generation++;
    clearTimeout(timer);
    showPlainText();
    // shortcut: bound mirror DOM and parsing cost; use viewport tokenization if larger files need colors.
    if (!worker || !document.id || editor.value.length > 512 * 1024) {
      return;
    }
    timer = setTimeout(() => {
      try {
        worker?.postMessage({ generation, text: editor.value, name: document.name, type: document.type, documentId });
      } catch (error) {
        showPlainText();
        console.error('[text-editor:syntax]', { pluginId: 'text-editor', documentId }, error);
      }
    }, 60);
  };
}

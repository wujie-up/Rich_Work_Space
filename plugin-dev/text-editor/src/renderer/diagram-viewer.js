import { showPopup } from '../../../../desk/src/resource/popup.js';
export function setupDiagramViewer(preview) {
  const dialog = document.querySelector('#diagram-viewer');
  const viewport = dialog.querySelector('.diagram-viewport');
  const canvas = dialog.querySelector('.diagram-canvas');
  const scale = dialog.querySelector('output');
  const enlarge = dialog.querySelector('[data-zoom="in"]');
  const shrink = dialog.querySelector('[data-zoom="out"]');
  const zone = dialog.querySelector('.diagram-tools-zone');
  const tools = dialog.querySelector('.diagram-tools');
  let size;
  let percent = 100;
  let hideTimer;

  // Keyboard users must not lose a focused control when the idle timeout expires.
  function showTools() {
    if (!dialog.open) {
      return;
    }
    clearTimeout(hideTimer);
    tools.hidden = false;
    hideTimer = setTimeout(() => {
      if (zone.querySelector(':focus-visible') || zone.matches(':focus-visible')) {
        return;
      }
      tools.hidden = true;
    }, 3000);
  }

  function setZoom(value) {
    percent = Math.max(25, Math.min(400, value));
    const svg = canvas.firstElementChild;
    svg.style.width = `${size.width * percent / 100}px`;
    svg.style.height = `${size.height * percent / 100}px`;
    svg.style.maxWidth = 'none';
    scale.value = `${percent}%`;
    enlarge.disabled = percent === 400;
    shrink.disabled = percent === 25;
    showTools();
  }

  function open(figure) {
    const source = figure.querySelector('svg');
    const bounds = source.getBoundingClientRect();
    // Reuse the sanitized SVG so zooming stays offline and never reruns a diagram engine.
    canvas.replaceChildren(source.cloneNode(true));
    showPopup(dialog);
    const fit = Math.min(1, (viewport.clientWidth - 32) / bounds.width, (viewport.clientHeight - 32) / bounds.height);
    size = { width: bounds.width * fit, height: bounds.height * fit };
    setZoom(100);
    viewport.scrollTo(0, 0);
    console.info('[text-editor:diagram-open]', {
      pluginId: 'text-editor', diagramId: figure.dataset.diagram, language: figure.dataset.rendered
    });
  }

  function close() {
    if (dialog.open) {
      dialog.close();
    }
  }

  preview.addEventListener('click', event => {
    const figure = event.target.closest('figure[data-rendered]');
    if (figure) {
      open(figure);
    }
  });
  preview.addEventListener('keydown', event => {
    const figure = event.target.closest('figure[data-rendered]');
    if (figure && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open(figure);
    }
  });
  enlarge.onclick = () => setZoom(percent + 25);
  shrink.onclick = () => setZoom(percent - 25);
  dialog.querySelector('[data-zoom="reset"]').onclick = () => setZoom(100);
  dialog.querySelector('[data-zoom="close"]').onclick = close;
  for (const event of ['pointerenter', 'pointermove', 'focusin']) {
    zone.addEventListener(event, showTools);
  }
  // Hiding a clicked button also blurs it; only user focus changes restart the timer.
  zone.addEventListener('focusout', () => {
    if (!tools.hidden) {
      showTools();
    }
  });
  dialog.addEventListener('close', () => {
    clearTimeout(hideTimer);
    tools.hidden = true;
    canvas.replaceChildren();
  });
  return close;
}

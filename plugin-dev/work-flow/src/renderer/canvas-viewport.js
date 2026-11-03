const PADDING = 48;
const MIN_SCALE = 0.05;
const MAX_SCALE = 2;

// View state belongs to the open canvas, never to workflow business data.
export function createViewport(root) {
  const space = root.parentElement;
  const wrap = space.parentElement;
  const tools = document.querySelector('#canvas-tools');
  let scale = 1;
  let width = 900;
  let height = 620;
  let moved = false;

  function updateSize(nextWidth = width, nextHeight = height) {
    width = nextWidth;
    height = nextHeight;
    root.style.transform = `translate(${PADDING}px, ${PADDING}px) scale(${scale})`;
    space.style.width = `${width * scale + PADDING * 2}px`;
    space.style.height = `${height * scale + PADDING * 2}px`;
    tools.querySelector('#zoom-reset').title = `当前缩放 ${Math.round(scale * 100)}%，恢复 100% 缩放`;
    tools.querySelector('#zoom-out').disabled = scale <= MIN_SCALE;
    tools.querySelector('#zoom-in').disabled = scale >= MAX_SCALE;
  }

  // Keep the world point beneath the cursor fixed while zooming.
  function zoom(value, x = Math.min(wrap.clientWidth, width * scale + PADDING * 2) / 2,
    y = Math.min(wrap.clientHeight, height * scale + PADDING * 2) / 2) {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
    const worldX = (wrap.scrollLeft + x - PADDING) / scale;
    const worldY = (wrap.scrollTop + y - PADDING) / scale;
    scale = next;
    updateSize();
    wrap.scrollLeft = worldX * scale + PADDING - x;
    wrap.scrollTop = worldY * scale + PADDING - y;
  }

  function fit() {
    zoom(Math.min(1, (wrap.clientWidth - PADDING * 2) / width, (wrap.clientHeight - PADDING * 2) / height));
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
  }

  function focus(node) {
    wrap.scrollLeft = (node.x + node.width / 2) * scale + PADDING - wrap.clientWidth / 2;
    wrap.scrollTop = (node.y + node.height / 2) * scale + PADDING - wrap.clientHeight / 2;
  }

  function reset() {
    scale = 1;
    updateSize();
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
  }

  tools.querySelector('#zoom-out').onclick = () => zoom(scale / 1.2);
  tools.querySelector('#zoom-in').onclick = () => zoom(scale * 1.2);
  tools.querySelector('#zoom-reset').onclick = () => zoom(1);
  tools.querySelector('#zoom-fit').onclick = fit;
  wrap.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    const rect = wrap.getBoundingClientRect();
    zoom(scale * Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  wrap.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.node, [data-edge]')) {
      return;
    }
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
    moved = false;
    wrap.classList.add('panning');
    wrap.setPointerCapture(event.pointerId);
    const move = pointer => {
      if (pointer.pointerId !== event.pointerId) {
        return;
      }
      const dx = pointer.clientX - origin.x;
      const dy = pointer.clientY - origin.y;
      moved ||= Math.abs(dx) > 3 || Math.abs(dy) > 3;
      wrap.scrollLeft = origin.left - dx;
      wrap.scrollTop = origin.top - dy;
    };
    const finish = pointer => {
      if (pointer.pointerId !== event.pointerId) {
        return;
      }
      wrap.classList.remove('panning');
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerup', finish);
      wrap.removeEventListener('pointercancel', finish);
      setTimeout(() => { moved = false; }, 0);
    };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', finish);
    wrap.addEventListener('pointercancel', finish);
  });
  wrap.addEventListener('click', event => {
    if (moved) {
      event.stopImmediatePropagation();
    }
  }, true);
  return { updateSize, fit, reset, focus, get scale() { return scale; } };
}

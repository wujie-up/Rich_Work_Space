export function setupSidebar() {
  const layout = document.querySelector('.body');
  const sidebar = document.querySelector('#files');
  const toggle = document.querySelector('#toggle-files');
  let drag;
  const resize = width => layout.style.setProperty('--sidebar-width', `${Math.max(140, Math.min(width, 480, layout.clientWidth * .4))}px`);
  toggle.onclick = event => {
    // Pointer capture also emits a click after resizing; preserve the list in that case.
    if (event.detail > 0 && drag?.moved) {
      drag = null;
      return;
    }
    const collapsed = layout.dataset.listCollapsed !== 'true';
    layout.dataset.listCollapsed = String(collapsed);
    sidebar.inert = collapsed;
    toggle.ariaLabel = collapsed ? '展开文件列表' : '收起文件列表';
    toggle.title = collapsed ? '展开文件列表' : '收起文件列表（拖动调整宽度）';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  toggle.onpointerdown = event => {
    drag = null;
    if (event.button !== 0 || sidebar.inert) { return; }
    drag = { x: event.clientX, width: sidebar.offsetWidth, moved: false };
    toggle.setPointerCapture(event.pointerId);
  };
  toggle.onpointermove = event => {
    if (!drag || !toggle.hasPointerCapture(event.pointerId)) { return; }
    drag.moved ||= Math.abs(event.clientX - drag.x) > 4;
    if (drag.moved) {
      layout.classList.add('list-resizing');
      resize(drag.width + event.clientX - drag.x);
    }
  };
  toggle.onlostpointercapture = () => layout.classList.remove('list-resizing');
  toggle.onpointercancel = () => { drag = null; };
  toggle.onkeydown = event => {
    if (!sidebar.inert && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      resize(sidebar.offsetWidth + (event.key === 'ArrowRight' ? 20 : -20));
    }
  };
}

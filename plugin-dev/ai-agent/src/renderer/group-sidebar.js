import { el, iconButton, setButtonIcon } from './ui.js';

// Keep the preferred width when a narrow viewport temporarily limits the sidebar.
export function groupSidebar({ navigation, canvas, presentation, save }) {
  const separator = el('div', { class: 'group-resizer', role: 'separator', tabindex: 0,
    'aria-label': '调整分组栏宽度', 'aria-orientation': 'vertical', title: '拖动调整宽度，方向键微调' });
  const node = el('div', { class: 'group-workspace' }, navigation, separator, canvas);
  // Keep one control in the toolbar so hiding the navigation never moves its trigger.
  const toggleButton = iconButton('隐藏分组栏', 'sidebar', () => {
    presentation.hidden = !presentation.hidden;
    paint();
    return save();
  });
  let gesture;
  const maximum = () => Math.max(120, Math.min(360, node.clientWidth - 240));
  const clamp = width => Math.round(Math.max(120, Math.min(maximum(), width)));
  const width = () => clamp(presentation.width ?? 184);
  function paint() {
    node.style.setProperty('--group-sidebar-width', `${width()}px`);
    node.classList.toggle('groups-hidden', !!presentation.hidden);
    navigation.hidden = separator.hidden = !!presentation.hidden;
    const label = presentation.hidden ? '显示分组栏' : '隐藏分组栏';
    if (toggleButton.title !== label) { setButtonIcon(toggleButton, label, 'sidebar'); }
    toggleButton.setAttribute('aria-expanded', String(!presentation.hidden));
    separator.setAttribute('aria-valuemin', '120');
    separator.setAttribute('aria-valuemax', String(maximum()));
    separator.setAttribute('aria-valuenow', String(width()));
  }
  separator.addEventListener('pointerdown', event => {
    if (event.button !== 0) { return; }
    event.preventDefault();
    gesture = { pointerId: event.pointerId, x: event.clientX, width: width() };
    separator.setPointerCapture(event.pointerId);
    separator.focus();
    node.classList.add('groups-resizing');
  });
  separator.addEventListener('pointermove', event => {
    if (!gesture || gesture.pointerId !== event.pointerId) { return; }
    presentation.width = clamp(gesture.width + event.clientX - gesture.x);
    paint();
  });
  const finish = event => {
    if (!gesture || gesture.pointerId !== event.pointerId) { return; }
    gesture = null;
    node.classList.remove('groups-resizing');
    void save();
  };
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) { separator.addEventListener(event, finish); }
  separator.addEventListener('keydown', event => {
    const targets = { ArrowLeft: width() - 12, ArrowRight: width() + 12, Home: 120, End: maximum() };
    if (!(event.key in targets)) { return; }
    event.preventDefault();
    presentation.width = clamp(targets[event.key]);
    paint();
    void save();
  });
  const observer = new ResizeObserver(paint);
  observer.observe(node);
  paint();
  return { node, toggleButton, dispose: () => observer.disconnect() };
}

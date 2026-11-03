import { el, iconButton } from './ui.js';

export function mountFileReferences(container, focus) {
  let references = [];
  const tray = el('div', { class: 'session-file-references', role: 'list', 'aria-label': '待发送的文件引用', hidden: true });
  container.append(tray);
  const render = () => {
    tray.hidden = !references.length;
    tray.replaceChildren(...references.map(reference => el('div', { class: 'badge file-reference', role: 'listitem', title: reference.path },
      el('span', { text: `[!${reference.name}]` }), iconButton(`移除 ${reference.name}`, 'close', () => {
        references = references.filter(item => item.path !== reference.path);
        render();
        focus();
      }))));
  };
  return {
    add: files => {
      const combined = [...references, ...files.filter(file => !references.some(reference => reference.path === file.path))];
      if (combined.length > 32 || combined.reduce((length, file) => length + file.path.length, 0) > 32768) {
        throw Error('文件引用过多，请分次发送');
      }
      references = combined;
      render();
    },
    text: () => references.map(reference => `'${reference.path.replaceAll("'", "'\\''")}'`).join(' '),
    clear: () => {
      references = [];
      render();
    },
    dispose: () => tray.remove()
  };
}

import { mountShelfLayout } from './shelf-layout.js';
import { contextMenu } from './launcher.js';
import { api, ask, confirm, el, field, iconButton, modal, run } from './ui.js';

// Selection stays in the trusted host; plugins receive bytes only after an explicit user choice.
export async function chooseDesktopFile() {
  const files = await api.desktop.list();
  return modal('选择工作台文件', ({ body, actions, finish }) => {
    const select = el('select', { 'aria-label': '工作台文件', size: Math.min(8, Math.max(2, files.length)) });
    select.style.width = '100%';
    select.append(...files.map(file => el('option', { value: file.name, text: file.name })));
    const error = el('p', { role: 'alert', hidden: true });
    body.append(el('p', { text: files.length ? '选择工作台已有文件，最大 2 MB。' : '工作台暂无文件，请先导入文件或使用系统文件。' }), select, error);
    select.hidden = !files.length;
    actions.append(iconButton('m6 6 12 12M18 6 6 18', '取消选择', () => finish(null)));
    const confirm = iconButton('m5 12 4 4L19 6', '选择文件', async () => {
      confirm.disabled = true;
      error.hidden = true;
      try {
        finish(await api.desktop.read(select.value));
      } catch (failure) {
        console.error('[desktop:file-selection]', { name: select.value, message: failure.message });
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        confirm.disabled = !select.value;
      }
    });
    select.onchange = () => { confirm.disabled = !select.value; };
    confirm.disabled = !select.value;
    actions.append(confirm);
  }, { placement: 'center' });
}

// Keep file symbols theme-aware and recognizable without adding image assets.
function fileIcon(name) {
  const extension = name.split('.').pop().toLowerCase();
  const types = [
    [['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'heic'], 'M3 3h18v18H3ZM3 17l6-6 4 4 3-3 5 5M8 7h.01'],
    [['js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'py', 'java', 'sh', 'sql', 'xml', 'yaml', 'yml'], 'M8 6l-6 6 6 6M16 6l6 6-6 6M14 3l-4 18'],
    [['zip', 'tar', 'gz', 'rar', '7z'], 'M3 4h18v5H3ZM5 9v12h14V9M10 12h4M12 4v5'],
    [['pdf'], 'M14 2H4v20h16V8ZM14 2v6h6M7 17l4-7 2 5 4 2M7 17l10-3'],
    [['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'], 'M9 18V5l11-2v13M9 8l11-2M9 18a3 3 0 1 1-3-3h3M20 16a3 3 0 1 1-3-3h3'],
    [['mp4', 'mov', 'webm', 'mkv', 'avi'], 'M3 4h18v16H3ZM10 8l6 4-6 4Z'],
    [['csv', 'xls', 'xlsx', 'ods'], 'M3 3h18v18H3ZM3 9h18M3 15h18M9 3v18M15 3v18']
  ];
  return types.find(([extensions]) => extensions.includes(extension))?.[1]
    || 'M14 2H4v20h16V8ZM14 2v6h6M8 12h8M8 16h6';
}

export function mountDesktopFiles(desktop, openFile) {
  const grid = el('div', { class: 'desktop-files' });
  desktop.append(grid);
  const layout = mountShelfLayout(grid, {
    storageKey: 'desktop-file-layout',
    measure: () => {
      const cell = (Number.parseFloat(getComputedStyle(desktop).getPropertyValue('--grid-size')) || 24) * 2;
      const columns = Math.max(2, Math.floor((grid.clientWidth + 4) / cell));
      const column = (grid.clientWidth + 4) / columns;
      // Reserve enough grid rows for the full name even at the smallest icon size.
      const nameHeight = Math.max(0, ...[...grid.querySelectorAll('.desktop-file-name')].map(label => {
        label.style.width = `${column * 2 - 16}px`;
        const height = label.getBoundingClientRect().height;
        label.style.removeProperty('width');
        return height;
      }));
      const labelRows = Math.max(1, Math.ceil((nameHeight + 4) / column));
      return { size: column * 2 - 24, columns, labelRows,
        rows: Math.max(2 + labelRows, Math.floor((grid.clientHeight + 4) / column),
          Math.ceil(grid.children.length / Math.max(1, Math.floor(columns / 2))) * (2 + labelRows)), column, row: column };
    }
  });

  async function refresh() {
    const files = await api.desktop.list();
    // Focus refresh must not replace the pointer-captured node during a drag.
    if (layout.arranging) {
      return;
    }
    layout.retain(new Set(files.map(file => `file:${file.name}`)));
    grid.replaceChildren(...files.map(file => {
      const button = iconButton(fileIcon(file.name), ['打开文件 {name}', { name: file.name }], () => {}, 'desktop-file');
      button.dataset.layoutId = `file:${file.name}`;
      button.dataset.fileName = file.name;
      button.append(el('span', { class: 'desktop-file-name', text: file.name }));
      layout.bind(button);
      button.addEventListener('contextmenu', event => contextMenu(event, [
        ['打开', () => open(file.name)],
        ['复制', () => api.desktop.copy(file.name)],
        ['粘贴', paste],
        ['重命名', async () => {
          const name = await ask('重命名', file.name, 200);
          if (name === null || name.trim() === file.name) {
            return;
          }
          await api.desktop.rename(file.name, name.trim());
          layout.rename(`file:${file.name}`, `file:${name.trim()}`);
          await refresh();
        }],
        ['移到废纸篓', async () => {
          if (await confirm('移到废纸篓', ['将“{name}”移到废纸篓？', { name: file.name }])) {
            await api.desktop.trash(file.name);
            await refresh();
          }
        }],
        ['属性', () => properties(file.name)]
      ]));
      button.addEventListener('dblclick', () => run(() => open(file.name)));
      button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          run(() => open(file.name));
        }
      });
      return button;
    }));
    layout.layout();
  }

  async function open(name) {
    try {
      await openFile(name);
    } catch (error) {
      // External moves must not leave an unusable desktop entry behind.
      await refresh();
      throw error;
    }
  }

  async function create() {
    const name = await ask('创建文件', '新建文件.txt', 200);
    if (name === null) {
      return;
    }
    await api.desktop.create(name.trim());
    await refresh();
  }

  async function properties(name) {
    const file = await api.desktop.properties(name);
    return modal('文件属性', ({ body, actions }) => {
      const size = file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} KB (${file.size} B)`;
      const values = [['名称', file.name], ['大小', size], ['绝对路径', file.path],
        ['创建时间', new Date(file.created).toLocaleString()], ['修改时间', new Date(file.modified).toLocaleString()]];
      body.append(...values.map(([label, value]) => field(label,
        el('textarea', { readonly: true, rows: label === '绝对路径' ? 3 : 1, text: value }))));
      actions.hidden = true;
    });
  }

  // Clipboard imports use the same collision-safe storage path as file drops.
  async function paste(files) {
    try {
      await api.desktop.paste(files);
    } finally {
      await refresh();
    }
  }

  desktop.tabIndex = 0;
  desktop.addEventListener('pointerdown', event => {
    if (!event.target.closest('.desktop-file')) {
      desktop.focus({ preventScroll: true });
    }
  });
  desktop.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
      return;
    }
    const name = event.target.closest('.desktop-file')?.dataset.fileName;
    const key = event.key.toLowerCase();
    if (api.host.browser && key === 'v') {
      return;
    }
    if (key === 'v' || key === 'c' && name) {
      event.preventDefault();
      run(() => key === 'v' ? paste() : api.desktop.copy(name));
    }
  });
  desktop.addEventListener('paste', event => {
    event.preventDefault();
    run(() => paste(event.clipboardData?.files));
  });

  desktop.addEventListener('dragover', event => {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  });
  desktop.addEventListener('drop', event => {
    if (!event.dataTransfer.types.includes('Files')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const paths = [...event.dataTransfer.files].map(file => api.desktop.pathForFile(file));
    run(async () => {
      try {
        await api.desktop.import(paths);
      } finally {
        // A failed later copy must not hide files already imported successfully.
        await refresh();
      }
    });
  });
  window.addEventListener('focus', () => run(refresh));
  return { refresh, create, paste };
}

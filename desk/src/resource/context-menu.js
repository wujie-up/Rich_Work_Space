import { translate } from '../shared/i18n.js';
import { pluginHostOrigin } from './plugin-host.js';

const rename = 'm4 16-1 5 5-1L21 7l-4-4zM14 6l4 4';
const remove = 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7';
const paths = {
  '打开': 'M3 5h18v14H3ZM3 9h18M6 7h.01M9 7h.01',
  '修改名称': rename, '重命名': rename, '修改图标': rename,
  '恢复默认图标': 'M20 4v6h-6M20 10a8 8 0 1 0 0 5',
  '回到桌面': 'm3 11 9-8 9 8M5 9v12h14V9M9 21v-7h6v7',
  '创建文件': 'M14 2H4v20h16V8ZM14 2v6h6M8 15h8M12 11v8',
  '粘贴': 'M9 5H5v17h14V5h-4M9 3h6v4H9Z',
  '添加插件': 'M12 3v18M3 12h18',
  '复制': 'M8 8h12v13H8ZM16 8V3H3v13h5',
  '移到废纸篓': remove,
  '属性': 'M12 11v6M12 7h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',
  '新建窗口': 'M3 5h18v14H3ZM8 12h8M12 8v8',
  '最小化窗口': 'M5 12h14', '关闭窗口': 'm6 6 12 12M6 18 18 6'
};

// Retain each original label and explanation so repeated opening and language changes are reversible.
export function prepareContextMenu(menu) {
  menu.classList.add('desk-option-menu');
  for (const item of menu.querySelectorAll(':scope > [role=menuitem]')) {
    const key = item.dataset.menuLabel ||= item.getAttribute('aria-label') || item.textContent.trim();
    const title = item.dataset.menuTitle ||= item.title || key;
    let label = item.querySelector('span');
    if (!label) {
      label = document.createElement('span');
      if (!item.querySelector('svg')) {
        item.textContent = '';
      }
      item.append(label);
    }
    if (!item.querySelector('svg') && paths[key]) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', paths[key]);
      svg.append(path);
      item.prepend(svg);
    }
    label.textContent = translate(key, document.documentElement.lang);
    item.setAttribute('aria-label', label.textContent);
    item.title = translate(title, document.documentElement.lang);
  }
}

// Plugin frames accept the interface language only from their existing trusted workspace parent.
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'desk:theme' || !['zh-CN', 'en'].includes(event.data.language)) {
    return;
  }
  if (event.origin !== pluginHostOrigin()) {
    return;
  }
  document.documentElement.lang = event.data.language;
  document.querySelectorAll('.desk-option-menu').forEach(prepareContextMenu);
});

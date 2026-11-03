import '../../../../desk/src/resource/controls.css';
import { showSideDialog, closeSideDialog } from './side-dialog.js';
import { invoke, request } from './api.js';
import './style.css';
import { renderDiff } from './diff.js';
import { setupMaven } from './maven.js';
import { setupGitManagement } from './git-management.js';
import { setupEditor } from './editor.js';
import { setupSpring } from './spring.js';
import { fileIcon, fileType, sourceLines } from './source.js';

const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  history: '<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6M12 7v5l3 2"/>',
  branch: '<path d="M6 3v12a4 4 0 0 0 8 0V9M3 6h6M11 6h6"/>',
  folder: '<path d="M3 6h7l2 3h9v11H3Z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01"/>',
  braces: '<path d="M9 3H7c-2 0-2 2-2 4v2c0 2-2 3-3 3 1 0 3 1 3 3v2c0 2 0 4 2 4h2m6-18h2c2 0 2 2 2 4v2c0 2 2 3 3 3-1 0-3 1-3 3v2c0 2 0 4-2 4h-2"/>',
  code: '<path d="m8 5-6 7 6 7m8-14 6 7-6 7"/>',
  java: '<path d="M5 10h12v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Zm12 1h2a3 3 0 0 1 0 6h-2M3 23h17M9 7c-3-2 3-3 0-5m5 5c-3-2 3-3 0-5"/>',
  vue: '<path d="M2 4h5l5 8 5-8h5L12 21ZM7 4h4l1 2 1-2h4"/>',
  style: '<path d="m14 3 7 7-10 10H4v-7Zm-8 8 7 7M4 20l4-4"/>',
  markdown: '<path d="M4 3h16v18H4ZM7 7h10M7 11h6m-2 3v4m-2-2 2 2 2-2"/>',
  ignore: '<circle cx="12" cy="12" r="9"/><path d="m6 18 12-12"/>',
  file: '<path d="M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6m-6 4h6"/>'
}[name]}</svg>`;

document.querySelector('#app').innerHTML = `
  <header class="toolbar">
    <button id="projects-toggle" class="icon-button" aria-label="隐藏左侧区域" title="隐藏左侧区域" aria-expanded="true">${icon('panel')}</button>
    <button id="folder" class="icon-button" aria-label="打开项目目录" title="打开项目目录">${icon('folder')}</button>
    <span id="root" class="truncate">尚未选择项目</span>
    <button id="git-tab" class="git-entry truncate" aria-label="Git" aria-haspopup="dialog" aria-expanded="false" title="选择 Git 分支" aria-controls="git-branches">读取分支…</button>
    <div id="git-management"></div>
    <span class="toolbar-spacer"></span>
    <span class="help"><button aria-label="使用说明" aria-describedby="usage" title="使用说明">${icon('help')}</button>
      <span id="usage" role="tooltip">查看 UTF-8 源码，支持编辑已有文件（最多 128 KiB），修改后自动保存。Ctrl+F 查找 Java 定义。搜索区分大小写，跳过依赖和构建目录。单文件最多 1 MiB，每页最多 500 行。Agent 使用当前目录的 code.* 能力。Git 工作区比较不含未跟踪文件。</span></span>
    <nav aria-label="查看模式"><button id="build-tab" aria-pressed="false" title="展开或收起 Maven 面板" aria-controls="build-pane">Maven</button><button id="spring-tab" aria-pressed="false" title="展开或收起启动项面板" aria-controls="spring-pane">启动项</button><button id="projects-history" class="icon-button" title="历史项目" aria-label="历史项目">${icon('history')}</button><button id="tools-toggle" class="icon-button" aria-label="显示右侧区域" title="显示右侧区域" aria-expanded="false">${icon('panel')}</button></nav>
  </header>
  <div class="workspace">
    <aside class="project-sidebar">
      <div id="search-form" role="search"><input id="query" placeholder="搜索源码文本" aria-label="搜索源码文本" maxlength="256"><button id="search" title="搜索" aria-label="搜索" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0"/></svg></button></div>
      <div class="directory-bar"><span class="truncate">项目文件</span><button id="refresh" title="刷新" aria-label="刷新" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7 M20 4v6h-6"/></svg></button></div>
      <div id="files" aria-label="项目文件"></div>
      <div id="matches" aria-label="搜索结果"></div>
    </aside>
    <section class="content">
      <section id="source-pane">
        <div id="file-tabs" role="tablist" aria-label="已打开文件"></div>
        <div class="definition-tools" hidden>
          <input id="symbol" aria-label="Java 类或方法名" placeholder="Java 类或方法名" maxlength="128" disabled>
          <button id="definition-search" disabled title="查找定义" aria-label="查找定义" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0"/></svg></button>
          <span class="help"><button aria-label="Java 跳转说明" aria-describedby="jump-help" title="Java 跳转说明">${icon('help')}</button>
            <span id="jump-help" role="tooltip">当前 Java 文件可双击标识符查找定义，也可输入类或方法名。只列项目源码候选，不解析重载、继承或依赖库；历史版本不支持跳转。颜色为轻量词法高亮，分页起始处可能缺少上一页的多行上下文。</span></span>
        </div>
        <div id="definitions" aria-label="Java 定义候选" hidden></div>
        <pre id="source" aria-label="源码内容"></pre><textarea id="editor" class="code-editor" aria-label="编辑源码" spellcheck="false" wrap="off" hidden></textarea>
      </section>
    </section>
    <aside id="tools-panel" aria-label="项目工具" hidden>
      <div id="tools-resize" role="separator" tabindex="0" aria-label="调整右侧面板宽度" aria-orientation="vertical" title="拖动调整右侧面板宽度"></div>
      <section id="build-pane" hidden>
        <div class="compare-tools">
          <input id="build-path" type="hidden" value="">
          <input id="build-phase" type="hidden" value="compile">
          <button id="build-start" title="编译" aria-label="编译" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 4 12 8-12 8z"/></svg></button><button id="build-stop" disabled title="停止编译" aria-label="停止编译" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14v14H5z"/></svg></button>
          <button id="build-projects-refresh" class="icon-button" title="刷新 Maven 项目" aria-label="刷新 Maven 项目">${icon('folder')}</button>
        </div>
        <div id="build-projects" aria-label="Maven 项目树"></div>
        <div id="build-output" hidden aria-label="Maven 输出"></div>
      </section>
      <section id="spring-pane" hidden><div id="spring-panel" aria-label="Spring Boot 启动项目"></div></section>
    </aside>
  </div>
      <dialog id="git-pane" aria-label="分支比较">
        <div class="comparison-heading"><strong>分支比较</strong><button id="compare-close" class="icon-button" title="关闭分支比较" aria-label="关闭分支比较"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
        <div id="diff" aria-label="版本差异"></div>
      </dialog>
  <dialog id="projects-popup" aria-label="历史项目"><div id="projects" aria-label="历史项目列表"></div></dialog>
  <footer id="status" role="status" aria-live="polite">请选择项目目录</footer>`;

const $ = selector => document.querySelector(selector);
let documentFile;
const openFiles = [];
let busy = false;
let toolView = 'build';
const editor = setupEditor(() => documentFile, status);
const refreshSpring = setupSpring();

function status(message, error = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
}

async function run(action) {
  if (busy) {
    return;
  }
  busy = true;
  $('#app').setAttribute('aria-busy', 'true');
  status('读取中…');
  try {
    await action();
  } catch (error) {
    status(error.message, true);
  } finally {
    busy = false;
    $('#app').setAttribute('aria-busy', 'false');
  }
}

// Tool navigation only changes the right panel, keeping the current editor mounted.
function mode(view, refresh = true) {
  if (view !== 'source') {
    toolView = view;
  }
  const label = view === 'source' ? '显示右侧区域' : '隐藏右侧区域';
  $('#tools-toggle').title = label;
  $('#tools-toggle').setAttribute('aria-label', label);
  $('#tools-toggle').setAttribute('aria-expanded', String(view !== 'source'));
  $('#tools-panel').hidden = view === 'source';
  if (view === 'source') {
    closeSideDialog($('#git-branches'));
  }
  if (view !== 'source' && refresh) {
    document.dispatchEvent(new CustomEvent('coding:tool', { detail: view }));
  }
  for (const name of ['build', 'spring']) {
    $(`#${name}-pane`).hidden = name !== view;
    $(`#${name}-tab`)?.setAttribute('aria-pressed', String(name === view));
  }
}

async function list(path = '', container = $('#files')) {
  const result = await invoke('list', { path, compact: true });
  container.replaceChildren(...result.entries.map(entry => {
    const row = document.createElement('div');
    row.className = 'file-row';
    const button = document.createElement('button');
    button.innerHTML = entry.directory ? icon('chevron') + icon('folder') : icon(fileIcon(entry.path));
    const label = document.createElement('span');
    label.className = entry.directory ? 'directory-name' : `file-${fileType(entry.path)}`;
    label.textContent = entry.name;
    button.append(label);
    button.title = entry.path;
    row.append(button);
    if (entry.directory) {
      const children = document.createElement('div');
      children.className = 'directory-children';
      children.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      button.addEventListener('click', () => run(async () => {
        if (children.hidden && !children.childElementCount) {
          await list(entry.path, children);
        }
        children.hidden = !children.hidden;
        button.setAttribute('aria-expanded', String(!children.hidden));
        status(`${entry.path} 已${children.hidden ? '收起' : '展开'}`);
      }));
      row.append(children);
    } else {
      button.addEventListener('click', () => run(() => read(entry.path)));
    }
    return row;
  }));
  if (result.truncated) {
    const notice = document.createElement('p');
    notice.textContent = '仅显示前 2000 项，请选择更小的目录';
    container.append(notice);
  }
  status(result.truncated ? '目录内容已截断' : `${result.entries.length} 项`);
}

const fileKey = file => JSON.stringify([file.path, file.revision || '']);

function rememberPosition() {
  const tab = documentFile && openFiles.find(item => fileKey(item) === fileKey(documentFile));
  if (tab) {
    const input = $('#editor').hidden ? $('#source') : $('#editor');
    tab.startLine = documentFile.startLine;
    tab.position = { top: input.scrollTop, left: input.scrollLeft, start: input.selectionStart, end: input.selectionEnd };
  }
}

function renderFileTabs() {
  $('#file-tabs').replaceChildren(...openFiles.map(file => {
    const row = document.createElement('div');
    row.className = 'file-tab';
    const button = document.createElement('button');
    button.role = 'tab';
    button.textContent = `${file.path.split('/').at(-1)}${file.revision ? ` @ ${file.revision.slice(0, 8)}` : ''}`;
    button.title = `${file.path}${file.revision ? ` @ ${file.revision}` : ''}`;
    button.setAttribute('aria-selected', String(!!documentFile && fileKey(file) === fileKey(documentFile)));
    button.onclick = () => run(() => read(file.path, undefined, file.revision));
    const close = document.createElement('button');
    close.className = 'icon-button';
    close.title = close.ariaLabel = `关闭 ${button.textContent}`;
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';
    close.onclick = () => run(() => closeFileTab(file));
    row.append(button, close);
    return row;
  }));
}

async function closeFileTab(file) {
  const active = documentFile && fileKey(file) === fileKey(documentFile);
  if (active && !await editor.canLeave()) {
    return;
  }
  const index = openFiles.indexOf(file);
  if (active && openFiles.length > 1) {
    const next = openFiles[index + 1] || openFiles[index - 1];
    // Keep the current tab available if loading its replacement fails.
    if (!await read(next.path, undefined, next.revision)) {
      return;
    }
  } else if (active) {
    documentFile = undefined;
    editor.reset();
    $('#source').replaceChildren();
    for (const id of ['symbol', 'definition-search']) {
      $(`#${id}`).disabled = true;
    }
    $('#definitions').replaceChildren();
    $('#definitions').hidden = true;
  }
  openFiles.splice(index, 1);
  renderFileTabs();
}

function showSource(file) {
  documentFile = file;
  if (!openFiles.some(item => fileKey(item) === fileKey(file))) {
    openFiles.push({ path: file.path, revision: file.revision, startLine: file.startLine });
  }
  renderFileTabs();
  $('#source').replaceChildren(...sourceLines(file));
  const java = file.path.endsWith('.java') && !file.revision;
  $('#symbol').disabled = !java;
  $('#definition-search').disabled = !java;
  if (!java) {
    $('#definitions').replaceChildren();
    $('#definitions').hidden = true;
  }
  editor.update();
  mode('source');
  status(file.revision ? '历史版本，只读' : '本地文件');
}

async function read(path, startLine, revision) {
  if (!await editor.canLeave()) {
    return false;
  }
  rememberPosition();
  const tab = openFiles.find(item => fileKey(item) === fileKey({ path, revision }));
  const position = startLine === undefined ? tab?.position : undefined;
  const file = await invoke(revision ? 'show' : 'read', { path, startLine: startLine ?? tab?.startLine ?? 1, ...(revision ? { revision } : {}) });
  editor.reset();
  showSource(file);
  await editor.open();
  if (position) {
    const input = $('#editor').hidden ? $('#source') : $('#editor');
    if (!$('#editor').hidden) {
      input.setSelectionRange(position.start, position.end);
    }
    input.scrollTop = position.top;
    input.scrollLeft = position.left;
  }
  return true;
}

/* saved pages are refreshed without navigating away from the draft. */
document.addEventListener('coding:saved', async event => {
  try {
    const file = await invoke('read', { path: event.detail, startLine: documentFile.startLine });
    if (documentFile?.path === event.detail && !documentFile.revision) {
      $('#source').replaceChildren(...sourceLines(file));
      documentFile = file;
    }
  } catch (error) {
    status(error.message, true);
  }
});

async function findDefinitions(name) {
  $('#symbol').value = name;
  const result = await invoke('definitions', { name });
  $('#definitions').hidden = false;
  const heading = document.createElement('p');
  heading.textContent = `${name}：${result.candidates.length} 个定义候选${result.truncated ? `；${result.reason}` : ''}`;
  $('#definitions').replaceChildren(heading, ...result.candidates.map(candidate => {
    const button = document.createElement('button');
    button.textContent = `${candidate.kind === 'class' ? '类' : '方法'}  ${candidate.path}:${candidate.line}  ${candidate.text}`;
    button.title = button.textContent;
    button.addEventListener('click', () => run(async () => {
      await read(candidate.path, candidate.line);
      $('#source .source-line')?.classList.add('definition-target');
      $('#source').scrollTop = 0;
      $('#source').scrollLeft = 0;
    }));
    return button;
  }));
  status(heading.textContent);
}

function showProjects(selected) {
  $('#projects').replaceChildren(...(selected.history || []).map(root => {
    const button = document.createElement('button');
    button.textContent = root.split('/').filter(Boolean).at(-1) || root;
    button.title = root;
    button.setAttribute('aria-pressed', String(root === selected.root));
    button.onclick = () => run(async () => {
      await selectProject(root);
      closeSideDialog($('#projects-popup'));
    });
    return button;
  }));
}

async function selectProject(root) {
  if (!await editor.canLeave()) {
    return;
  }
  const selected = await invoke('select', { root });
  $('#root').textContent = selected.root;
  $('#root').title = selected.root;
  openFiles.length = 0;
  documentFile = undefined;
  renderFileTabs();
  editor.reset();
  $('#source').replaceChildren();
  $('#definitions').replaceChildren();
  $('#definitions').hidden = true;
  $('#symbol').value = '';
  $('#symbol').disabled = true;
  $('#definition-search').disabled = true;
  closeSideDialog($('#git-pane'));
  $('#diff').replaceChildren();
  $('#matches').replaceChildren();
  mode('source');
  document.dispatchEvent(new Event('coding:workspace'));
  showProjects(selected);
  await list();
}

$('#folder').addEventListener('click', () => run(async () => {
  const root = await request('host.chooseDirectory', []);
  if (root) {
    await selectProject(root);
  }
}));
// Keep mounted panels and editor drafts when hiding either side.
$('#projects-toggle').onclick = () => {
  const sidebar = $('.project-sidebar');
  sidebar.hidden = !sidebar.hidden;
  const label = sidebar.hidden ? '显示左侧区域' : '隐藏左侧区域';
  $('#projects-toggle').title = label;
  $('#projects-toggle').setAttribute('aria-label', label);
  $('#projects-toggle').setAttribute('aria-expanded', String(!sidebar.hidden));
};
$('#tools-toggle').onclick = () => mode($('#tools-panel').hidden ? toolView : 'source');
$('#projects-history').onclick = () => {
  const popup = $('#projects-popup');
  if (popup.matches(':popover-open')) {
    closeSideDialog(popup);
  } else {
    showSideDialog(popup, $('#projects-history'));
  }
};
$('#refresh').addEventListener('click', () => run(() => list()));
$('#definition-search').addEventListener('click', () => run(() => findDefinitions($('#symbol').value.trim())));
$('#source').addEventListener('dblclick', event => {
  const name = event.target.dataset.symbol;
  if (name) {
    run(() => findDefinitions(name));
  }
});
$('#editor').addEventListener('dblclick', event => {
  if (documentFile?.path.endsWith('.java')) {
    const input = event.target;
    const name = input.value.slice(input.selectionStart, input.selectionEnd).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) {
      run(() => findDefinitions(name));
    }
  }
});
// Clicking the active tool collapses the right panel without discarding its tasks.
for (const view of ['build', 'spring']) {
  $(`#${view}-tab`).addEventListener('click', () => mode($(`#${view}-pane`).hidden ? view : 'source'));
}
document.addEventListener('coding:compare', event => {
  void run(() => compare(event.detail));
});
setupToolsResize();
setupMaven();
setupGitManagement(async () => {
  if (editor.dirty()) {
    status('Git 已改变文件，请保留草稿；保存时将校验外部修改', true);
    return;
  }
  // Git can replace or remove the displayed file; never leave stale source on screen.
  documentFile = undefined;
  renderFileTabs();
  editor.reset();
  $('#source').replaceChildren();
  closeSideDialog($('#git-pane'));
  $('#diff').replaceChildren();
  $('#symbol').disabled = true;
  $('#definition-search').disabled = true;
  $('#definitions').replaceChildren();
  $('#definitions').hidden = true;
  await list();
}, async () => {
  if (!await editor.canLeave()) {
    return false;
  }
  editor.reset();
  return true;
}, status);
// Sandbox frames intentionally lack allow-forms; actions use the host RPC bridge instead.
$('#search').addEventListener('click', () => {
  run(async () => {
    const result = await invoke('search', { query: $('#query').value });
    $('#matches').replaceChildren(...result.matches.map(match => {
      const button = document.createElement('button');
      button.textContent = `${match.path}:${match.line}  ${match.text}`;
      button.title = button.textContent;
      button.addEventListener('click', () => run(() => read(match.path, match.line)));
      return button;
    }));
    status(`${result.matches.length} 处匹配${result.truncated ? `；${result.reason}` : ''}`);
  });
});
// Branch actions supply the comparison range; the popup contains only categorized changes.
async function compare({ base, target }) {
  showSideDialog($('#git-pane'), $('#git-tab'), { placement: 'center' });
  $('#diff').replaceChildren();
  const diff = await invoke('diff', { base, target, summary: true });
  $('#diff').replaceChildren(...renderDiff(diff, file => invoke('diff', { base: diff.base, target: diff.target, path: file.path })));
  $('#diff').scrollIntoView({ block: 'nearest' });
  status(diff.files.length ? `${diff.files.length} 个变更文件：新增 ${diff.files.filter(file => file.status === 'A').length}，删除 ${diff.files.filter(file => file.status === 'D').length}，修改 ${diff.files.filter(file => !['A', 'D'].includes(file.status)).length}；不含未跟踪文件` : '所选范围没有差异；不含未跟踪文件');
}
$('#compare-close').onclick = () => closeSideDialog($('#git-pane'));
for (const [input, action] of [['query', 'search'], ['symbol', 'definition-search']]) {
  $(`#${input}`).addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      $(`#${action}`).click();
    }
  });
}

run(async () => {
  const selected = await invoke('workspace');
  showProjects(selected);
  if (selected.root) {
    refreshSpring();
    $('#root').textContent = selected.root;
    $('#root').title = selected.root;
    document.dispatchEvent(new Event('coding:workspace'));
    await list();
  } else {
    status(selected.error || '请选择项目目录', !!selected.error);
  }
});

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    mode('source');
    $('.definition-tools').hidden = false;
    $('#symbol').disabled = false;
    $('#definition-search').disabled = false;
    $('#symbol').focus();
    $('#symbol').select();
  } else if (event.key === 'Escape') {
    $('.definition-tools').hidden = true;
    $('#definitions').hidden = true;
  }
});

// One shared width serves all tools; pointer capture keeps dragging reliable over the editor.
function setupToolsResize() {
  const layout = $('.workspace');
  const panel = $('#tools-panel');
  const handle = $('#tools-resize');
  let drag;
  const resize = width => {
    const maximum = Math.max(240, layout.clientWidth - 180);
    const value = Math.max(240, Math.min(width, maximum));
    layout.style.setProperty('--tools-width', `${value}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(value)));
  };
  handle.onpointerdown = event => {
    if (event.button !== 0) {
      return;
    }
    drag = { x: event.clientX, width: panel.offsetWidth };
    handle.setPointerCapture(event.pointerId);
    layout.classList.add('tools-resizing');
    event.preventDefault();
  };
  handle.onpointermove = event => {
    if (drag && handle.hasPointerCapture(event.pointerId)) {
      resize(drag.width + drag.x - event.clientX);
    }
  };
  handle.onlostpointercapture = () => {
    drag = null;
    layout.classList.remove('tools-resizing');
  };
  handle.onkeydown = event => {
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      resize(panel.offsetWidth + (event.key === 'ArrowLeft' ? 20 : -20));
    }
  };
}

import { showPopup } from '../../../../desk/src/resource/popup.js';
import '../../../../desk/src/resource/controls.css';
import './app.css';
import { invoke, request, escape } from './bridge.js';
import { formatText } from './format.js';
import { renderPreview } from './preview.js';
import { setupDiagramViewer } from './diagram-viewer.js';
import { setupSidebar } from './sidebar.js';
import { setupFileMenu, confirmFileAction, copyFileReference } from './file-menu.js';
import { setupOutline } from './outline.js';
import { setupSearch } from './search.js';
import { setupFileGroups } from './file-groups.js';
import { setupScrollSync } from './scroll-sync.js';
import { fileLabel } from './file-label.js';
import { setupSyntaxHighlight } from './syntax-highlight.js';
import { setupLineNumbers } from './line-numbers.js';

const $ = selector => document.querySelector(selector);
const editor = $('#editor');
const updateSyntaxHighlight = setupSyntaxHighlight(editor);
const updateLineNumbers = setupLineNumbers(editor);
const closeDiagramViewer = setupDiagramViewer($('#preview'));
const updateOutline = setupOutline($('#panes'));
const updateSearch = setupSearch($('#panes'));
let documentState = { id: null, path: null, revision: null, root: null, name: '', type: 'md' };
let saved = '';
let generation = 0;
let previewTimer;
let draftQueue = Promise.resolve();
const client = crypto.randomUUID();
const fileCall = (method, ...args) => invoke(`editor.${method}`, client, ...args);
const type = () => documentState.type;
setupScrollSync($('#panes'), () => documentState.id && type() === 'md' && $('#panes').dataset.mode === 'split'
  && !document.body.dataset.presenting);
const dirty = () => Boolean(documentState.id && (!documentState.path || editor.value !== saved));
setupSidebar();
const fileGroups = setupFileGroups({ action, openFile, highlight: highlightCurrentFile });

function status(text, error = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', error);
}
async function action(work) {
  try { await work(); }
  catch (error) { status(error.message, true); console.error('[text-editor]', { pluginId: 'text-editor', documentId: documentState.id }, error); }
}

function update() {
  updateSyntaxHighlight(documentState);
  updateLineNumbers();
  highlightCurrentFile();
  $('#panes').hidden = !documentState.id;
  $('#document-name').textContent = documentState.name.split('/').pop();
  $('#dirty').textContent = dirty() ? '未保存' : '';
  $('#position').textContent = documentState.id ? `${editor.value.split('\n').length} 行 · ${editor.value.length} 字符` : '';
  ['save', 'save-as', 'present'].forEach(id => { $(`#${id}`).disabled = !documentState.id; });
  $('#format').disabled = !documentState.id || !['json', 'jsonc', 'yaml', 'xml'].includes(type());
  const supported = ['md', 'puml'].includes(type());
  document.querySelectorAll('[data-mode]').forEach(button => {
    if (button.tagName === 'BUTTON') { button.disabled = !documentState.id || (!supported && button.dataset.mode !== 'edit'); }
  });
  if (!supported) { setMode('edit'); }
  updateOutline(documentState);
  updateSearch(documentState);
  preview();
}

function setMode(mode) {
  $('#panes').dataset.mode = mode;
  document.querySelectorAll('button[data-mode]').forEach(button => button.classList.toggle('selected', button.dataset.mode === mode));
  updateSearch(documentState);
  preview();
}
function preview() {
  closeDiagramViewer();
  const token = ++generation;
  clearTimeout(previewTimer);
  if (!documentState.id) {
    $('#preview').replaceChildren();
    return;
  }
  if ($('#panes').dataset.mode === 'edit' && !document.body.dataset.presenting) { return; }
  previewTimer = setTimeout(() => action(() => {
    if (['md', 'puml'].includes(type())) {
      return renderPreview($('#preview'), editor.value, type(), () => token === generation);
    }
    // Plain text must retain whitespace without being interpreted as document markup.
    const text = document.createElement('pre');
    text.className = 'plain-text';
    text.textContent = editor.value;
    $('#preview').replaceChildren(text);
  }), 280);
}

// Fullscreen the body so the existing diagram dialog remains available during presentation.
$('#present').onclick = () => action(async () => {
  closeDiagramViewer();
  await document.body.requestFullscreen();
  document.body.dataset.presenting = 'true';
  $('#exit-presentation').hidden = false;
  $('#exit-presentation').focus();
  $('#preview').scrollTop = 0;
  preview();
  console.info('[text-editor:presentation-open]', { pluginId: 'text-editor', documentId: documentState.id, type: type() });
});
function exitPresentation() {
  console.info('[text-editor:presentation-exit]', { pluginId: 'text-editor', documentId: documentState.id });
  return document.exitFullscreen();
}
$('#exit-presentation').onclick = () => action(exitPresentation);
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement || !document.body.dataset.presenting) { return; }
  delete document.body.dataset.presenting;
  $('#exit-presentation').hidden = true;
  $('#present').focus();
  updateSearch(documentState);
  preview();
  console.info('[text-editor:presentation-close]', { pluginId: 'text-editor', documentId: documentState.id });
});

// Each draft has its own identifier; windows cannot replace another window's unfinished work.
function persistDraft() {
  if (!documentState.id) { return draftQueue; }
  // A clean document only needs its old draft cleared; sending its text can block file switching.
  const draft = dirty() ? { ...documentState, text: editor.value, saved } : { id: documentState.id, remove: true };
  draftQueue = draftQueue.catch(() => {}).then(() => invoke('editor.draft', draft)).then(refreshDrafts);
  draftQueue.catch(error => {
    status(`草稿保存失败：${error.message}`, true);
    console.error('[text-editor:draft]', { pluginId: 'text-editor', documentId: draft.id }, error);
  });
  return draftQueue;
}

// Drafts share file labels with saved documents but never enter the disk-file organization model.
async function refreshDrafts() {
  const drafts = await invoke('editor.drafts', { metadata: true });
  $('#draft-list').innerHTML = drafts.sort((a, b) => b.updated - a.updated).map(draft => {
    const path = draft.path && draft.root ? `${draft.root}/${draft.path}`.replace(/\/+/g, '/') : draft.name;
    return `<div class="draft"><button data-id="${escape(draft.id)}" aria-label="${escape(draft.name)}" title="${escape(path)}">${fileLabel(draft.name)}</button><button data-remove="${escape(draft.id)}" title="删除草稿" aria-label="删除草稿" class="icon-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/></svg></button></div>`;
  }).join('') || '<p>暂无未保存草稿</p>';
  highlightCurrentFile();
}

function highlightCurrentFile() {
  const current = documentState.path && `${documentState.root}/${documentState.path}`.replace(/\/+/g, '/');
  document.querySelectorAll('#history button[data-path], #group-files button[data-path]').forEach(button => {
    const path = `${button.dataset.root}/${button.dataset.path}`.replace(/\/+/g, '/');
    button.setAttribute('aria-current', path === current ? 'page' : 'false');
  });
  document.querySelectorAll('#draft-list button[data-id]').forEach(button => {
    button.setAttribute('aria-current', button.dataset.id === documentState.id ? 'page' : 'false');
  });
}

function detect(name) {
  const extension = name.split('.').pop().toLowerCase();
  return ({ markdown: 'md', jsonc: 'json', yml: 'yaml', plantuml: 'puml' })[extension] ||
    (['md', 'txt', 'json', 'xml', 'yaml', 'sql', 'puml'].includes(extension) ? extension : 'txt');
}

// Existing files can use preview-only formats that are no longer offered when creating documents.
function selectDocumentType(value) {
  const select = $('#type');
  select.value = value;
  if (!select.value) {
    select.value = 'txt';
  }
}

async function showHistory() {
  await fileGroups.refreshHistory();
  await fileGroups.refresh();
  await refreshDrafts();
}

setupFileMenu(button => ({ button, root: button.dataset.root, path: button.dataset.path,
  name: button.dataset.path.split('/').pop() }),
  (method, file) => action(async () => {
    if (method === 'copyFile') {
      copyFileReference(file);
      status('已复制文件，可粘贴到 Agent 会话');
      return;
    }
    const name = method === 'removeHistory' ? true : await confirmFileAction(method, file);
    if (!name) { return; }
    const current = documentState.path
      && `${documentState.root}/${documentState.path}`.replace(/\/+/g, '/') === `${file.root}/${file.path}`.replace(/\/+/g, '/');
    // A current document can close only after its unfinished text is safely stored.
    if (method !== 'removeHistory' || (current && dirty())) {
      await persistDraft();
    }
    const result = await invoke(`editor.${method}`, { root: file.root, path: file.path }, name);
    if (current) {
      if (method === 'removeHistory') {
        documentState = { id: null, path: null, revision: null, root: documentState.root, name: '', type: 'md' };
        editor.value = '';
        saved = '';
      } else if (method === 'renameFile') {
        const path = [...documentState.path.split('/').slice(0, -1), result.name].join('/');
        documentState = { ...documentState, path, name: path, type: detect(path) };
      } else {
        // Retain the editor and its text as a new draft, detached from the deleted file.
        documentState = { ...documentState, path: null, revision: null, name: file.name };
        saved = '';
      }
      if (method !== 'removeHistory') {
        await persistDraft();
      }
      update();
    }
    await showHistory();
    status(result?.organizationWarning || ({ renameFile: '已重命名', removeHistory: '已移除记录 · 文件仍保留', deleteFile: '已删除文件 · 未保存内容保留为草稿' })[method], Boolean(result?.organizationWarning));
  }));

// Naming belongs to creating a document or a saved copy, never to editing an opened file.
function chooseDocument(title, defaults = documentState) {
  const dialog = $('#document-dialog');
  $('#document-dialog-title').textContent = title;
  $('#filename').value = defaults.name;
  selectDocumentType(defaults.type);
  dialog.returnValue = '';
  showPopup(dialog);
  $('#filename').select();
  return new Promise(resolve => dialog.addEventListener('close', () => {
    resolve(dialog.returnValue === 'confirm' ? { name: $('#filename').value.trim(), type: $('#type').value } : null);
  }, { once: true }));
}
// The plugin sandbox blocks native form submission, including its submit event.
$('#confirm-document').onclick = () => {
  if (!$('#document-form').reportValidity() || !$('#filename').value.trim()) { return; }
  $('#document-dialog').close('confirm');
};
$('#filename').onkeydown = event => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    $('#confirm-document').click();
  }
};
$('#cancel-document').onclick = () => $('#document-dialog').close();

async function openFile(path, root, initialMode) {
  await persistDraft();
  const groupId = fileGroups.active();
  const file = await fileCall('openDocument', { path, cwd: root, groupId }).catch(async error => {
    // Refresh missing entries without replacing the current document or hiding the original open error.
    await fileGroups.refresh();
    throw error;
  });
  documentState = { id: crypto.randomUUID(), path: file.path, revision: file.revision, root: file.root,
    name: file.path, type: detect(file.path) };
  editor.value = file.text;
  saved = file.text;
  update();
  // Apply the launch mode before history requests yield, so a later user choice is not overwritten.
  if (initialMode && ['md', 'puml'].includes(type())) {
    setMode(initialMode);
  }
  await showHistory();
  fileGroups.select(documentState);
  status(file.organizationWarning || '已打开 · UTF-8', Boolean(file.organizationWarning));
}
async function save(as = false) {
  if (!documentState.id) { return; }
  const destination = as ? await chooseDocument('另存为') : documentState;
  if (!destination) { return; }
  const root = as ? await request('host.chooseDirectory', { title: '另存为：选择目录', showHiddenFiles: true }) : documentState.root;
  if (as && !root) { return; }
  const documentId = documentState.id;
  const snapshot = editor.value;
  const result = await fileCall('save', { path: destination.name, text: snapshot, root, desktop: !as && !documentState.path,
    revision: as || !documentState.path ? null : documentState.revision, groupId: fileGroups.active() });
  // Large saves can finish after another document opens; keep that document's text and save metadata intact.
  if (documentState.id !== documentId) {
    await showHistory();
    return;
  }
  documentState = { ...documentState, name: destination.name, type: destination.type, path: result.path, root: result.root, revision: result.revision };
  saved = snapshot;
  await persistDraft();
  await showHistory();
  fileGroups.select(documentState);
  update();
  status(result.organizationWarning || '已保存 · 本地文件', Boolean(result.organizationWarning));
}

// Use the existing document-opening path so direct selection preserves drafts and file boundaries.
async function chooseFile() {
  try {
    const path = await request('host.chooseFile', { title: '打开文本文件', extensions: [], showHiddenFiles: true });
    if (path) {
      await openFile(path, '/');
      console.info('[text-editor:file-open]', { pluginId: 'text-editor', documentId: documentState.id, path });
    }
  } catch (error) {
    console.error('[text-editor:file-open]', { pluginId: 'text-editor', documentId: documentState.id }, error);
    throw error;
  }
}
$('#open').onclick = () => action(chooseFile);
$('#new').onclick = () => action(async () => {
  const destination = await chooseDocument('新建文件', { name: '未命名.md', type: 'md' });
  if (!destination) { return; }
  await persistDraft();
  documentState = { id: crypto.randomUUID(), path: null, revision: null, root: null, ...destination };
  editor.value = '';
  saved = '';
  update();
  fileGroups.selectDraft();
  $('#draft-group').open = true;
  editor.focus();
  await persistDraft();
  status('新建文件 · 已存草稿');
});
$('#save').onclick = () => action(() => save());
$('#save-as').onclick = () => action(() => save(true));
$('#format').onclick = () => action(async () => {
  const formatted = formatText(editor.value, type());
  editor.focus();
  editor.select();
  // insertText preserves the textarea undo stack; a failed formatter never edits the source.
  document.execCommand('insertText', false, formatted);
  update();
  await persistDraft();
  status('已格式化 · 尚未写入文件');
});
editor.addEventListener('input', () => { update(); persistDraft(); });
editor.addEventListener('keydown', event => {
  if (event.key === 'Tab') {
    event.preventDefault();
    document.execCommand('insertText', false, '  ');
  }
});
$('#filename').oninput = () => selectDocumentType(detect($('#filename').value));
$('#type').onchange = () => {
  const name = $('#filename').value;
  $('#filename').value = `${name.replace(/\.[^./]+$/, '')}.${$('#type').value}`;
};
$('#font-size').oninput = () => document.documentElement.style.setProperty('--editor-size', `${Math.max(10, Math.min(28, Number($('#font-size').value) || 14))}px`);
document.querySelectorAll('button[data-mode]').forEach(button => { button.onclick = () => setMode(button.dataset.mode); });
window.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    action(chooseFile);
    return;
  }
  if (event.key === 'Escape' && document.body.dataset.presenting && !$('#diagram-viewer').open) {
    event.preventDefault();
    action(exitPresentation);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    action(() => save(event.shiftKey));
  }
});
window.addEventListener('editor-theme', preview);
$('#draft-list').onclick = event => action(async () => {
  const button = event.target.closest('button');
  if (!button) { return; }
  await draftQueue;
  if (button.dataset.remove) {
    await invoke('editor.draft', { id: button.dataset.remove, remove: true });
    if (documentState.id === button.dataset.remove) {
      documentState = { id: null, path: null, revision: null, root: null, name: '', type: 'md' };
      editor.value = '';
      saved = '';
      update();
    }
    await refreshDrafts();
    status('已删除草稿');
    return;
  }
  if (button.dataset.id === documentState.id) {
    editor.focus();
    return;
  }
  await persistDraft();
  const draft = (await invoke('editor.drafts')).find(entry => entry.id === button.dataset.id);
  if (!draft) { throw Error('草稿已被删除'); }
  // Replace the stored entry only after this window's independent copy is safely persisted.
  documentState = { ...draft, id: crypto.randomUUID(), type: detect(draft.name) };
  saved = draft.saved;
  editor.value = draft.text;
  fileGroups.selectDraft();
  update();
  await persistDraft();
  await invoke('editor.draft', { id: draft.id, remove: true });
  await refreshDrafts();
  console.info('[text-editor:draft-restore]', { pluginId: 'text-editor', documentId: documentState.id, draftId: draft.id });
  status('已恢复草稿 · 保存时仍检测文件冲突');
});
// Use the same file-opening path for startup and retained-window requests so drafts survive each switch.
async function openLaunchContext(launch) {
  if (!launch?.path) {
    return;
  }
  await openFile(launch.path, launch.cwd || '/', 'read');
}

let launchQueue = action(async () => {
  const preferences = await request('storage.getPreferences');
  document.documentElement.dataset.theme = preferences.theme;
  await showHistory();
  await openLaunchContext(await request('host.getLaunchContext'));
  update();
});
window.addEventListener('editor-launch', event => {
  // Serialize requests through initialization and file IO; an earlier read must not overwrite the latest file.
  launchQueue = launchQueue.then(() => action(() => openLaunchContext(event.detail)));
});
document.addEventListener('paste', event => {
  // Form fields keep native paste; file references belong to the document area and sidebar.
  if (event.defaultPrevented || (event.target !== editor && event.target.closest('input, textarea, [contenteditable="true"]'))) {
    return;
  }
  const clipboard = event.clipboardData;
  const references = clipboard.getData('text/uri-list').split(/\r?\n/).map(uri => uri.trim()).filter(uri => uri.startsWith('file:'));
  if (!clipboard.types.includes('Files') && !references.length) {
    return;
  }
  event.preventDefault();
  launchQueue = launchQueue.then(() => action(async () => {
    // Sandboxed frames receive Finder File names without paths, so use the host's native clipboard reader.
    const paths = references.length ? references.map(uri => {
      const url = new URL(uri);
      if (url.host || url.search || url.hash) {
        throw Error('只支持粘贴本地文件');
      }
      return decodeURIComponent(url.pathname);
    }) : await request('host.readClipboardFiles');
    if (!paths.length) {
      throw Error('剪贴板中没有可直接打开的本地文件');
    }
    for (const path of new Set(paths)) {
      console.info('[text-editor:paste-file]', { pluginId: 'text-editor', path });
      await openFile(path, '/');
    }
  }));
});
await launchQueue;

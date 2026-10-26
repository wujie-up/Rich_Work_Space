import './app.css';
import { invoke, request, escape } from './bridge.js';
import { formatText } from './format.js';
import { renderPreview } from './preview.js';

const $ = selector => document.querySelector(selector);
const editor = $('#editor');
let documentState = { id: crypto.randomUUID(), path: null, revision: null, root: null };
let saved = '';
let listing;
let generation = 0;
let previewTimer;
let draftQueue = Promise.resolve();
const client = crypto.randomUUID();
const fileCall = (method, ...args) => invoke(`editor.${method}`, client, ...args);
const type = () => $('#type').value;
const dirty = () => editor.value !== saved;

function status(text, error = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', error);
}
async function action(work) {
  try { await work(); }
  catch (error) { status(error.message, true); console.error('[text-editor]', error.message); }
}

function update() {
  $('#dirty').textContent = dirty() ? '未保存' : '';
  $('#position').textContent = `${editor.value.split('\n').length} 行 · ${editor.value.length} 字符`;
  $('#format').disabled = !['json', 'jsonc', 'yaml', 'xml'].includes(type());
  const supported = ['md', 'puml'].includes(type());
  document.querySelectorAll('[data-mode]').forEach(button => {
    if (button.tagName === 'BUTTON') { button.disabled = !supported && button.dataset.mode !== 'edit'; }
  });
  if (!supported) { setMode('edit'); }
  preview();
}

function setMode(mode) {
  $('#panes').dataset.mode = mode;
  document.querySelectorAll('button[data-mode]').forEach(button => button.classList.toggle('selected', button.dataset.mode === mode));
  preview();
}
function preview() {
  const token = ++generation;
  clearTimeout(previewTimer);
  if ($('#panes').dataset.mode === 'edit') { return; }
  previewTimer = setTimeout(() => action(() => renderPreview($('#preview'), editor.value, type(), () => token === generation)), 280);
}

// Each draft has its own identifier; windows cannot replace another window's unfinished work.
function persistDraft() {
  const draft = { ...documentState, name: $('#filename').value, type: type(), text: editor.value, saved, remove: !dirty() };
  draftQueue = draftQueue.catch(() => {}).then(() => invoke('editor.draft', draft));
  draftQueue.catch(error => status(`草稿保存失败：${error.message}`, true));
  return draftQueue;
}

async function showDirectory(path = '') {
  listing = await fileCall('list', path);
  $('#files').hidden = false;
  $('#root').textContent = `${listing.root}${path ? `/${path}` : ''}`;
  $('#parent').disabled = !path;
  $('#entries').innerHTML = listing.entries.map(entry => `<button data-path="${escape(entry.path)}" data-directory="${entry.directory}" title="${escape(entry.name)}">${entry.directory ? '▸ ' : ''}${escape(entry.name)}</button>`).join('');
}

async function chooseWorkspace() {
  const directory = await request('host.chooseDirectory');
  if (!directory) { return false; }
  await fileCall('workspace', directory);
  documentState.root = directory;
  await showDirectory();
  return true;
}

function detect(name) {
  const extension = name.split('.').pop().toLowerCase();
  $('#type').value = ({ markdown: 'md', yml: 'yaml', plantuml: 'puml' })[extension] ||
    (['md', 'txt', 'json', 'jsonc', 'xml', 'yaml', 'puml'].includes(extension) ? extension : 'txt');
}
async function openFile(path) {
  await persistDraft();
  const file = await fileCall('read', path);
  documentState = { id: crypto.randomUUID(), path, revision: file.revision, root: listing.root };
  editor.value = file.text;
  saved = file.text;
  $('#filename').value = path;
  detect(path);
  update();
  status('已打开 · UTF-8');
}
async function save(as = false) {
  if (!documentState.root && !await chooseWorkspace()) { return; }
  const name = $('#filename').value.trim();
  if (!name || name === '未命名.md') { throw Error('请在顶部文件名称中填写保存名称'); }
  if (!as && documentState.path && name !== documentState.path) { throw Error('文件名称已改变，请使用“另存为”'); }
  const snapshot = editor.value;
  const result = await fileCall('save', { path: name, text: snapshot,
    revision: as || !documentState.path ? null : documentState.revision });
  documentState.path = name;
  documentState.revision = result.revision;
  saved = snapshot;
  await persistDraft();
  await showDirectory(listing?.path || '');
  update();
  status('已保存 · 本地文件');
}

$('#folder').onclick = () => action(async () => {
  // Keep the old document's directory intact if selecting a different workspace.
  await persistDraft();
  if (await chooseWorkspace()) {
    documentState = { id: crypto.randomUUID(), path: null, revision: null, root: listing.root };
    editor.value = '';
    saved = '';
    $('#filename').value = '未命名.md';
    detect('a.md');
    update();
    status('已打开文件夹，选择左侧文件或新建');
  }
});
$('#entries').onclick = event => action(async () => {
  const button = event.target.closest('button');
  if (!button) { return; }
  await (button.dataset.directory === 'true' ? showDirectory(button.dataset.path) : openFile(button.dataset.path));
});
$('#parent').onclick = () => action(() => showDirectory(listing.path.split('/').slice(0, -1).join('/')));
$('#new').onclick = () => action(async () => {
  await persistDraft();
  documentState = { id: crypto.randomUUID(), path: null, revision: null, root: documentState.root };
  editor.value = '';
  saved = '';
  $('#filename').value = '未命名.md';
  detect('a.md');
  update();
  status('新建文件 · 原文已存草稿');
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
$('#filename').onchange = () => { detect($('#filename').value); update(); persistDraft(); };
$('#type').onchange = () => { update(); persistDraft(); };
$('#font-size').oninput = () => document.documentElement.style.setProperty('--editor-size', `${Math.max(10, Math.min(28, Number($('#font-size').value) || 14))}px`);
document.querySelectorAll('button[data-mode]').forEach(button => { button.onclick = () => setMode(button.dataset.mode); });
window.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    action(() => save(event.shiftKey));
  }
});
window.addEventListener('editor-theme', preview);
$('#drafts').onclick = () => action(async () => {
  await draftQueue;
  const drafts = await invoke('editor.drafts');
  $('#draft-list').hidden = !$('#draft-list').hidden;
  $('#draft-list').innerHTML = drafts.length ? drafts.sort((a, b) => b.updated - a.updated).map(draft =>
    `<div class="draft"><button data-id="${draft.id}">${escape(draft.name)} · ${escape(new Date(draft.updated).toLocaleString())}</button><button data-remove="${draft.id}">删除草稿</button></div>`).join('') : '暂无未保存草稿';
});
$('#draft-list').onclick = event => action(async () => {
  const button = event.target.closest('button');
  if (!button) { return; }
  if (button.dataset.remove) {
    await invoke('editor.draft', { id: button.dataset.remove, remove: true });
    button.closest('.draft').remove();
    return;
  }
  await persistDraft();
  const draft = (await invoke('editor.drafts')).find(entry => entry.id === button.dataset.id);
  if (!draft) { throw Error('草稿已被删除'); }
  // Restore as a copy so another live window retaining this draft remains independent.
  documentState = { ...draft, id: crypto.randomUUID() };
  saved = draft.saved;
  editor.value = draft.text;
  $('#filename').value = draft.name;
  $('#type').value = draft.type;
  if (draft.root) { await fileCall('workspace', draft.root); await showDirectory(); }
  $('#draft-list').hidden = true;
  update();
  await persistDraft();
  status('已恢复草稿副本 · 保存时仍检测文件冲突');
});
await action(async () => {
  const preferences = await request('storage.getPreferences');
  document.documentElement.dataset.theme = preferences.theme;
  const launch = await request('host.getLaunchContext');
  if (launch?.path) {
    const file = await fileCall('openDocument', launch);
    await showDirectory();
    await openFile(file.path);
    if (['md', 'puml'].includes(type())) { setMode('read'); }
  }
  update();
});

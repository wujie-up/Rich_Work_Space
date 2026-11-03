import { pluginHostOrigin } from '../../../../desk/src/resource/plugin-host.js';
import '../../../../desk/src/resource/controls.css';
import './style.css';
import { invoke, request } from './api.js';
import { button, help, options, textCell } from './ui.js';
import { scoreValue, summarize } from '../shared/scores.js';
import { loginControls } from './login-controls.js';
import { currentMonth, filterTasks } from '../shared/month-filter.js';
import { roles, selectedRole } from '../shared/roles.js';

document.querySelector('#app').innerHTML = `
  <section id="login-controls" class="main-login" aria-label="PingCode 登录"></section>
  <form id="search-form" class="toolbar">
    <label class="search-field">人员名称<input id="keywords" autocomplete="off" placeholder="输入姓名或用户名"></label>
    <span id="search-action"></span>
    <label>人员<select id="member" aria-label="人员"><option value="">请先搜索并选择人员</option></select></label>
    <label>角色<select id="role" aria-label="角色"></select></label>
    <label>项目<select id="project" aria-label="项目"></select></label><span id="projects-action"></span>
    <span id="query-action"></span><span id="cancel-action"></span>
  </form>
  <section class="result-controls">
    <span id="help-slot"></span><div id="total" aria-live="polite"></div>
    <label>月份<input id="month" type="month" min="1970-01" max="9999-12"></label>
    <label>时间口径<select id="date-field" aria-label="时间口径"><option value="completedAt">完成时间</option><option value="createdAt">创建时间</option></select></label>
    <label>状态<select id="state" aria-label="状态"><option value="">全部状态</option></select></label>
  </section>
  <p id="status" role="status" aria-live="polite">正在读取连接配置…</p>
  <div class="table-scroll" tabindex="0" aria-label="任务列表"><table>
    <thead><tr><th>编号</th><th>标题</th><th>项目</th><th id="role-heading">负责人</th><th>状态</th><th id="date-heading">完成时间</th><th>任务价值分</th><th>操作</th></tr></thead>
    <tbody></tbody></table></div>`;

const get = id => document.getElementById(id);
get('month').value = currentMonth();
get('role').replaceChildren(...roles.map(row => new Option(row.label, row.id)));
const search = button('search', '搜索人员');
const query = button('query', '查询任务');
const refresh = button('refresh', '刷新项目列表');
const cancel = button('cancel', '取消查询');
for (const [id, node] of [['search-action', search], ['query-action', query], ['projects-action', refresh], ['cancel-action', cancel]]) {
  get(id).append(node);
}
get('help-slot').append(help('统计口径说明',
  '统计完整分页结果中符合当前状态筛选的工作项。每项按自身任务价值分累计，父子项分别计数；排除已归档及已删除项。'
  + '未填写和无效值不计分，零分有效。包含所有工作项类型，查询范围取决于当前账号或接口授权。'
  + '按所选角色匹配人员，默认负责人，可切换开发负责人或测试负责人。'
  + '网页登录的人员候选来自可见项目的成员。设置更改后需重新查询。'));
get('help-slot').querySelector('[role=tooltip]').append(document.createTextNode(
  '默认按完成时间查询当前月，可切换创建时间；切换月份或时间口径会重新查询。网页登录仅读取所选月份，OpenAPI 在读取分页后筛选。月份按本机时区计算，从月初到下月初；无对应时间的任务不计入该月。清空月份查看全部时间。'));

let config;
let busy = false;
let current;
let generation = 0;
let tasks = [];
let hasResults = false;
let configRead = 0;
const sessionControls = loginControls(get('login-controls'), readConfig);

function message(text, error = false) {
  get('status').textContent = text;
  get('status').dataset.error = String(error);
}

function controls() {
  const ready = config && (config.authMode === 'web' ? config.webSession?.state === 'connected'
    : config.authMode === 'token' ? config.hasAccessToken : config.clientId && config.hasClientSecret);
  get('login-controls').hidden = config?.authMode !== 'web';
  sessionControls.update(config?.webSession, busy, config?.authMode === 'web');
  search.disabled = busy || !ready || !get('keywords').value.trim();
  query.disabled = busy || !ready || !get('member').value;
  refresh.disabled = busy || !ready;
  cancel.disabled = !busy;
  for (const id of ['keywords', 'member', 'project', 'role']) {
    get(id).disabled = busy || !config;
  }
  get('state').disabled = busy || !tasks.length;
  get('month').disabled = busy;
  get('date-field').disabled = busy;
}

function emptyRows(text) {
  const row = document.createElement('tr');
  const cell = textCell(text);
  cell.colSpan = 8;
  row.append(cell);
  document.querySelector('tbody').replaceChildren(row);
}

function clearResults(text = '请搜索并选择人员，选择后自动加载任务。') {
  tasks = [];
  hasResults = false;
  get('total').replaceChildren();
  emptyRows(text);
  options(get('state'), [], '全部状态');
}

function showResults() {
  const dateField = get('date-field').value;
  const filtered = filterTasks(tasks, { month: get('month').value, dateField });
  const result = summarize(filtered, get('state').value);
  get('date-heading').textContent = dateField === 'completedAt' ? '完成时间' : '创建时间';
  const strong = document.createElement('strong');
  strong.textContent = result.total;
  get('total').replaceChildren(document.createTextNode('任务价值分总值 '), strong,
    document.createTextNode(` · ${result.rows.length} 个任务 · ${result.scored} 项有分值 · ${result.missing} 项未填写 · ${result.invalid} 项无效`));
  const fragment = document.createDocumentFragment();
  for (const row of result.rows) {
    const node = document.createElement('tr');
    node.dataset.task = row.id;
    const value = scoreValue(row.score);
    const score = value.kind === 'missing' ? '未填写' : value.kind === 'invalid' ? '无效值' : String(row.score);
    const timestamp = row[dateField];
    const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toLocaleDateString()
      : dateField === 'completedAt' ? '未完成' : '未提供';
    for (const text of [row.number, row.title, row.project, row.assignee, row.state, date, score]) {
      node.append(textCell(text));
    }
    const cell = document.createElement('td');
    const open = button('open', `打开任务 ${row.number}`);
    open.disabled = !row.url;
    open.addEventListener('click', () => request('host.openExternal', [row.url]).catch(error => message(error.message, true)));
    cell.append(open);
    node.append(cell);
    fragment.append(node);
  }
  document.querySelector('tbody').replaceChildren(fragment);
  if (!result.rows.length) {
    emptyRows('当前月份、时间口径和状态下没有匹配任务，请调整筛选条件或清空月份。');
  }
}

function applyConfig(next) {
  if (!config || next.revision !== config.revision) {
    if (config) {
      options(get('member'), [], '请先搜索并选择人员');
      clearResults();
    }
    config = next;
    options(get('project'), next.projectId ? [{ id: next.projectId, label: `默认项目 · ${next.projectId}` }] : [],
      '全部可访问项目', next.projectId);
    message(next.authMode === 'web' ? '登录后输入人员名称，搜索并选择人员。'
      : next.hasAccessToken || (next.clientId && next.hasClientSecret)
        ? '输入人员名称，搜索并选择人员。' : '请先在插件配置中填写 OpenAPI 授权信息。');
  }
  config = { ...config, webSession: next.webSession };
  controls();
}

async function readConfig() {
  const read = ++configRead;
  const next = await invoke('pingcode.settings');
  // A focus-triggered read can finish after a query starts; its preflight owns configuration checks then.
  if (!busy && read === configRead) {
    applyConfig(next);
  }
}

async function run(input, complete) {
  if (busy) {
    return;
  }
  const turn = ++generation;
  busy = true;
  if (input.kind === 'tasks' || input.kind === 'projects') {
    clearResults(input.kind === 'tasks' ? '正在加载任务，请稍候…' : '正在刷新项目选项，请稍候…');
  }
  controls();
  message('正在检查连接配置…');
  let id;
  try {
    const next = await invoke('pingcode.settings');
    if (turn !== generation) {
      return;
    }
    if (!config || next.revision !== config.revision) {
      applyConfig(next);
      message('连接配置已更改，请重新搜索人员并查询。');
      return;
    }
    const started = await invoke('pingcode.start', input);
    id = started.id;
    if (turn !== generation) {
      await invoke('pingcode.cancel', id);
      return;
    }
    current = id;
    for (;;) {
      const state = await invoke('pingcode.status', id);
      if (turn !== generation) {
        return;
      }
      if (state.state === 'complete') {
        const latest = await invoke('pingcode.settings');
        if (turn !== generation) {
          return;
        }
        if (latest.revision !== started.revision) {
          applyConfig(latest);
          message('连接配置已更改，请重新搜索人员并查询。');
          return;
        }
        complete(state.result);
        const label = input.kind === 'tasks' ? `任务查询完成 · ${state.result.length} 个任务（当前查询范围）`
          : input.kind === 'projects' ? `项目选项已更新 · ${state.result.length} 个项目`
            : `人员搜索完成 · ${state.result.length} 位人员`;
        message(`${label} · ${new Date(state.completedAt).toLocaleString()}`);
        return true;
      }
      if (state.state === 'failed') {
        throw Error(state.error.message);
      }
      if (state.state === 'cancelled') {
        message('查询已取消');
        if (!hasResults) {
          emptyRows('查询已取消，请重新查询任务。');
        }
        return;
      }
      const phase = state.progress.phase === 'details' ? '正在读取任务详情' : '正在读取';
      message(`${phase} · ${state.progress.loaded} / ${state.progress.total ?? '待确认'} 条`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    if (turn === generation) {
      message(error.message, true);
      if (!hasResults) {
        emptyRows('加载失败，请查看上方错误并重新查询。');
      }
    }
    if (id) {
      await invoke('pingcode.cancel', id).catch(() => {});
    }
  } finally {
    if (turn === generation) {
      busy = false;
      current = null;
      controls();
    }
  }
}

async function searchPeople(event) {
  event.preventDefault();
  if (search.disabled) {
    return;
  }
  clearResults();
  options(get('member'), [], '搜索中…');
  const succeeded = await run({ kind: 'members', keywords: get('keywords').value.trim() }, rows => {
    options(get('member'), rows.map(row => ({ id: row.id, label: `${row.name} · ${row.username} · ${row.id.slice(-6)}` })),
      rows.length ? '请选择具体人员' : '没有找到匹配人员');
    if (rows.length === 1) {
      get('member').value = rows[0].id;
    }
    emptyRows(rows.length ? '请选择人员，选择后自动加载任务。' : '没有找到匹配人员，请更换姓名或用户名搜索。');
  });
  if (succeeded && get('member').value) {
    await queryTasks();
  }
}
// Sandboxed plugin frames intentionally lack allow-forms; actions use RPC rather than native submission.
search.addEventListener('click', searchPeople);
get('search-form').addEventListener('submit', event => event.preventDefault());
get('keywords').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) {
    searchPeople(event);
  }
});
function queryTasks() {
  get('role-heading').textContent = selectedRole(get('role').value).label;
  if (!get('member').value) {
    clearResults();
    controls();
    return;
  }
  return run({ kind: 'tasks', assigneeId: get('member').value, projectId: get('project').value, role: get('role').value,
    month: get('month').value, dateField: get('date-field').value }, rows => {
    tasks = rows;
    hasResults = true;
    const states = new Map(rows.map(row => [row.stateId, row.state]));
    options(get('state'), [...states].map(([id, label]) => ({ id, label })), '全部状态');
    showResults();
  });
}
query.addEventListener('click', queryTasks);
refresh.addEventListener('click', async () => {
  const succeeded = await run({ kind: 'projects' }, rows => {
    const selected = get('project').value;
    options(get('project'), rows.map(row => ({ id: row.id, label: row.name })), '全部可访问项目', selected);
  });
  if (succeeded) {
    await queryTasks();
  }
});
cancel.addEventListener('click', async () => {
  const turn = ++generation;
  const id = current;
  current = null;
  busy = false;
  if (!hasResults) {
    emptyRows('查询已取消，请重新查询任务。');
  }
  controls();
  try {
    if (id) {
      await invoke('pingcode.cancel', id);
    }
    if (turn === generation) {
      message('查询已取消');
    }
  } catch (error) {
    if (turn === generation) {
      message(error.message, true);
    }
  }
});
get('keywords').addEventListener('input', controls);
for (const id of ['member', 'project', 'role']) {
  get(id).addEventListener('change', () => {
    queryTasks();
  });
}
get('state').addEventListener('change', showResults);
for (const id of ['month', 'date-field']) {
  get(id).addEventListener('change', () => {
    get('date-heading').textContent = get('date-field').value === 'completedAt' ? '完成时间' : '创建时间';
    if (get('member').value) { queryTasks(); }
  });
}
window.addEventListener('focus', () => { if (!busy) { readConfig().catch(error => message(error.message, true)); } });
window.addEventListener('message', event => {
  if (event.source === parent && event.origin === pluginHostOrigin() && event.data?.type === 'desk:visibility'
    && !busy) {
    readConfig().catch(error => message(error.message, true));
  }
});
clearResults();
controls();
readConfig().catch(error => message(error.message, true));

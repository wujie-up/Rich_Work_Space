import { api, el, button, iconButton, field, modal, ask, confirm, toast } from './ui.js';
import { mountTerminal } from './terminal.js';
import { showHistory } from './history.js';
import { sessionStatus } from './session-status.js';

const statusText = { idle: '等待输入', working: '运行中', done: '本轮完成', error: '本轮异常', unknown: '状态不可识别' };
const blockedText = { permission: '等待授权', question: '等待回答', auth: '等待登录' };

function setCollapsed(card, collapsed) {
  if (collapsed && !card.node.classList.contains('collapsed')) {
    card.node.style.height = `${card.node.offsetHeight}px`;
  }
  card.node.classList.toggle('collapsed', collapsed);
  card.collapseButton.setAttribute('aria-expanded', String(!collapsed));
  card.collapseButton.setAttribute('aria-label', collapsed ? '展开' : '折叠');
  card.collapseButton.title = collapsed ? '展开' : '折叠';
}

// The menu overlays sessions instead of taking space away from the terminal canvas.
function workspaceTools(...actions) {
  const menu = el('div', { class: 'workspace-menu', hidden: true }, ...actions);
  const trigger = iconButton('工作台操作', 'more', () => show(menu.hidden));
  trigger.setAttribute('aria-expanded', 'false');
  const tools = el('div', { class: 'workspace-tools' }, trigger, menu);
  const show = (open) => {
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };
  tools.addEventListener('mouseleave', () => show(false));
  tools.addEventListener('focusout', (event) => { if (!tools.contains(event.relatedTarget)) { show(false); } });
  tools.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      trigger.focus();
      show(false);
    }
  });
  menu.addEventListener('click', () => show(false));
  return tools;
}

export async function mountWorkspace(root, { pluginId, adapters }) {
  let disposed = false;
  let layout = await api.storage.getLayout(pluginId);
  let config = await api.storage.getAdapterConfig(pluginId);
  layout = { order: [], sizes: {}, collapsed: [], ...layout };
  const cards = new Map();
  // Fresh windows attach sessions only after an explicit create, restore or fork in this view.
  const selectedSessions = new URLSearchParams(location.search).has('fresh') ? new Set() : null;
  let saveTimer;
  const saveLayout = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api.storage.saveLayout(pluginId, layout).catch((error) => {
      if (!disposed) { toast(error.message); }
    }), 150);
  };
  const windows = el('div', { class: 'windows' });
  const empty = el('div', { class: 'empty workspace-empty' }, el('img', { class: 'empty-symbol', src: '../../ico/icon.svg', alt: '' }),
    el('h2', { text: '为下一件事，打开一个会话' }), el('p', { text: '选择工作目录，让多个 Agent 各自专注。' }),
    iconButton('新建会话', 'create', () => createSession()));
  root.replaceChildren(el('div', { class: 'page-heading' },
    workspaceTools(iconButton('CLI 配置', 'configure', () => configure()),
      iconButton('历史', 'history', () => showHistory(pluginId, adapters, focus)),
      iconButton('新建会话', 'create', () => createSession()))), windows, empty);

  const focus = async (id) => {
    selectedSessions?.add(id);
    update(await api.sessions.list(pluginId));
    layout.collapsed = layout.collapsed.filter((value) => value !== id);
    const card = cards.get(id);
    if (card) {
      setCollapsed(card, false);
      card.node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card.terminal.focus();
      saveLayout();
    }
  };

  async function configure() {
    // Retained views share configuration; refresh it when opening or saving a dialog.
    config = await api.storage.getAdapterConfig(pluginId);
    await modal('CLI 配置', ({ body, actions, finish }) => {
      const inputs = new Map();
      for (const adapter of adapters.filter(adapter => adapter.id !== 'claude')) {
        const value = config[adapter.id] || {};
        const mode = el('select');
        mode.append(el('option', { value: 'managed', text: '受管独立引擎（默认）' }),
          el('option', { value: 'legacy', text: 'Legacy：外部系统 CLI 与原有登录' }));
        mode.value = value.mode || 'managed';
        if (adapter.id === 'codex') {
          body.append(field('Codex 运行模式', mode));
        }
        const command = el('input', { value: value.command || (adapter.id === 'codex' ? 'codex' : ''), placeholder: '可执行文件绝对路径或 PATH 命令名' });
        const args = el('textarea', { rows: 3, spellcheck: false, text: JSON.stringify(value.args || []) });
        body.append(el('h3', { text: adapter.name || adapter.id }), field('可执行文件', command), field('参数（JSON 字符串数组）', args));
        inputs.set(adapter.id, { command, args, mode });
      }
      body.append(el('p', { class: 'muted', text: 'Codex、Claude Code 在插件配置中分别安装、登录，Claude Code 始终使用独立引擎；以下外部命令与参数仅用于 Legacy 模式。命令与参数直接传给进程。参数中的空格和特殊字符不会经过 shell。修改仅影响之后新建的会话。' }));
      actions.append(button('取消', () => finish(null)), button('保存配置', async () => {
        const next = await api.storage.getAdapterConfig(pluginId);
        for (const [id, input] of inputs) {
          const args = JSON.parse(input.args.value);
          if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
            throw Error('参数必须为 JSON 字符串数组');
          }
          next[id] = { ...next[id], command: input.command.value.trim(), args, ...(id === 'codex' ? { mode: input.mode.value } : {}) };
        }
        await api.storage.saveAdapterConfig(pluginId, next);
        config = next;
        console.info('[workspace:config-saved]', { pluginId });
        finish(true);
      }, 'primary'));
    });
  }

  async function createSession() {
    config = await api.storage.getAdapterConfig(pluginId);
    await modal('新建 Agent 会话', ({ body, actions, finish }) => {
      const adapter = el('select', { name: 'adapter' }, ...adapters.map((a) => el('option', { value: a.id, text: a.name || a.id })));
      const name = el('input', { name: 'sessionName', value: `Agent ${cards.size + 1}`, maxlength: 60, required: true });
      const cwd = el('input', { name: 'cwd', value: config.lastCwd || '', placeholder: '/Users/你的名字/项目', required: true });
      const permission = el('select', { name: 'permission' });
      const permissionField = field('权限模式', permission);
      const permissionDescription = el('small', { id: 'permission-description', class: 'muted' });
      permission.setAttribute('aria-describedby', 'permission-description');
      permissionField.append(permissionDescription);
      const describePermission = () => {
        permissionDescription.textContent = permission.selectedOptions[0]?.dataset.description || '';
      };
      permission.addEventListener('change', describePermission);
      const update = () => {
        const selected = adapters.find((a) => a.id === adapter.value);
        permission.replaceChildren(...(selected.permissionModes || []).map((mode) => el('option', {
          value: mode.id || mode, text: mode.label || mode, 'data-description': mode.description || ''
        })));
        describePermission();
        permissionField.hidden = !selected.capabilities.permissions;
      };
      adapter.addEventListener('change', update);
      update();
      body.append(field('Agent', adapter), field('会话名称', name), field('工作目录', el('div', { class: 'input-row' }, cwd,
        button('选择…', async () => { const path = await api.host.chooseDirectory(); if (path) { cwd.value = path; } }))), permissionField);
      actions.append(button('取消', () => finish(null)), button('启动会话', async () => {
        if (!name.reportValidity() || !cwd.reportValidity()) {
          return;
        }
        config = await api.storage.getAdapterConfig(pluginId);
        const selected = adapters.find((a) => a.id === adapter.value);
        if (selected.id === 'custom' && !config.custom?.command) {
          throw Error('请先在“CLI 配置”中设置自定义 CLI 的可执行文件。');
        }
        const created = await api.sessions.create(pluginId, { adapterId: adapter.value, name: name.value, cwd: cwd.value,
          permission: selected.capabilities.permissions ? permission.value : 'default' });
        // Session creation can overlap another view's configuration dialog.
        config = await api.storage.getAdapterConfig(pluginId);
        config.lastCwd = cwd.value;
        await api.storage.saveAdapterConfig(pluginId, config);
        finish(true);
        await focus(created.id);
      }, 'primary'));
    });
  }

  async function showGit(session) {
    const info = await api.sessions.gitInfo(pluginId, session.id);
    if (!info) {
      throw Error('此工作目录不是 Git 仓库，或未找到 git。');
    }
    await modal('切换 Git 分支', ({ body, actions, finish }) => {
      const branches = el('select', { 'aria-label': 'Git 分支' }, ...info.branches.map((name) => el('option',
        { value: name, text: name, selected: name === info.branch })));
      body.append(el('p', { text: info.root }), field(info.detached ? '当前为分离 HEAD' : `当前分支：${info.branch}`, branches),
        el('p', { class: 'muted', text: '切换要求此工作树内所有会话均处于已识别的空闲状态。Git 冲突会直接报错，不覆盖本地修改。' }));
      actions.append(button('取消', () => finish(null)), button('切换', async () => {
        await api.sessions.switchBranch(pluginId, session.id, branches.value);
        finish(true);
      }, 'primary'));
    });
  }

  function makeCard(session) {
    const adapter = adapters.find((a) => a.id === session.adapterId);
    const protocol = adapter?.capabilities.inputProtocol || config[session.adapterId]?.inputProtocol;
    const heading = el('strong', { class: 'session-name', text: session.name });
    const activity = el('span', { class: 'activity' });
    const stateIcon = el('span', { class: 'session-status', role: 'img' });
    const branch = button('⑂ Git', () => showGit(cards.get(session.id).session), 'branch');
    const mount = el('div', { class: 'terminal-mount' });
    const rename = async () => {
      const name = await ask('重命名会话', cards.get(session.id).session.name);
      if (name) { await api.sessions.rename(pluginId, session.id, name); }
    };
    const collapse = () => {
      layout.collapsed = layout.collapsed.includes(session.id) ? layout.collapsed.filter((v) => v !== session.id) : [...layout.collapsed, session.id];
      setCollapsed(card, layout.collapsed.includes(session.id));
      saveLayout();
    };
    const collapseButton = iconButton('折叠', 'collapse', collapse, 'collapse-toggle');
    const actions = el('div', { class: 'card-actions' }, iconButton('改名', 'rename', rename), collapseButton,
      iconButton('关闭', 'close', async () => {
        if (await confirm('关闭会话', `关闭并归档“${cards.get(session.id).session.name}”？`)) {
          await api.sessions.archive(pluginId, session.id);
        }
      }, 'quiet-danger'));
    const handle = el('span', { class: 'drag-handle', 'aria-hidden': 'true' });
    handle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5h1 M15 5h1 M8 12h1 M15 12h1 M8 19h1 M15 19h1"/></svg>';
    const header = el('div', { class: 'session-header' }, handle, heading, stateIcon, activity, actions);
    const footer = el('div', { class: 'session-footer' }, branch, el('span', { class: 'cwd', text: session.cwd, title: session.cwd }));
    const clear = iconButton('清空输入', 'clear', () => card.terminal.clear(), 'input-helper');
    const newline = iconButton('换行', 'newline', () => card.terminal.newline(), 'input-helper');
    newline.title = '换行（Shift+Enter）';
    const fork = iconButton('分叉', 'fork', async () => {
      const name = await ask('分叉上下文', `${cards.get(session.id).session.name} · 分叉`);
      if (name) {
        const created = await api.sessions.fork(pluginId, session.id, name);
        await focus(created.id);
      }
    }, 'input-helper');
    if (protocol === 'codex') { footer.append(clear, newline); }
    if (adapter?.capabilities.fork) { footer.append(fork); }
    const error = el('div', { class: 'session-error', hidden: true });
    const prompt = el('div', { class: 'native-confirmation', hidden: true, role: 'status', text: '需要你的确认 · 请在下方原生界面选择' });
    const content = el('div', { class: 'session-content' }, prompt, mount);
    const node = el('article', { class: 'session', 'data-session': session.id }, header, content, error, footer);
    const size = layout.sizes[session.id];
    if (size) { node.style.width = `${size.width}px`; node.style.height = `${size.height}px`; }
    let dragging;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) { return; }
      dragging = { x: event.clientX, y: event.clientY, moved: false };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', event => {
      if (!dragging) { return; }
      dragging.moved ||= Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) > 5;
      if (!dragging.moved) { return; }
      node.classList.add('dragging');
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.session');
      if (target && target !== node && target.parentElement === windows) {
        const bounds = target.getBoundingClientRect();
        const after = event.clientY > bounds.top + bounds.height / 2
          || Math.abs(bounds.top - node.getBoundingClientRect().top) < 20 && event.clientX > bounds.left + bounds.width / 2;
        windows.insertBefore(node, after ? target.nextSibling : target);
        header.setPointerCapture(event.pointerId);
      }
    });
    header.addEventListener('lostpointercapture', () => {
      node.classList.remove('dragging');
      if (dragging?.moved) {
        layout.order = [...windows.children].map(child => child.dataset.session);
        saveLayout();
      }
      dragging = null;
    });
    windows.append(node);
    const terminal = mountTerminal(mount, { session, protocol });
    const observer = new ResizeObserver(() => {
      // Only manual CSS resizing sets inline dimensions; responsive layout must remain fluid.
      if (node.style.width) {
        layout.sizes[session.id] = { width: parseFloat(node.style.width), height: parseFloat(node.style.height) || node.offsetHeight };
        saveLayout();
      }
    });
    observer.observe(node);
    const card = { node, terminal, observer, heading, activity, stateIcon, prompt, branch, error, clear, newline, fork, collapseButton, session };
    setCollapsed(card, layout.collapsed.includes(session.id));
    return card;
  }

  function update(data) {
    if (disposed || data.pluginId && data.pluginId !== pluginId) {
      return;
    }
    const sessions = data.sessions.filter(session => !selectedSessions || selectedSessions.has(session.id));
    for (const [id, card] of cards) {
      if (!sessions.some((s) => s.id === id)) {
        card.terminal.dispose();
        card.observer.disconnect();
        card.node.remove();
        cards.delete(id);
      }
    }
    for (const session of sessions) {
      if (!cards.has(session.id)) { cards.set(session.id, makeCard(session)); }
      const card = cards.get(session.id);
      card.session = session;
      card.heading.textContent = session.name;
      card.activity.textContent = session.exited ? '已停止 · 待归档' : blockedText[session.blocked] || statusText[session.activity];
      // Running sessions use the status drawing; retain text only for stopped sessions awaiting archival.
      card.activity.hidden = !session.exited;
      card.activity.dataset.state = session.blocked ? 'blocked' : session.activity;
      sessionStatus(card.stateIcon, card.activity.dataset.state, card.activity.textContent);
      card.prompt.hidden = !session.blocked || session.exited;
      card.prompt.textContent = `${blockedText[session.blocked] || '需要你的确认'} · 请在下方原生界面选择`;
      card.node.classList.toggle('confirming', !card.prompt.hidden);
      card.branch.textContent = session.git ? `⑂ ${session.git.branch || session.git.commit?.slice(0, 7) || 'HEAD'}` : '⑂ Git';
      card.error.hidden = !session.error;
      card.error.textContent = session.error ? `${session.error.message} · 请重试关闭/禁用以完成归档` : '';
      const idle = !session.blocked && ['idle', 'done', 'error'].includes(session.activity) && !session.exited;
      // Draft editing remains available while Codex reports work, just like typing in its composer.
      card.clear.disabled = !!session.blocked || session.exited;
      card.newline.disabled = !!session.blocked || session.exited;
      card.fork.disabled = !idle;
    }
    // Moving existing xterm nodes on every status update interrupts scrolling and pointer capture.
    const ordered = [...layout.order.filter(id => cards.has(id)), ...[...cards.keys()].filter(id => !layout.order.includes(id))];
    ordered.forEach((id, index) => {
      const node = cards.get(id).node;
      if (windows.children[index] !== node && !draggingSession()) { windows.insertBefore(node, windows.children[index] || null); }
    });
    empty.hidden = !!sessions.length;
  }
  function draggingSession() { return windows.querySelector('.dragging'); }
  const off = api.events.sessionsChanged(update);
  update(await api.sessions.list(pluginId));
  const theme = (event) => cards.forEach((card) => card.terminal.setTheme(event.detail));
  window.addEventListener('desk-theme', theme);
  return () => {
    disposed = true;
    clearTimeout(saveTimer);
    off();
    window.removeEventListener('desk-theme', theme);
    cards.forEach((card) => { card.observer.disconnect(); card.terminal.dispose(); });
  };
}

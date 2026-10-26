import { agentRequests } from './agent-requests.js';
import { chooseDirectory, escape as e, invoke } from './api.js';

const labels = { load: '1 · 加载目录', tree: '2 · 资源树确认', code: '3 · 代码确认', sql: '4 · SQL 确认' };
const kinds = { SYSTEM: '子系统', DIR: '目录', MENU: '菜单', BUTTON: '按钮' };
const done = state => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
const field = (id, label, value = '', type = 'text') => `<label>${e(label)}<input id="${id}" type="${type}" value="${e(value)}" autocomplete="off"></label>`;

export function createMenuPanel(container, onRun, status) {
  let run = null;
  let session = null;
  let selected = '';
  let providers = [];
  let busy = false;
  let identity = '';
  let settings = { cwd: '/Users/wujie/IdeaProjects/sl-platform/dbai-admin', providerId: '', text: '', parent: '', scope: '', institutions: '' };
  let timer;
  let roots = [];
  let syncMessage = '';
  const value = id => container.querySelector(`#${id}`)?.value || '';
  const input = () => ({ runId: run.id, revision: session.revision });
  const remember = () => {
    for (const key of Object.keys(settings)) {
      const element = container.querySelector(`#menu-${key}`);
      if (element) { settings[key] = element.value; }
    }
  };
  async function action(work) {
    if (busy) { return; }
    busy = true;
    remember();
    const errorBox = container.querySelector('#menu-error');
    if (errorBox) { errorBox.textContent = ''; }
    for (const button of container.querySelectorAll('button')) { button.disabled = true; }
    try {
      const changed = await work();
      if (changed === false) { return; }
      session = await invoke('menu.read', run.id);
      await render();
    } catch (error) {
      status(error.message, true);
      const errorBox = container.querySelector('#menu-error');
      if (errorBox) { errorBox.textContent = error.message; }
    } finally {
      busy = false;
      for (const button of container.querySelectorAll('button')) { button.disabled = false; }
    }
  }
  function connection() { return { token: value('menu-token'), roleId: value('menu-role'), menuId: value('menu-header') }; }
  function agentSettings() {
    return `${field('menu-cwd', 'Agent 工作目录', settings.cwd)}<label>Agent 提供方<select id="menu-providerId">
      <option value="">自动选择唯一提供方</option>${providers.map(item => `<option value="${e(item.pluginId)}"
      ${settings.providerId === item.pluginId ? 'selected' : ''}>${e(item.pluginId)}</option>`).join('')}</select></label>`;
  }
  function taskHtml(kind) {
    const task = session[`${kind}Task`];
    if (!task) { return ''; }
    return `<section class="menu-task"><strong>Agent：${e(task.state)}</strong>${task.error ? `<p class="error-text">${e(task.error)}</p>` : ''}
      ${task.output ? `<details><summary>Agent 结果与验证说明</summary><pre class="output">${e(task.output)}</pre></details>` : ''}
      ${(task.diff || []).map(diff => `<details open><summary>${e(diff.file)}</summary><div class="menu-diff">
        <div><small>修改前</small><pre class="output">${e(diff.before ?? '（不存在）')}</pre></div>
        <div><small>修改后</small><pre class="output">${e(diff.after ?? '（删除）')}</pre></div></div></details>`).join('')}
      ${!done(task.state) ? `<button data-action="stop" data-kind="${kind}">停止 Agent</button>` : ''}
      ${agentRequests(task.requests, kind)}</section>`;
  }
  function treeHtml() {
    const nodes = [...session.catalog, ...session.drafts];
    const children = new Map();
    for (const node of nodes) {
      const parent = nodes.some(item => item.key === node.parent) ? node.parent : '';
      children.set(parent, [...(children.get(parent) || []), node]);
    }
    const seen = new Set();
    function branch(node) {
      if (seen.has(node.key)) { return ''; }
      seen.add(node.key);
      const fresh = node.key.startsWith('d:');
      return `<li><button class="menu-tree-item ${fresh ? 'menu-new' : ''} ${selected === node.key ? 'selected' : ''}"
        data-tree="${e(node.key)}" title="${e(node.key)}">${fresh ? '新增 · ' : ''}${e(node.name || '待填写名称')}
        <small>${e(kinds[node.kind] || node.kind)} · ${e(node.code || '待填写编码')}</small></button>
        ${children.get(node.key)?.length ? `<ul>${children.get(node.key).map(branch).join('')}</ul>` : ''}</li>`;
    }
    const roots = (children.get('') || []).map(branch).join('');
    return `<ul class="menu-tree">${roots}${nodes.filter(node => !seen.has(node.key)).map(branch).join('')}</ul>`;
  }
  function draftHtml() {
    const draft = session.drafts.find(item => item.key === selected);
    if (!draft) { return '<p class="hint">选择标记“新增”的资源编辑；已有目录仅作为父节点。</p>'; }
    const nodes = [...session.catalog, ...session.drafts.filter(item => item.key !== selected && item.kind !== 'BUTTON')];
    return `<strong>编辑新增资源</strong><label>类型<select id="draft-kind">${Object.entries(kinds).map(([kind, label]) =>
      `<option value="${kind}" ${draft.kind === kind ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      ${field('draft-name', '名称', draft.name)}${field('draft-code', '编码', draft.code)}
      <label>父节点<select id="draft-parent"><option value="">根节点（仅子系统）</option>${nodes.map(node =>
      `<option value="${e(node.key)}" ${draft.parent === node.key ? 'selected' : ''}>${e(node.name)} · ${e(node.system || node.kind)} · ${e(node.code)} · ${e(node.key)}</option>`).join('')}</select></label>
      ${field('draft-path', '路由路径', draft.path)}${field('draft-sort', '排序', draft.sort || 0, 'number')}
      ${draft.appCode ? `<p class="hint">appCode：${e(draft.appCode)}</p>` : ''}
      <button data-action="save-draft">保存资源修改</button> <button data-action="remove-draft">移除新增资源</button>`;
  }
  async function render() {
    const stage = run.pending?.stage || run.pending?.request?.stage;
    const active = run.status === 'waiting' && run.pending?.kind === 'manual';
    const stages = Object.entries(labels).map(([key, label]) => `<span class="${key === stage ? 'current' : ''}">${e(label)}</span>`).join('');
    let body = '';
    if (!active) {
      body = session.sql ? await sqlHtml(true) : '<p class="hint">本次运行已停止。重新运行菜单模板可开始新的初始化。</p>';
    } else if (stage === 'load') {
      body = `<p class="hint">连接 FAT 菜单目录。token 仅用于当前插件进程，不会保存或交给 Agent。</p>
        <div class="menu-fields">${field('menu-token', 'authtoken', '', 'password')}${field('menu-role', 'roleId')}
        ${field('menu-header', 'menuid 请求头（可选）')}${field('menu-tenant', 'SQL tenantId', session.tenant)}</div>
        <button data-action="load">加载目录</button><p>已加载 ${session.catalog.length} 项 · ${session.connected ? '连接有效' : '需要连接'}</p>
        ${session.loaded ? `<div class="menu-tree-box">${treeHtml()}</div><button class="primary" data-action="confirm">确认目录，下一步</button>` : ''}`;
    } else if (stage === 'tree') {
      body = `<div class="menu-columns"><section><label>自然语言需求<textarea id="menu-text" rows="3"
        placeholder="在###菜单下加入**菜单，在**菜单下加入**按钮">${e(settings.text)}</textarea></label>
        ${agentSettings()}<label>限定目录分支（可选）<select id="menu-parent"><option value="">全部目录</option>${session.catalog
        .filter(node => node.kind !== 'BUTTON').map(node => `<option value="${e(node.key)}" ${settings.parent === node.key ? 'selected' : ''}>
          ${e(node.name)} · ${e(node.code)} · ${e(node.key)}</option>`).join('')}</select></label>
        <button data-action="plan">调用 Agent 生成草稿</button>${taskHtml('plan')}
        ${(session.questions || []).length ? `<div class="warning">${session.questions.map(question => `<p>${e(question)}</p>`).join('')}
          <p>补充需求重新规划，或编辑草稿明确内容后再确认。</p></div>` : ''}
        <p class="hint">草稿 ${session.drafts.length} 项 · 修订 ${session.revision}。修改仅作用于本批新增资源。</p>
        <button data-action="add-draft">手动新增资源</button><div class="menu-tree-box">${treeHtml()}</div></section>
        <section>${draftHtml()}</section></div>
        ${session.validation ? `<p class="error-text">${e(session.validation)}</p>` : ''}
        <button data-action="back-load">返回目录</button> <button class="primary" data-action="confirm">确认新增资源树</button>`;
    } else if (stage === 'code') {
      body = `${agentSettings()}<p class="hint">先确认代码修改范围，再启动 Agent；完成后审查文件内容和验证说明。</p>
        <label>允许修改的文件与原因（每行：相对路径 | 原因）<textarea id="menu-scope" rows="4">${e(settings.scope || `${session.registryFile} | 注册新增菜单 appCode`)}</textarea></label>
        <button data-action="code">确认范围并调用代码 Agent</button>${taskHtml('code')}
        <label class="menu-check"><input type="checkbox" id="menu-reviewed">我已审查本次代码改动和 Agent 验证说明</label>
        <button data-action="back-tree">返回资源树</button> <button class="primary" data-action="confirm-code">确认代码结果</button>
        <label class="menu-check"><input type="checkbox" id="menu-skip">本批不需要 Agent 编写代码，明确跳过</label>
        <button data-action="skip-code">确认跳过代码步骤</button>`;
    } else if (stage === 'sql') {
      body = await sqlHtml(false);
    }
    container.innerHTML = `<header class="menu-heading"><strong>菜单初始化</strong><small>修订 ${session.revision}</small></header>
      <nav class="menu-steps">${stages}</nav><p id="menu-error" class="error-text" role="alert"></p>${body}`;
    bind();
  }
  async function sqlHtml(final) {
    const artifact = await invoke(final ? 'menu.sql' : 'menu.preview', run.id);
    return `<p class="hint">${final ? 'SQL 已生成，请手动执行后再同步机构。' : '核对 SQL，确认时会重新校验来源目录及编码冲突。'}</p>
      <pre class="menu-sql">${e(artifact.sql)}</pre>${final ? `<button data-action="download">保存完整 SQL</button><p id="menu-export-result" role="status"></p>
      <details><summary>执行 SQL 后，手动同步机构</summary>
      <div class="menu-fields">${field('menu-token', '重新连接 authtoken（重开插件时必填）', '', 'password')}
      ${field('menu-role', 'roleId')}${field('menu-header', 'menuid 请求头（可选）')}</div>
      <button data-action="roots">重新加载来源根菜单</button><label>来源根菜单<select id="menu-root">${roots.length ? roots.map(root => `<option value="${e(root.id)}">${e(root.name)} · ${e(root.id)}</option>`).join('') : '<option value="">请先加载</option>'}</select></label>
      <label>目标机构 ID（逗号分隔）<textarea id="menu-institutions" rows="2">${e(settings.institutions)}</textarea></label>
      <label class="menu-check"><input type="checkbox" id="menu-executed">我已手动执行本批 SQL，并确认同步来源和目标机构</label>
      <button data-action="sync">确认同步机构</button><p id="menu-sync-result" role="status">${e(syncMessage)}</p></details>`
      : '<button data-action="back-tree">返回资源树</button> <button class="primary" data-action="confirm">确认并输出 SQL</button>'}`;
  }
  function bind() {
    for (const button of container.querySelectorAll('[data-tree]')) {
      button.onclick = () => { remember(); selected = button.dataset.tree; render(); };
    }
    for (const button of container.querySelectorAll('[data-action]')) {
      button.onclick = () => action(async () => {
        const name = button.dataset.action;
        if (name === 'load') {
          session = await invoke('menu.load', { ...input(), connection: connection(), tenant: value('menu-tenant') });
        } else if (name === 'confirm' || name === 'confirm-code' || name === 'skip-code') {
          if (name === 'confirm-code' && !container.querySelector('#menu-reviewed').checked) { throw Error('请先勾选代码审查确认'); }
          if (name === 'skip-code' && !container.querySelector('#menu-skip').checked) { throw Error('请明确勾选跳过代码步骤'); }
          run = await invoke('menu.confirm', { ...input(), skip: name === 'skip-code', digest: session.codeTask?.digest });
          onRun(run);
        } else if (name === 'plan' || name === 'code') {
          const scope = value('menu-scope').split('\n').filter(line => line.trim()).map(line => {
            const [file, ...reason] = line.split('|');
            return { file: file.trim(), reason: reason.join('|').trim() };
          });
          session = await invoke(`menu.${name}`, { ...input(), ...settings, ...(name === 'code' ? { scope } : {}) });
        } else if (name === 'stop') {
          session = await invoke('menu.stopTask', { ...input(), kind: button.dataset.kind });
        } else if (name.startsWith('back-')) {
          run = await invoke('menu.reset', { ...input(), stage: name.slice(5) });
          onRun(run);
        } else if (['add-draft', 'save-draft', 'remove-draft'].includes(name)) {
          let drafts = structuredClone(session.drafts);
          if (name === 'add-draft') {
            selected = `d:${crypto.randomUUID()}`;
            drafts.push({ key: selected, kind: 'MENU', name: '', code: '', parent: settings.parent || session.catalog[0]?.key || '', path: '', sort: 0 });
          } else if (name === 'remove-draft') {
            drafts = drafts.filter(draft => draft.key !== selected);
          } else {
            Object.assign(drafts.find(draft => draft.key === selected), { kind: value('draft-kind'), name: value('draft-name'),
              code: value('draft-code'), parent: value('draft-parent'), path: value('draft-path'), sort: Number(value('draft-sort')) });
          }
          session = await invoke('menu.edit', { ...input(), drafts });
        } else if (name === 'download') {
          const directory = await chooseDirectory();
          if (directory) {
            const artifact = await invoke('menu.export', { runId: run.id, directory });
            container.querySelector('#menu-export-result').textContent = `已保存：${artifact.path}`;
          }
          return false;
        } else if (name === 'roots') {
          roots = await invoke('menu.roots', { runId: run.id, ...(value('menu-token') ? { connection: connection() } : {}) });
          container.querySelector('#menu-root').innerHTML = roots.map(root => `<option value="${e(root.id)}">${e(root.name)} · ${e(root.id)}</option>`).join('');
          return false;
        } else if (name === 'sync') {
          await invoke('menu.sync', { runId: run.id, menuId: value('menu-root'), institutions: value('menu-institutions'),
            sqlExecuted: container.querySelector('#menu-executed').checked });
          status('机构同步成功。');
          syncMessage = '同步成功';
          container.querySelector('#menu-sync-result').textContent = syncMessage;
          return false;
        }
        identity = `${run.id}:${run.status}:${run.pending?.stage || ''}`;
      });
    }
    for (const button of container.querySelectorAll('[data-approval], [data-answer]')) {
      button.onclick = () => action(async () => {
        const kind = button.dataset.kind;
        const index = Number(button.dataset.approval ?? button.dataset.answer);
        const request = session[`${kind}Task`].requests[index];
        await invoke('menu.respond', { ...input(), kind, requestId: request.id,
          ...(button.dataset.answer !== undefined ? { answers: JSON.parse(value(`request-${kind}-${index}`)) } : { decision: button.dataset.decision }) });
        session = await invoke('menu.poll', { ...input(), kind });
      });
    }
  }
  async function tick() {
    if (busy || container.hidden || !session || !run || run.status !== 'waiting') { return; }
    const kind = run.pending?.stage === 'code' ? 'code' : 'plan';
    const task = session[`${kind}Task`];
    if (!task || done(task.state)) { return; }
    const before = JSON.stringify(task);
    const revision = session.revision;
    const form = [...container.querySelectorAll('input:not([type="password"]), textarea, select')]
      .filter(element => element.id).map(element => ({ id: element.id, value: element.value, checked: element.checked }));
    await action(async () => {
      const next = await invoke('menu.poll', { runId: run.id, kind });
      if (before === JSON.stringify(next[`${kind}Task`]) && next.revision === session.revision) { return false; }
      session = next;
    });
    if (session.revision === revision) {
      for (const field of form) {
        const element = container.querySelector(`#${field.id}`);
        if (element) { element.value = field.value; element.checked = field.checked; }
      }
    }
  }
  return {
    async show(next, enabled) {
      container.hidden = !enabled;
      if (!enabled) { identity = ''; clearInterval(timer); return; }
      const nextIdentity = next ? `${next.id}:${next.status}:${next.pending?.stage || ''}` : '';
      if (!next) { container.innerHTML = '<p class="hint">点击“运行”开始菜单初始化。</p>'; return; }
      if (run?.id !== next.id) { roots = []; syncMessage = ''; selected = ''; }
      run = next;
      if (busy) { return; }
      if (identity === nextIdentity) { return; }
      identity = nextIdentity;
      clearInterval(timer);
      try {
        session = await invoke('menu.read', next.id);
        providers = await invoke('menu.providers').catch(() => []);
        await render();
        timer = setInterval(tick, 2500);
      } catch (error) {
        identity = '';
        container.textContent = error.message;
      }
    }
  };
}

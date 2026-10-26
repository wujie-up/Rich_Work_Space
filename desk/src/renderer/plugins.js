import { openPluginSettings } from './plugin-settings.js';
import { pluginIcon } from './plugin-icon.js';
import { api, el, iconButton, icons, modal, run, toast } from './ui.js';
import { bindLauncher, canOpen } from './launcher.js';
import { message } from './i18n.js';

export async function transition(id, action) {
  let preview;
  if (action === 'disable') {
    preview = await api.plugins.preview(id, action);
  }
  // Stopped tasks remain in the snapshot for archival, but do not need a disable warning.
  const choice = action === 'disable' && !preview.runningTasks.some(task => !task.exited) ? 'keep'
    : await modal({ close: '确认关闭', disable: '禁用插件', remove: '卸载插件' }[action], ({ body, actions, finish }) => {
    if (action === 'close') {
      body.append(el('p', { message: '确认关闭' }));
    }
    const tasks = el('div', {}, action === 'remove' ? el('p', { message: '正在获取任务列表…' }) : null);
    body.append(tasks);
    const policy = el('select', { 'aria-label-message': '插件数据策略' }, el('option', { value: 'keep', message: '保留插件数据（默认）' }),
      el('option', { value: 'clear', message: '清理此插件的配置、布局、日志和历史' }));
    if (action === 'remove') {
      body.append(policy, el('p', { class: 'muted', message: '清理仅作用于 DeckPg 内的此插件数据。插件目录外的文件保持原样。' }));
    }
    const proceed = iconButton(action === 'remove' ? icons.remove : icons.check,
      { close: '关闭', disable: '关闭并禁用', remove: '关闭并卸载' }[action], () => finish(action === 'close' && !preview ? 'force' : policy.value));
    proceed.disabled = action === 'remove';
    const cancel = iconButton(action === 'remove' ? icons.cancel : icons.close, '取消', () => finish(null));
    cancel.autofocus = action === 'close';
    actions.append(cancel, proceed);
    if (action === 'close') {
      // One confirmation also preserves the emergency path while preview RPC is unresponsive.
      message(proceed, '强制关闭，未保存内容可能丢失', 'title');
    }
    // The confirmation remains usable even when a broken plugin cannot produce its task snapshot.
    (preview ? Promise.resolve(preview) : api.plugins.preview(id, action)).then(value => {
      preview = value;
      tasks.replaceChildren();
      // Keep the full snapshot for archival and confirmation, but only warn about active work.
      const runningTasks = preview.runningTasks.filter(task => !task.exited);
      if (preview.closeDescription) {
        tasks.append(el('p', { class: 'muted', text: preview.closeDescription }));
      }
      if (runningTasks.length) {
        tasks.append(el('p', { message: ['将关闭 {count} 个任务。', { count: runningTasks.length }] }));
      } else if (action === 'remove') {
        tasks.append(el('p', { message: '当前没有待关闭任务。' }));
      }
      if (runningTasks.length) {
        const list = el('div', { class: 'confirm-task-list' });
        for (const session of runningTasks) {
          list.append(el('div', { class: 'confirm-session', title: session.name }, session.name,
            session.collapsed ? el('span', { message: ' · 已折叠' }) : null));
        }
        tasks.append(list);
      }
      proceed.disabled = false;
      message(proceed, { close: '关闭', disable: '关闭并禁用', remove: '关闭并卸载' }[action], 'title');
    }).catch(error => {
      tasks.replaceChildren(el('p', { class: 'error-box', message: ['无法获取任务列表：{error}', { error: error.message }] }));
    });
  }, { compact: action !== 'remove' });
  if (!choice) {
    return;
  }
  if (choice === 'force') {
    await api.plugins.forceClose(id);
    return;
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await (action === 'remove' ? api.plugins.remove(id, choice, preview.confirmationToken)
          : api.plugins[action](id, preview.confirmationToken));
        break;
      } catch (error) {
        // Electron's context bridge preserves the message but drops custom Error properties.
        const busy = error.code === 'PLUGIN_BUSY' || error.message === '插件正在创建任务或执行操作';
        if (!busy || attempt === 4) {
          throw error;
        }
        // Retained views may briefly hold the lock while persisting their layout.
        console.info('[plugin:transition-wait]', { pluginId: id, action, attempt: attempt + 1 });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } catch (error) {
    if (error.code === 'CONFIRMATION_STALE' || error.message === '任务列表已变化，请重新预览并确认') {
      toast('任务列表已变化，请核对更新后的列表。');
      return transition(id, action);
    }
    throw error;
  }
}

export async function mountPlugins(root, openPlugin, layouts) {
  let disposed = false;
  const render = async () => {
    const records = await api.plugins.list();
    if (disposed) {
      return;
    }
    root.replaceChildren(el('div', { class: 'plugin-toolbar' }, layouts,
      iconButton(icons.import, '导入本地插件', () => api.plugins.install())));
    const list = el('div', { class: 'plugin-grid', 'data-layout': localStorage.getItem('plugin-layout') === 'list' ? 'list' : 'grid' });
    for (const record of records.filter(record => record.state !== 'uninstalled')) {
      const row = el('article', { class: 'plugin-card', 'data-plugin': record.id });
      if (canOpen(record)) {
        bindLauncher(row, record, openPlugin);
      }
      row.append(el('div', { class: 'plugin-mark' }, pluginIcon(record)), el('h2', { text: record.name }));
      if (record.operation) {
        row.append(el('span', { class: 'badge', message: record.operation }));
      }
      row.append(el('p', { class: 'muted', text: `${record.id} · v${record.version}` }),
        record.description ? el('p', { text: record.description }) : el('p', { message: '本地可信插件' }));
      const properties = [
        { application: '应用插件', service: '服务插件', resource: '资源插件' }[record.type || 'application'],
        record.showIcon === false ? '隐藏图标' : '显示图标',
        record.loadOnStartup === false ? '按需加载' : '启动加载',
        { none: '无需后台', task: '任务完成退出', service: '持续后台' }[record.background || 'service']
      ];
      row.append(el('p', { class: 'muted', 'data-plugin-properties': record.id },
        ...properties.flatMap((message, index) => [index ? ' · ' : '', el('span', { message })])));
      if (record.lastError) {
        row.append(el('div', { class: 'error-box', message: ['{stage}：{error}（可重试）', { stage: record.lastError.stage, error: record.lastError.message }] }));
      }
      const actions = el('div', { class: 'row-actions' });
      actions.append(iconButton('m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', '插件配置', () => openPluginSettings(record.id)));
      if (canOpen(record)) {
        actions.append(iconButton(icons.open, '打开', () => openPlugin(record.id)));
      }
      if (['enabled', 'disabled'].includes(record.state)) {
        const enabled = record.state === 'enabled';
        row.append(el('button', { type: 'button', role: 'switch', class: 'plugin-toggle',
          'aria-checked': String(enabled), 'aria-label-message': enabled ? '禁用' : '启用', 'title-message': enabled ? '禁用' : '启用',
          onclick: () => run(() => enabled ? transition(record.id, 'disable') : api.plugins.enable(record.id)) },
        el('span', { class: 'plugin-toggle-thumb', 'aria-hidden': 'true' })));
      }
      if (record.lastError || record.operation) {
        actions.append(iconButton(icons.power, '强制关闭', () => transition(record.id, 'close')));
      }
      if (record.state !== 'uninstalled') {
        actions.append(iconButton(icons.remove, '卸载', () => transition(record.id, 'remove')));
      }
      if (record.cleanupPending) {
        actions.append(iconButton(icons.retry, '重试数据清理', () => api.plugins.retryCleanup(record.id)));
      }
      row.append(actions);
      list.append(row);
    }
    root.append(list, el('p', { class: 'footnote', message: '支持 .plg 插件包（tar.gz 压缩归档）。仅导入你信任的代码。' }));
  };
  const off = api.events.pluginsChanged(() => render().catch((error) => toast(error.message)));
  await render();
  return () => { disposed = true; off(); };
}

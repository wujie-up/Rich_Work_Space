import { pageLifecycle, pollVisible } from '../../../../desk/src/resource/page-lifecycle.js';
import { invoke } from './api.js';
import { confirmAction } from './dialog.js';

const icon = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="${path}"/></svg>`;

export function setupSpring() {
  const panel = document.querySelector('#spring-panel');
  panel.innerHTML = `<div class="directory-bar"><span>Spring Boot</span><button id="spring-refresh" class="icon-button" title="发现启动项目" aria-label="发现启动项目">${icon('M20 10a8 8 0 1 0-1 7M20 4v6h-6')}</button></div>
    <div id="spring-apps"></div><p id="spring-state" role="status">打开项目后发现启动类</p><pre id="spring-log" aria-label="Spring Boot 日志"></pre>`;
  const $ = id => panel.querySelector(`#spring-${id}`);
  const lifecycle = pageLifecycle();
  let selected;
  let active = false;
  let pending = false;
  let generation = 0;
  let apps = [];
  const state = message => { $('state').textContent = message; };
  const show = task => {
    state(`${task.mainClass} · ${ { running: '运行中', stopped: '已停止', exited: '已退出', failed: '失败' }[task.state]}${task.error ? ` · ${task.error}` : ''}`);
    $('log').textContent = `${task.command}\n${task.log || ''}${task.truncated ? '\n仅保留末尾 128 KiB' : ''}`;
  };
  async function refresh(scan = true) {
    if (pending) {
      return;
    }
    const token = generation;
    pending = true;
    $('refresh').disabled = true;
    try {
      const result = scan ? await invoke('springApps') : { ...await invoke('springTasks'), apps };
      if (token !== generation) {
        return;
      }
      if (scan) {
        apps = result.apps;
      }
      active = result.tasks.some(task => task.state === 'running');
      $('apps').replaceChildren(...result.apps.map(app => {
        const row = document.createElement('div');
        row.className = 'spring-app';
        const label = document.createElement('button');
        label.textContent = `${app.name} · ${app.module || '根项目'}`;
        label.title = `${app.mainClass}\n${app.path}`;
        const task = result.tasks.find(task => task.path === app.path);
        label.setAttribute('aria-pressed', String(task?.id === selected));
        label.onclick = async () => {
          if (task) {
            selected = task.id;
            await readTask().catch(error => state(error.message));
          }
        };
        const button = document.createElement('button');
        const running = task?.state === 'running';
        button.className = 'icon-button';
        button.title = `${running ? '停止' : '启动'} ${app.mainClass}`;
        button.setAttribute('aria-label', button.title);
        button.innerHTML = icon(running ? 'M5 5h14v14H5Z' : 'm8 4 12 8-12 8Z');
        button.onclick = async () => {
          button.disabled = true;
          try {
            if (!running && !await confirmAction(`启动 ${app.mainClass}（${app.module || '根项目'}），会执行 Maven 项目逻辑、写入文件并可能下载依赖。`, '确认启动项目')) {
              return;
            }
            const next = await invoke(running ? 'stopSpring' : 'startSpring', running ? { id: task.id } : { path: app.path });
            selected = next.task.id;
            show(next.task);
            await refresh(false);
          } catch (error) {
            state(error.message);
          } finally {
            button.disabled = false;
          }
        };
        row.append(label, button);
        return row;
      }));
      if (!result.apps.length) {
        state('未发现 Maven Spring Boot 启动类');
      } else if (result.truncated) {
        state('发现结果已达扫描上限，请选择更小的项目');
      }
      selected ||= result.tasks.find(task => task.state === 'running')?.id;
      if (selected) {
        await readTask();
      }
    } catch (error) {
      state(error.message);
    } finally {
      pending = false;
      $('refresh').disabled = false;
      if (token !== generation) {
        void refresh();
      }
    }
  }
  async function readTask() {
    if (selected) {
      show((await invoke('springTask', { id: selected })).task);
    }
  }
  $('refresh').onclick = () => refresh();
  document.addEventListener('coding:workspace', () => {
    generation++;
    apps = [];
    selected = null;
    active = false;
    $('apps').replaceChildren();
    $('log').textContent = '';
    refresh();
  });
  pollVisible(lifecycle, async () => {
    if (active && !pending) {
      await refresh(false);
    }
  }, 2000);
  return refresh;
}

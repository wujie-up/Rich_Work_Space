import { showSideDialog, closeSideDialog } from './side-dialog.js';
import { pageLifecycle, pollVisible } from '../../../../desk/src/resource/page-lifecycle.js';
import { invoke } from './api.js';

export function setupMaven() {
  const lifecycle = pageLifecycle();
  const $ = selector => document.querySelector(selector);
  let task = null;
  let pending = false;
  let reading = false;
  const states = { running: '编译中', succeeded: '编译成功', failed: '编译失败', cancelled: '已停止' };

  async function projects() {
    const button = $('#build-projects-refresh');
    if (button.disabled) {
      return;
    }
    button.disabled = true;
    try {
      const result = await invoke('mavenProjects');
      const nodes = new Map();
      const tree = document.createElement('div');
      for (const project of result.projects) {
        const group = document.createElement('details');
        group.open = project.parentPath === null;
        const heading = document.createElement('summary');
        const select = document.createElement('button');
        select.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20 7 5M6 9c5-7 9-5 7 1l-3 10m3-11c5-7 10-5 8 1l-3 10"/></svg>';
        const label = document.createElement('span');
        label.textContent = project.name;
        select.append(label);
        select.title = `选择构建项目：${project.path || project.name}`;
        select.dataset.path = project.path;
        select.type = 'button';
        const selectProject = () => {
          $('#build-path').value = project.path;
          $('#build-projects').querySelectorAll('[aria-pressed]').forEach(item => item.setAttribute('aria-pressed', 'false'));
          select.setAttribute('aria-pressed', 'true');
        };
        select.addEventListener('click', selectProject);
        select.setAttribute('aria-pressed', String($('#build-path').value === project.path));
        heading.append(select);
        group.append(heading);
        const phases = document.createElement('details');
        phases.className = 'maven-lifecycle';
        const phaseHeading = document.createElement('summary');
        phaseHeading.textContent = '生命周期';
        phases.append(phaseHeading);
        // Populate on expansion so large reactors do not create thousands of hidden phase buttons.
        phases.addEventListener('toggle', () => {
          if (!phases.open || phases.childElementCount > 1) {
            return;
          }
          for (const phase of ['clean', 'compile', 'test', 'install', 'deploy']) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = phase;
            button.dataset.phase = phase;
            button.title = `${project.name}：${phase}；单击选择，双击执行`;
            button.addEventListener('click', () => {
              selectProject();
              $('#build-phase').value = phase;
              render();
            });
            button.addEventListener('dblclick', () => $('#build-start').click());
            phases.append(button);
          }
          render();
        });
        group.append(phases);
        nodes.set(project.path, group);
      }
      // Build all rows before linking them: a declared module may live outside its parent directory.
      for (const project of result.projects) {
        const group = nodes.get(project.path);
        (nodes.get(project.parentPath) || tree).append(group);
      }
      const note = document.createElement('p');
      note.textContent = result.truncated ? '项目扫描达到上限。'
        : result.projects.length ? `${result.projects.length} 个 Maven 项目` : '未找到 pom.xml。';
      $('#build-projects').replaceChildren(note, tree);
      render();
    } catch (error) {
      $('#build-projects').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  // Keep the tree's full height until a build needs an output area.
  function showOutput() {
    const output = $('#build-output');
    if (!output.childElementCount) {
      output.innerHTML = '<p id="build-state" role="status" aria-live="polite"></p><pre id="build-log" aria-label="编译日志"></pre>';
    }
    output.hidden = false;
  }

  function render() {
    $('#build-start').disabled = pending || task?.state === 'running';
    $('#build-stop').disabled = pending || task?.state !== 'running';
    $('#build-path').disabled = pending || task?.state === 'running';
    for (const control of document.querySelectorAll('#build-projects button')) {
      control.disabled = pending || task?.state === 'running';
    }
    for (const button of document.querySelectorAll('#build-projects [data-phase]')) {
      const project = button.closest('.maven-lifecycle').parentElement.querySelector(':scope > summary button');
      button.setAttribute('aria-pressed', String(project.dataset.path === $('#build-path').value && button.dataset.phase === $('#build-phase').value));
    }
    if (!task && !$('#build-output').childElementCount) {
      return;
    }
    showOutput();
    $('#build-state').classList.toggle('error', task?.state === 'failed');
    $('#build-state').textContent = task ? `${states[task.state]} · ${task.command}${task.error ? `；${task.error}` : ''}` : '尚未编译';
    const log = $('#build-log');
    const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = `${task?.truncated ? '较早日志已截断，仅保留最后 128 KiB。\n' : ''}${task?.log || ''}`;
    if (follow) {
      log.scrollTop = log.scrollHeight;
    }
  }

  async function refresh() {
    if (reading || pending) {
      return;
    }
    reading = true;
    try {
      const previous = task;
      const result = await invoke('build');
      if (!pending && task === previous) {
        task = result.task;
        if (task?.state === 'running' && previous?.id !== task.id) {
          $('#build-path').value = task.path;
          $('#build-phase').value = task.phase || 'compile';
        }
        render();
      }
    } catch (error) {
      showOutput();
      $('#build-state').textContent = error.message;
      $('#build-state').classList.add('error');
    } finally {
      reading = false;
    }
  }

  async function act(method, input) {
    showOutput();
    pending = true;
    render();
    try {
      ({ task } = await invoke(method, input));
      render();
    } catch (error) {
      showOutput();
      $('#build-state').textContent = error.message;
      $('#build-state').classList.add('error');
    } finally {
      pending = false;
      $('#build-start').disabled = task?.state === 'running';
      $('#build-stop').disabled = task?.state !== 'running';
      $('#build-path').disabled = task?.state === 'running';
      for (const control of document.querySelectorAll('#build-projects button')) {
        control.disabled = task?.state === 'running';
      }
    }
  }

  $('#build-start').addEventListener('click', async () => {
    const input = { path: $('#build-path').value, phase: $('#build-phase').value };
    if (['deploy', 'site-deploy'].includes(input.phase)) {
      pending = true;
      render();
      const allowed = await confirmPublish(input);
      pending = false;
      render();
      if (!allowed) {
        return;
      }
    }
    await act('compile', input);
  });
  $('#build-projects-refresh').addEventListener('click', projects);
  $('#build-stop').addEventListener('click', () => act('cancelBuild', { id: task.id }));
  $('#build-tab').addEventListener('click', () => {
    if (!$('#build-pane').hidden) {
      void refresh();
      void projects();
    }
  });
  void refresh();
  // Resume observation after a view reload; the build belongs to the plugin background.
  pollVisible(lifecycle, () => {
    if (task?.state === 'running' || !$('#build-pane').hidden) {
      return refresh();
    }
  }, 1000);
}

// Publishing is a distinct effect: show the exact module and phase before starting it.
function confirmPublish(input) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    const body = document.createElement('div');
    body.className = 'dialog-body';
    body.textContent = `执行 ${input.phase}：${input.path || '项目根目录'}。将运行此前生命周期阶段，并发布到项目配置的远程仓库，是否继续？`;
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const finish = allowed => { closeSideDialog(dialog); dialog.remove(); resolve(allowed); };
    for (const [label, allowed, path] of [['取消发布', false, 'm6 6 12 12M6 18 18 6'],
      ['确认发布', true, 'm5 12 4 4L19 6']]) {
      const button = document.createElement('button');
      button.className = 'icon-button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="${path}"/></svg>`;
      button.addEventListener('click', () => finish(allowed));
      actions.append(button);
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.append(body, actions);
    document.body.append(dialog);
    showSideDialog(dialog);
  });
}

import { showPopup, closePopup } from '../../../../desk/src/resource/popup.js';
import { invoke, request } from './api.js';
import { button, help } from './ui.js';
import { pageLifecycle } from '../../../../desk/src/resource/page-lifecycle.js';

const labels = { closed: '未登录，请打开登录窗口', opening: '正在打开独立登录窗口…',
  closing: '正在关闭登录窗口…',
  'needs-login': '请在新窗口完成登录，再检查登录状态', connected: '已登录，可以查询任务', error: '登录窗口不可用，请重试' };

export function loginControls(container, onChange) {
  const login = button('open', '登录 PingCode');
  const check = button('refresh', '检查登录状态');
  const logout = button('logout', '退出 PingCode 登录');
  const setup = help('浏览器扩展安装与连接说明', '现有浏览器方式需要先安装配套扩展：打开 chrome://extensions，启用开发者模式，'
    + '点击加载已解压的扩展程序，选择交付的 pingcode-browser-extension 文件夹。然后点击登录按钮，'
    + '在本机连接页确认连接，返回插件后会自动检查登录。扩展会复用已有 PingCode 标签页，没有时在当前浏览器新建。'
    + '关闭普通连接页不影响查询；关闭 PingCode 标签页后，下次查询会重开。完全退出 Chrome 后需重新打开。');
  const message = document.createElement('span');
  message.className = 'login-state';
  message.setAttribute('role', 'status');
  container.classList.add('login-controls');
  container.append(login, check, logout, setup, message);
  const confirm = document.createElement('dialog');
  const content = document.createElement('p');
  content.textContent = '退出会取消查询、关闭登录窗口并清除本插件的登录资料。系统浏览器和飞书登录不受影响。';
  const agree = button('logout', '确认退出并清除登录资料');
  const cancel = button('cancel', '取消退出');
  confirm.append(content, agree, cancel);
  container.append(confirm);
  let state = { state: 'closed' };
  let locked = false;
  let working = '';
  let timer;
  let disposed = false;
  let actionError = '';
  let automatic = false;
  let shouldCheck = true;
  let autoScheduled = false;
  let actionVersion = 0;
  let checkedAt = 0;
  const lifecycle = pageLifecycle();

  function update(next = state, disabled = locked, active = automatic) {
    if (!working && next.transport === 'extension' && next.extensionConnected
      && (!state.extensionConnected || (next.state === 'needs-login' && next.epoch !== state.epoch))) {
      shouldCheck = true;
    }
    state = next;
    locked = disabled;
    automatic = active;
    const extension = state.transport === 'extension';
    setup.hidden = !extension;
    const logoutLabel = extension ? '断开浏览器连接' : '退出 PingCode 登录';
    logout.title = logoutLabel;
    logout.setAttribute('aria-label', logoutLabel);
    const agreeLabel = extension ? '确认断开浏览器连接' : '确认退出并清除登录资料';
    agree.title = agreeLabel;
    agree.setAttribute('aria-label', agreeLabel);
    content.textContent = extension ? '断开会取消查询并移除此工作台配对。浏览器、标签页和 PingCode 登录均保留。'
      : '退出会取消查询、关闭登录窗口并清除本插件的登录资料。系统浏览器和飞书登录不受影响。';
    login.disabled = locked || working || ['opening', 'closing'].includes(state.state);
    check.disabled = locked || working || ['opening', 'closing'].includes(state.state) || (state.state === 'closed' && !extension);
    logout.disabled = locked || working || ['closed', 'closing'].includes(state.state);
    message.textContent = working === 'pingcode.checkLogin' ? '正在检查浏览器连接和登录状态…' : actionError || state.error || (extension
      ? state.extensionConnected && state.supportsQuery === false ? '浏览器扩展版本过旧，请停用旧扩展并加载 0.4.0 版本后重新连接'
        : state.state === 'connected' ? '已登录，可以查询任务'
        : !state.extensionConnected ? '浏览器扩展未连接，首次使用请先安装扩展并点击登录连接'
          : '扩展已连接，请在当前浏览器完成 PingCode 登录，再检查登录状态'
      : labels[state.state] || labels.closed);
    clearTimeout(timer);
    if (!disposed && !working && lifecycle.visible() && (extension || !['closed', 'error'].includes(state.state))) {
      timer = setTimeout(async () => {
        const version = actionVersion;
        try {
          const next = await invoke('pingcode.session');
          if (disposed || version !== actionVersion) { return; }
          const changed = next.epoch !== state.epoch;
          update(next);
          if (changed) {
            await onChange();
          }
        } catch {
          message.textContent = '暂时无法检查登录窗口，请重试';
        }
      }, 1500);
    }
    scheduleCheck();
  }

  function canCheck() {
    return !disposed && automatic && lifecycle.visible() && !locked && !working
      && (state.transport === 'extension' ? state.extensionConnected : ['needs-login', 'connected', 'error'].includes(state.state));
  }

  function scheduleCheck() {
    if (!shouldCheck || autoScheduled || !canCheck()) { return; }
    autoScheduled = true;
    queueMicrotask(() => {
      autoScheduled = false;
      if (shouldCheck && canCheck()) {
        shouldCheck = false;
        action('pingcode.checkLogin');
      }
    });
  }

  async function action(method) {
    if (working || locked || disposed) { return; }
    actionError = '';
    actionVersion++;
    shouldCheck = false;
    working = method;
    update();
    try {
      const result = await invoke(method);
      update(result);
      if (result.pairingUrl) {
        await request('host.openExternal', [result.pairingUrl]);
      }
      await onChange();
    } catch (error) {
      actionError = error.message;
    } finally {
      if (method === 'pingcode.checkLogin') { checkedAt = Date.now(); }
      working = '';
      update();
    }
  }
  login.addEventListener('click', () => action('pingcode.login'));
  check.addEventListener('click', () => action('pingcode.checkLogin'));
  logout.addEventListener('click', () => showPopup(confirm, logout));
  cancel.addEventListener('click', () => closePopup(confirm));
  agree.addEventListener('click', () => { closePopup(confirm); action('pingcode.logout'); });
  const resume = (restored = false) => {
    if (locked || working || !automatic || !lifecycle.visible()) { return; }
    // A restored view also receives focus; coalesce that focus echo with its completed check.
    if (!restored && Date.now() - checkedAt < 1000) { return; }
    shouldCheck = true;
    update();
  };
  lifecycle.subscribe(shown => {
    clearTimeout(timer);
    if (shown) { resume(true); }
  });
  window.addEventListener('focus', () => resume());
  window.addEventListener('pagehide', () => { disposed = true; clearTimeout(timer); });
  update();
  return { update };
}

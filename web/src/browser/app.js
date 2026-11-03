import { browserApi } from './adapter.js';
import './web.css';

const original = document.body.innerHTML;
let disposeMobile;
const stopped = () => {
  try {
    window.webkit?.messageHandlers?.workDeskResources?.postMessage({ type: 'revoked' });
  } catch (error) {
    console.error('[web:resource-revoke]', { stack: error.stack });
  }
  try {
    disposeMobile?.();
  } catch (error) {
    console.error('[web:mobile-dispose]', { stack: error.stack });
  } finally {
    disposeMobile = undefined;
    delete document.documentElement.dataset.mobile;
    delete document.documentElement.dataset.webOpening;
  }
  // Remove retained frames immediately when access is revoked; backend tasks are shared and remain running.
  document.body.replaceChildren();
  const notice = document.createElement('p');
  notice.className = 'web-stopped';
  notice.textContent = '网页访问已关闭或登录已失效，请重新打开页面登录。';
  document.body.append(notice);
};
async function open(session) {
  document.body.innerHTML = original;
  const shell = document.querySelector('.app');
  const loading = document.createElement('section');
  loading.className = 'web-opening';
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-live', 'polite');
  loading.textContent = '正在载入工作台';
  document.documentElement.dataset.webOpening = 'true';
  shell.setAttribute('aria-busy', 'true');
  document.body.append(loading);
  window.workDesk = browserApi(session, stopped);
  document.documentElement.dataset.platform = 'web';
  try {
    await import('../../../desk/src/renderer/app.js');
    // Revocation can remove the shell while its initial requests are still in flight.
    if (!shell.isConnected) {
      return;
    }
    try {
      // The shared renderer must first bind its API to this authenticated browser session.
      const { mountMobile } = await import('./mobile.js');
      if (shell.isConnected) {
        disposeMobile = mountMobile();
      }
    } catch (error) {
      console.error('[web:mobile-mount]', { stack: error.stack });
      disposeMobile = undefined;
    }
    loading.remove();
    shell.removeAttribute('aria-busy');
    delete document.documentElement.dataset.webOpening;
  } catch (error) {
    console.error('[web:workspace-open]', { stack: error.stack });
    loading.setAttribute('role', 'alert');
    loading.textContent = '工作台加载失败，请重新打开页面。';
    throw error;
  }
}
function login() {
  document.body.replaceChildren();
  const form = document.createElement('form');
  form.className = 'web-login';
  const heading = document.createElement('h1');
  heading.textContent = 'DeskPG';
  const username = document.createElement('input');
  username.autocomplete = 'username';
  username.placeholder = '账号';
  username.setAttribute('aria-label', '账号');
  username.required = true;
  const password = document.createElement('input');
  password.type = 'password';
  password.autocomplete = 'current-password';
  password.placeholder = '密码';
  password.setAttribute('aria-label', '密码');
  password.required = true;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'icon-button';
  submit.title = '登录';
  submit.setAttribute('aria-label', '登录');
  submit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 4h10v16H10M3 12h12m-4-4 4 4-4 4"/></svg>';
  const error = document.createElement('p');
  error.setAttribute('role', 'alert');
  form.append(heading, username, password, submit, error);
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username.value, password: password.value }) });
      const session = await response.json();
      if (!response.ok) {
        throw Error(session.error?.message || '登录失败');
      }
      password.value = '';
      await open(session);
    } catch (failure) {
      error.textContent = failure.message;
      submit.disabled = false;
    }
  };
  document.body.append(form);
}
try {
  const response = await fetch('/api/session');
  if (response.ok) {
    await open(await response.json());
  } else {
    login();
  }
} catch {
  stopped();
}

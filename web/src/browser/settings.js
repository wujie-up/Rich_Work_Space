import { api, el, field, iconButton, icons, switchButton, confirm, modal } from '../../../desk/src/renderer/ui.js';
import './settings.css';

// Account administration is exposed only by the native preload, never the web transport.
export async function mountWebSettings(view) {
  if (!api.web) {
    return;
  }
  const section = el('section', { class: 'web-settings', 'aria-label': '网页访问' });
  view.append(section);
  let status = await api.web.status();
  const controls = el('div', { class: 'web-setting-row' });
  section.append(controls);
  const content = el('div', { class: 'web-account-settings' });
  const refresh = async () => {
    status = await api.web.status();
    const accounts = await api.web.listAccounts();
    const port = el('input', { type: 'number', min: 1024, max: 65535, value: status.port, 'aria-label': '网页端口' });
    const enabled = switchButton('开启网页端', status.enabled, async () => {
      enabled.disabled = true;
      try {
        if (!port.reportValidity()) {
          return;
        }
        await api.web.configure({ enabled: !status.enabled, port: Number(port.value) });
      } finally {
        await refresh();
      }
    });
    const username = el('input', { autocomplete: 'username', maxlength: 64, placeholder: '账号', 'aria-label': '网页账号' });
    const password = el('input', { type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 256,
      placeholder: '至少 8 位密码', 'aria-label': '网页密码' });
    const save = iconButton(icons.check, '保存网页账号', async () => {
      save.disabled = true;
      try {
        await api.web.saveAccount(username.value, password.value);
        password.value = '';
        await refresh();
      } finally {
        save.disabled = false;
      }
    });
    controls.replaceChildren(el('span', { text: '网页访问' }), enabled,
      iconButton('M4 7h16M4 17h16M8 4v6M16 14v6', '网页访问设置', () => modal('网页访问', ({ body }) => {
        body.append(content);
      }, { placement: 'center' })));
    content.replaceChildren(field('端口（修改后重新开启）', port),
      el('p', { class: 'muted', text: '先创建账号，再开启。首次访问需信任本机 HTTPS 证书；账号共用当前工作空间。' }),
      el('p', { class: 'muted', text: `证书：${status.certificatePath}` }),
      ...status.addresses.map(url => el('a', { href: url, text: url, onclick: event => {
        event.preventDefault();
        api.host.openExternal(url);
      } })),
      ...(status.error ? [el('p', { text: status.error, role: 'alert' })] : []),
      el('div', { class: 'web-account-editor' }, username, password, save),
      ...accounts.map(account => el('div', { class: 'web-setting-row' }, el('span', { text: account.username }),
        iconButton(icons.remove, '删除网页账号', async () => {
          if (await confirm('删除网页账号', '删除后该账号的网页会话立即退出。')) {
            await api.web.removeAccount(account.username);
            await refresh();
          }
        }))));
  };
  await refresh();
}

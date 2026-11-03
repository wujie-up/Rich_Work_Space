import '../../../../desk/src/resource/controls.css';
import './style.css';
import { invoke, request } from './api.js';
import { button, help } from './ui.js';
import { loginControls } from './login-controls.js';

document.querySelector('#app').innerHTML = `<form id="settings-form" class="settings-form">
  <fieldset disabled>
    <label>授权模式<select id="authMode" aria-label="授权模式"><option value="web">网页登录</option><option value="token">已有访问令牌</option><option value="client">企业应用凭据</option></select></label>
    <p id="auth-impact" role="note"></p>
    <label>企业站点<input id="site" type="url" required></label>
    <div id="web-fields"><label>网页登录方式<select id="webMode" aria-label="网页登录方式"><option value="extension">现有 Chrome（浏览器扩展）</option><option value="window">独立登录窗口</option></select></label>
      <div id="login-controls" aria-label="PingCode 登录"></div></div>
    <div id="api-fields"><label>OpenAPI 地址<input id="apiRoot" type="url" required></label></div>
    <div id="token-fields"><label>访问令牌<input id="accessToken" type="password" autocomplete="off"></label>
      <label class="check"><input id="clearAccessToken" type="checkbox">删除已保存的访问令牌</label></div>
    <div id="client-fields" hidden><label>Client ID<input id="clientId" autocomplete="off"></label>
      <label>Client Secret<input id="clientSecret" type="password" autocomplete="off"></label>
      <label class="check"><input id="clearClientSecret" type="checkbox">删除已保存的 Client Secret</label></div>
    <label>默认项目 ID<input id="projectId" autocomplete="off"></label>
    <label>任务价值分字段键<input id="valueKey" pattern="[a-zA-Z0-9_]{1,128}" required></label>
    <div id="settings-actions" class="settings-actions"></div>
  </fieldset>
  <p id="status" role="status" aria-live="polite">正在读取配置…</p>
  </form>`;

const get = id => document.getElementById(id);
const fieldset = document.querySelector('fieldset');
const sessionControls = loginControls(get('login-controls'), async () => {
  const config = await invoke('pingcode.settings');
  sessionControls.update(config.webSession, false, config.authMode === 'web');
});
const save = button('save', '保存配置');
const docs = button('open', '打开 OpenAPI 文档');
get('settings-actions').append(help('连接配置说明',
  '默认通过配套扩展复用现有 Chrome 的 PingCode 标签页。首次安装说明在登录区域的帮助按钮中；断开连接不会退出浏览器账号。'
  + '也可选择原独立登录窗口，登录资料只保存在本插件数据目录。先保存站点和登录方式，再点击登录并检查状态。'
  + 'OpenAPI 应用凭据由 PingCode 企业后台的凭据管理提供，数据范围由管理员设置。已有用户令牌仅能访问该用户权限范围内的数据。'
  + '公有云 API 地址为 https://open.pingcode.com，私有部署使用管理员提供的地址。'
  + '密码框留空保留已保存值，勾选删除则清除；更换 API 地址会清除旧凭据，需重新填写。'
  + '默认项目留空查询全部可访问项目；价值分字段已按当前企业设为 renwujiazhifen。'), save, docs);

function mode() {
  const web = get('authMode').value === 'web';
  const client = get('authMode').value === 'client';
  get('web-fields').hidden = !web;
  get('api-fields').hidden = web;
  get('apiRoot').disabled = web;
  get('token-fields').hidden = client || web;
  get('client-fields').hidden = !client;
  docs.hidden = web;
  get('auth-impact').textContent = web ? get('webMode').value === 'window'
    ? '使用独立窗口中登录的账号权限读取任务，无需企业应用凭据。'
    : '通过扩展使用现有 Chrome 的 PingCode 登录。需要先加载配套扩展，无需企业应用凭据。'
    : client
    ? '企业令牌具有管理员级权限，请仅配置用于此查询的应用凭据及所需数据范围。'
    : '访问范围由此令牌的授权决定；令牌失效后需要重新配置。';
}

function fill(config) {
  for (const key of ['apiRoot', 'site', 'authMode', 'clientId', 'projectId', 'valueKey']) {
    get(key).value = config[key] || '';
  }
  get('webMode').value = config.webMode || 'extension';
  for (const [key, present] of [['accessToken', config.hasAccessToken], ['clientSecret', config.hasClientSecret]]) {
    get(key).value = '';
    get(key).placeholder = present ? '已配置；留空保留' : '尚未配置';
  }
  get('clearAccessToken').checked = false;
  get('clearClientSecret').checked = false;
  sessionControls.update(config.webSession, false, config.authMode === 'web');
  mode();
}

get('authMode').addEventListener('change', mode);
get('webMode').addEventListener('change', mode);
async function saveSettings(event) {
  event.preventDefault();
  if (fieldset.disabled) {
    return;
  }
  if (!get('settings-form').reportValidity()) {
    return;
  }
  const change = {};
  for (const key of ['apiRoot', 'site', 'authMode', 'webMode', 'clientId', 'projectId', 'valueKey', 'accessToken', 'clientSecret']) {
    change[key] = get(key).value;
  }
  change.clearAccessToken = get('clearAccessToken').checked;
  change.clearClientSecret = get('clearClientSecret').checked;
  fieldset.disabled = true;
  get('status').textContent = '正在保存…';
  try {
    fill(await invoke('pingcode.saveSettings', change));
    get('status').textContent = '已保存；返回查询页后重新搜索人员。';
    get('status').dataset.error = 'false';
  } catch (error) {
    get('status').textContent = error.message;
    get('status').dataset.error = 'true';
  } finally {
    fieldset.disabled = false;
  }
}
save.addEventListener('click', saveSettings);
get('settings-form').addEventListener('submit', event => event.preventDefault());
get('settings-form').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing && event.target.matches('input:not([type=checkbox])')) {
    saveSettings(event);
  }
});
docs.addEventListener('click', () => request('host.openExternal', ['https://open.pingcode.com/']).catch(error => {
  get('status').textContent = error.message;
  get('status').dataset.error = 'true';
}));
invoke('pingcode.settings').then(config => {
  fill(config);
  fieldset.disabled = false;
  get('status').textContent = config.authMode === 'web' ? '保存站点和登录方式后，点击登录按钮连接浏览器'
    : config.hasAccessToken || config.hasClientSecret ? '已加载连接配置' : '请填写 OpenAPI 授权信息';
}).catch(error => {
  get('status').textContent = error.message;
  get('status').dataset.error = 'true';
});

import { api, conversationApi } from './api.js';

const call = (method, ...args) => conversationApi.call(method, ...args);

// Reuse the same engine controls in the dedicated settings page and conversation panel.
export function engineSettings({ onChange = () => {}, onError }) {
  const $ = id => document.getElementById(id);
  let engines = [];
  let config;
  let timer;
  let loginId;
  let generation = 0;
  const selected = () => $('config-engine').value || 'codex';
  const action = fn => async event => {
    event?.preventDefault();
    try { await fn(); } catch (error) { onError(error); }
  };
  const poll = () => { timer ||= setInterval(() => refresh().catch(onError), 2500); };

  async function account(id, version) {
    const result = await call('conversation.account', 'account/read', { refreshToken: false }, id);
    if (version !== generation) { return; }
    $('account').textContent = result.account ? `${result.account.email || result.account.type} · ${result.account.planType || ''}` : '尚未登录';
    if (result.login) {
      $('login-status').textContent = result.login.error || ({ waiting: '等待浏览器登录…', complete: '登录完成' }[result.login.state] || '');
      showLogin(result.login);
      if (result.login.state === 'waiting') { poll(); }
    }
  }

  function showLogin(result) {
    const url = result.authUrl || result.verificationUrl;
    if (!url) { return; }
    $('login-link').replaceChildren();
    const link = document.createElement('a');
    link.href = url;
    link.onclick = action(() => api.host.openExternal(url));
    link.textContent = result.userCode ? `打开登录页面，输入 ${result.userCode}` : '打开浏览器完成独立登录';
    link.rel = 'noopener noreferrer';
    $('login-link').append(link);
  }

  async function refresh() {
    const version = ++generation;
    [engines, config] = await Promise.all([call('engines.list'), call('engines.config')]);
    const id = selected();
    const engine = engines.find(engine => engine.id === id);
    $('engine-info').textContent = `${engine.name} ${engine.pin.version} · ${engine.pin.platform}\n独立目录：${engine.command || '本插件数据目录（安装后显示程序路径）'}\n来源：${engine.pin.url}\nSHA-256：${engine.pin.sha256}`;
    $('default-engine').checked = config.defaultEngine === id;
    $('reuse-skills').checked = config.engines[id]?.reuseSkills === true;
    $('reuse-rules').checked = config.engines[id]?.reuseRules === true;
    $('source-info').textContent = `授权来源：${engine.sources.auth}（macOS 也支持本机钥匙串）\n技能：${engine.sources.skills.join('、')}\n规范：${engine.sources.rules.join('、')}；工作目录规范由引擎原生读取`;
    const installing = engine.installation.state === 'installing';
    $('installation').textContent = installing ? '正在下载、校验并验证原生程序…' : engine.installation.error || (engine.state === 'ready' ? '已安装' : '尚未安装');
    for (const name of ['install', 'import', 'remove-engine']) { $(name).disabled = installing; }
    for (const name of ['login', 'device-login', 'logout']) { $(name).disabled = engine.state !== 'ready'; }
    $('device-login').hidden = id !== 'codex';
    $('login').textContent = id === 'codex' ? '独立登录 ChatGPT' : '独立登录 Claude Code';
    await onChange(engines, config);
    if (installing) { poll(); }
    else if (timer) { clearInterval(timer); timer = null; }
    if (engine.state === 'ready') { await account(id, version); }
    else { $('account').textContent = '安装后可独立登录'; }
  }

  async function save() {
    const id = selected();
    await call('engines.configure', { defaultEngine: $('default-engine').checked ? id : config.defaultEngine,
      engines: { [id]: { reuseSkills: $('reuse-skills').checked, reuseRules: $('reuse-rules').checked } } });
    $('source-status').textContent = '已保存；技能和规范在下一次启动引擎时同步。';
    await refresh();
  }

  $('config-engine').onchange = action(async () => {
    $('login-link').replaceChildren();
    $('login-status').textContent = '';
    await refresh();
  });
  $('install').onclick = action(async () => { await call('engines.install', selected()); await refresh(); });
  $('choose-archive').onclick = action(async () => {
    const path = await api.host.chooseFile({ extensions: ['gz', 'tgz'], title: '选择离线引擎包' });
    if (path) { $('archive-path').value = path; }
  });
  $('import').onclick = action(async () => {
    const path = $('archive-path').value.trim();
    if (!path.startsWith('/')) { throw Error('请输入离线引擎包的绝对路径'); }
    await call('engines.install', selected(), path);
    await refresh();
  });
  $('remove-engine').onclick = action(async () => { await call('engines.remove', selected()); await refresh(); });
  for (const id of ['default-engine', 'reuse-skills', 'reuse-rules']) { $(id).onchange = action(save); }
  $('reuse-auth').onclick = action(async () => {
    await call('engines.importAuth', selected());
    $('source-status').textContent = '已复制本机授权；后续独立更新，不修改本机授权。';
    await refresh();
  });
  for (const [id, type] of [['login', 'chatgpt'], ['device-login', 'chatgptDeviceCode']]) {
    $(id).onclick = action(async () => {
      const result = await call('conversation.account', 'account/login/start', { type }, selected());
      loginId = result.loginId;
      showLogin(result);
      poll();
    });
  }
  $('cancel-login').onclick = action(async () => {
    await call('conversation.account', 'account/login/cancel', { loginId }, selected());
    $('login-link').replaceChildren();
    $('login-status').textContent = '已取消登录';
    await refresh();
  });
  $('logout').onclick = action(async () => {
    await call('conversation.account', 'account/logout', {}, selected());
    $('login-link').replaceChildren();
    await refresh();
  });
  conversationApi.onAccount(() => refresh().catch(onError));
  window.addEventListener('pagehide', () => clearInterval(timer));
  return { refresh };
}

import { pluginIdentity } from '../../../../desk/src/resource/plugin-host.js';
import './settings.css';
import settingsDocument from '../resource/settings.html';
import { api, el, field, setButtonIcon, confirm as confirmAction } from './ui.js';
import { conversationApi } from './api.js';
import { localizeSettings } from './settings-i18n.js';
import { engineSettings } from './engine-settings.js';
import { mountFontSizeSetting } from './appearance.js';

export function mountSettings(root, { pluginId = pluginIdentity(), onEnginesChange = () => {}, adapters = [
  { id: 'codex', name: 'Codex' }, { id: 'custom', name: '自定义 CLI' }
] } = {}) {
  root.classList.add('engine-page');
  const content = new DOMParser().parseFromString(settingsDocument, 'text/html').querySelector('main');
  root.replaceChildren(...content.childNodes);
  const $ = id => root.querySelector(`#${id}`);
  const disposeFontSize = mountFontSizeSetting(root);
  let disposed = false;
  let localization;
  const cliInputs = new Map();
  const call = (method, ...args) => conversationApi.call(method, ...args);
  const onError = error => { $('notice').textContent = error.message; };
  const action = fn => async event => {
    event?.preventDefault();
    $('notice').textContent = '';
    try { await fn(); } catch (error) { onError(error); }
  };
  let config;
  let providers = [];
  let editing;
  let engineId;
  const help = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 8a2.6 2.6 0 0 1 5 1c0 2-2.5 2-2.5 4M12 16v1"/></svg>';
  for (const element of root.querySelectorAll('.help')) { element.innerHTML = help; }
  for (const button of root.querySelectorAll('[data-tab]')) {
    button.onclick = action(async () => {
      for (const tab of root.querySelectorAll('[data-tab]')) { tab.setAttribute('aria-selected', String(tab === button)); }
      for (const panel of root.querySelectorAll('[data-panel]')) { panel.hidden = panel.dataset.panel !== button.dataset.tab; }
      root.querySelector('.engine-selector').hidden = button.dataset.tab === 'appearance';
      if (button.dataset.tab === 'mcp') { await loadServices(); }
      if (button.dataset.tab === 'engine') { await loadProviders(); }
      if (button.dataset.tab === 'cli') { await loadCli(); }
    });
  }

  function resetProvider() {
    editing = undefined;
    $('provider-form').reset();
    $('provider-heading').textContent = '添加供应商';
    $('provider-protocol').value = engineId === 'codex' ? 'Responses API' : 'Anthropic Messages';
    $('provider-model').value = '';
    $('provider-form').hidden = true;
    $('model-editor').hidden = true;
    root.querySelector('.model-summary').hidden = false;
  }

  // Keep a provider draft in the existing form while moving between connection and model steps.
  function showStep(step) {
    if (step === 'model' && !$('provider-form').hidden) {
      const fields = [...$('provider-form').querySelectorAll('input, select')];
      const invalid = fields.find(input => !input.checkValidity());
      if (invalid) {
        showStep('connect');
        invalid.reportValidity();
        return;
      }
    }
    for (const button of root.querySelectorAll('[data-step]')) {
      if (button.dataset.step === step) { button.setAttribute('aria-current', 'step'); }
      else { button.removeAttribute('aria-current'); }
    }
    for (const panel of root.querySelectorAll('[data-step-panel]')) { panel.hidden = panel.dataset.stepPanel !== step; }
    $('model-editor').hidden = $('provider-form').hidden;
    root.querySelector('.model-summary').hidden = !$('provider-form').hidden;
    $('setup-status').hidden = !$('provider-form').hidden;
  }

  for (const button of root.querySelectorAll('[data-step]')) { button.onclick = () => showStep(button.dataset.step); }
  setButtonIcon($('provider-add'), '新增连接', 'create');
  $('provider-add').append(el('span', { text: '新增连接' }));
  $('provider-add').classList.remove('icon-button');
  $('provider-add').onclick = () => {
    resetProvider();
    $('provider-form').hidden = false;
    $('provider-name').focus();
  };

  // Templates identify brands; the selected engine's wire protocol remains explicit and must be tested.
  $('provider-template').onchange = () => {
    const template = $('provider-template').value;
    const names = { openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek', qwen: '千问', kimi: 'Kimi' };
    const urls = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com',
      deepseek: 'https://api.deepseek.com/anthropic', qwen: 'https://dashscope.aliyuncs.com/apps/anthropic',
      kimi: 'https://api.kimi.ai/coding' };
    $('provider-name').value = names[template] || '';
    $('provider-url').value = engineId === 'claude' || template === 'openai' ? urls[template] || '' : '';
    $('provider-model').value = '';
  };
  $('provider-reset').onclick = resetProvider;
  // The host sandbox blocks native form submission; save explicitly without relaxing its permissions.
  $('provider-save').onclick = action(async () => {
    if (!$('provider-form').reportValidity()) { return; }
    const input = { id: editing, name: $('provider-name').value, engineId,
      protocol: engineId === 'codex' ? 'responses' : 'anthropic', baseUrl: $('provider-url').value,
      model: $('provider-model').value, apiKey: $('provider-secret').value, clearSecret: $('clear-secret').checked };
    if (input.clearSecret) {
      const name = providers.find(profile => profile.id === input.id)?.name || input.name;
      if (!await confirmAction('清除已保存密钥', `保存本次配置并清除供应商“${name}”已保存的 API 密钥？配置和历史记录将保留，后续使用该供应商需要重新填写密钥。`)) {
        return;
      }
    }
    const profile = await call('providers.save', input);
    $('provider-secret').value = '';
    $('provider-status').textContent = `已保存 ${profile.name}；尚未验证引擎兼容性`;
    config = await call('engines.configure', { engines: { [input.engineId]: { providerId: profile.id } } });
    resetProvider();
    await loadProviders();
    $('setup-status').hidden = false;
    $('setup-status').textContent = `已保存 ${profile.name}；尚未验证引擎兼容性`;
  });

  // Keep saved connection details visible without mixing them with the new-connection form.
  function providerActions(profile) {
    const selected = config.engines[engineId]?.providerId === profile.id;
    const row = el('article', { class: 'connection-card', 'data-active': String(selected) },
      el('div', { class: 'connection-details' },
        el('div', { class: 'connection-heading' }, el('strong', { text: profile.name }),
          el('span', { class: 'connection-badge', text: '当前选择', hidden: !selected })),
        el('p', { class: 'connection-url', text: profile.baseUrl }),
        el('p', { text: `${profile.model} · ${profile.hasSecret ? '已保存密钥' : '未配置密钥'}` })));
    for (const [name, handler] of [
      ['编辑', () => {
        editing = profile.id;
        $('provider-form').hidden = false;
        $('provider-heading').textContent = `编辑 ${profile.name}`;
        for (const [field, value] of [['name', profile.name], ['url', profile.baseUrl], ['model', profile.model]]) {
          $(`provider-${field}`).value = value;
        }
        $('provider-secret').value = '';
        $('clear-secret').checked = false;
        $('provider-form').scrollIntoView({ block: 'nearest' });
      }],
      ['测试连接', async () => {
        $('provider-status').textContent = '正在测试连接…';
        await call('providers.test', engineId, profile.id);
        $('provider-status').textContent = '接口协议测试通过；尚未验证模型在引擎中的工具调用';
      }],
      ['删除', async () => {
        if (!await confirmAction('删除供应商', `删除供应商 ${profile.name}？使用它的历史会话将要求重新配置。`)) { return; }
        await call('providers.remove', profile.id);
        resetProvider();
        await loadProviders();
      }]
    ]) {
      const button = document.createElement('button');
      setButtonIcon(button, name, { 编辑: 'rename', 测试连接: 'debug', 删除: 'clear' }[name]);
      button.onclick = action(handler);
      row.append(button);
    }
    return row;
  }

  async function loadProviders() {
    const id = engineId;
    const values = await call('providers.list');
    if (id !== engineId) { return; }
    providers = values.filter(profile => profile.engineId === id);
    const selected = config.engines[engineId]?.providerId || '';
    const ordered = providers.toSorted((left, right) => Number(right.id === selected) - Number(left.id === selected));
    $('provider-list').replaceChildren(...ordered.map(providerActions));
    const option = (value, label) => new Option(label, value);
    $('active-provider').replaceChildren(option('', '独立账户登录'), ...providers.map(profile => option(profile.id, profile.name)));
    if (selected && !providers.some(profile => profile.id === selected)) {
      $('active-provider').add(option(selected, '供应商已删除，请重新选择'));
    }
    $('active-provider').value = selected;
    $('account-card').dataset.active = String(!selected);
    $('account-selected').hidden = Boolean(selected);
    const profile = providers.find(profile => profile.id === selected);
    $('summary-engine').textContent = $('config-engine').selectedOptions[0].textContent;
    $('summary-provider').textContent = $('active-provider').selectedOptions[0].textContent;
    $('summary-model').textContent = profile?.model || (selected ? '供应商已删除，请重新选择' : '由引擎账户选择');
    $('setup-status').textContent = selected && !profile ? '供应商已删除，请重新选择' : '当前选择将用于新建会话';
  }
  $('active-provider').onchange = action(async () => {
    config = await call('engines.configure', { engines: { [engineId]: { providerId: $('active-provider').value } } });
    $('provider-status').textContent = '已选择，下一次新建会话生效；现有会话保持原配置';
    resetProvider();
    await loadProviders();
  });

  async function loadServices() {
    const id = engineId;
    const services = await call('mcp.catalog');
    if (id !== engineId) { return; }
    const selection = config.engines[engineId]?.mcp || { mode: 'all', services: [] };
    $('mcp-all').checked = selection.mode === 'all';
    const known = new Set(services.map(service => JSON.stringify([service.pluginId, service.serviceId])));
    const missing = selection.services.filter(service => !known.has(JSON.stringify([service.pluginId, service.serviceId])))
      .map(service => ({ ...service, name: service.serviceId, state: 'unavailable' }));
    $('service-list').replaceChildren(...[...services, ...missing].map(service => {
      const row = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.plugin = service.pluginId;
      checkbox.dataset.service = service.serviceId;
      checkbox.checked = selection.services.some(item => item.pluginId === service.pluginId && item.serviceId === service.serviceId);
      row.append(checkbox, document.createTextNode(`${service.name} · ${service.state === 'ready' ? '可用' : '不可用'} · ${service.pluginId}`));
      return row;
    }));
    $('mcp-status').textContent = services.length ? '服务由工作台能力协议发现，新会话应用当前选择' : '未发现服务，请先在 MCP 插件中启动服务';
  }
  $('refresh-services').onclick = action(loadServices);
  $('save-services').onclick = action(async () => {
    const services = [...root.querySelectorAll('#service-list input:checked')]
      .map(input => ({ pluginId: input.dataset.plugin, serviceId: input.dataset.service }));
    config = await call('engines.configure', { engines: { [engineId]: { mcp: { mode: $('mcp-all').checked ? 'all' : 'selected', services } } } });
    $('mcp-status').textContent = '已保存，下一次新建会话生效';
  });
  $('load-versions').onclick = action(async () => {
    const id = engineId;
    $('load-versions').disabled = true;
    $('versions-status').textContent = '正在读取官方版本和校验信息…';
    try {
      const versions = await call('engines.versions', id);
      if (id !== engineId) { return; }
      const previous = $('target-version').value;
      versions.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
      $('target-version').replaceChildren(new Option('内置校验版本', ''), ...versions.map(item => new Option(item.version, item.version)));
      // Checking for updates must select an online release instead of silently reinstalling the built-in pin.
      $('target-version').value = versions.some(item => item.version === previous) ? previous : versions[0]?.version || '';
      $('versions-status').textContent = `已获取 ${versions.length} 个可校验版本`;
    } catch (error) {
      console.error('[ai:release-check-error]', { pluginId, engineId: id, stack: error.stack });
      if (id !== engineId || disposed) { return; }
      // An optional version lookup must leave the selected version and the rest of setup usable.
      $('versions-status').textContent = '在线版本检查失败；已保留原有选择，可稍后重试，或使用内置校验版本、离线包安装。';
    } finally { $('load-versions').disabled = false; }
  });
  const controls = engineSettings({ root, onError, onLoading: loading => {
    // Keep the old engine's form inert until the new engine's choices have arrived.
    $('settings').inert = loading;
    $('settings').setAttribute('aria-busy', String(loading));
  }, onChange: async (engines, next) => {
    config = next;
    await onEnginesChange(engines, next);
    const id = $('config-engine').value;
    if (engineId !== id) {
      engineId = id;
      $('target-version').replaceChildren(new Option('内置校验版本', ''));
      $('versions-status').textContent = '';
      resetProvider();
      showStep(engines.find(engine => engine.id === id).state === 'ready' ? (next.engines[id]?.providerId ? 'model' : 'connect') : 'install');
    }
    root.querySelector('[data-step="install"]').dataset.complete = String(engines.find(engine => engine.id === id).state === 'ready');
    await Promise.all([loadProviders(), loadServices()]);
  } });
  async function loadCli() {
    const cliConfig = await api.storage.getAdapterConfig(pluginId);
    cliInputs.clear();
    const panel = $('cli-fields');
    panel.replaceChildren();
    for (const adapter of adapters.filter(adapter => adapter.id !== 'claude')) {
      const value = cliConfig[adapter.id] || {};
      if (adapter.id === 'codex') {
        const mode = el('select', { 'aria-label': 'Codex 运行模式' },
          el('option', { value: 'managed', text: '受管独立引擎（默认）' }),
          el('option', { value: 'legacy', text: 'Legacy：外部系统 CLI 与原有登录' }));
        mode.value = value.mode || 'managed';
        panel.append(field('Codex 运行模式', mode));
        cliInputs.set('mode', mode);
      }
      const command = el('input', { value: value.command || (adapter.id === 'codex' ? 'codex' : ''),
        placeholder: '可执行文件绝对路径或 PATH 命令名' });
      const args = el('textarea', { 'aria-label': '参数（JSON 字符串数组）', rows: 3, spellcheck: false, text: JSON.stringify(value.args || []) });
      panel.append(el('h3', { text: adapter.name || adapter.id }), field('可执行文件', command), field('参数（JSON 字符串数组）', args));
      cliInputs.set(adapter.id, { command, args });
    }
  }
  $('save-cli').onclick = action(async () => {
    const changes = {};
    for (const [id, input] of cliInputs) {
      if (id === 'mode') { continue; }
      let args;
      try { args = JSON.parse(input.args.value); } catch { throw Error('参数必须为 JSON 字符串数组'); }
      if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) { throw Error('参数必须为 JSON 字符串数组'); }
      changes[id] = { command: input.command.value.trim(), args, ...(id === 'codex' ? { mode: cliInputs.get('mode').value } : {}) };
    }
    const next = await api.storage.getAdapterConfig(pluginId);
    for (const [id, change] of Object.entries(changes)) { next[id] = { ...next[id], ...change }; }
    await api.storage.saveAdapterConfig(pluginId, next);
    $('cli-status').textContent = '已保存，下一次新建会话生效';
  });

  // Help is available to keyboard users as well as pointer users.
  const tooltips = new Map();
  for (const [index, help] of [...root.querySelectorAll('.help')].entries()) {
    help.type = 'button';
    const tooltip = el('span', { class: 'settings-tooltip', role: 'tooltip', id: `settings-help-${index}-${crypto.randomUUID()}` });
    help.setAttribute('aria-describedby', tooltip.id);
    help.append(tooltip);
    tooltips.set(help, tooltip);
  }
  const updateHelp = () => {
    for (const [help, tooltip] of tooltips) { tooltip.textContent = help.title || ''; }
  };
  const helpObserver = new MutationObserver(updateHelp);
  helpObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ['title'] });
  updateHelp();
  const ready = (async () => {
    localization = await localizeSettings(root);
    if (disposed) { localization?.(); return; }
    resetProvider();
    await controls.refresh();
  })().catch(onError);
  return { ready, dispose() {
    disposed = true;
    controls.dispose();
    disposeFontSize();
    localization?.();
    helpObserver.disconnect();
  } };
}

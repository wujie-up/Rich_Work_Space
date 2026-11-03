import { api } from './api.js';

const labels = {
  '显示': 'Display', '会话字号': 'Conversation font size', '字号适用范围': 'Font size scope',
  '应用于所有会话组、会话内容和输入区，立即生效并自动保存。': 'Applies to all session groups, conversations and input areas. Saved and applied immediately.',
  '角色维护': 'Agent roles', '新增角色': 'Add role', '编辑角色': 'Edit role', '删除角色': 'Delete role',
  '角色名称': 'Role name', '职责说明': 'Responsibilities', '保存角色': 'Save role', '暂无角色': 'No roles',
  '已配置的账号与连接': 'Configured accounts & connections', '新增账号或连接': 'Add account or connection',
  '引擎账号': 'Engine account', '登录引擎账号': 'Sign in to engine account', '新增连接': 'Add connection', '当前选择': 'Selected',
  '配置向导': 'Setup', '高级设置': 'Advanced', '配置步骤': 'Setup steps', '安装引擎': 'Install engine',
  '连接': 'Connect', '选择连接方式': 'Choose connection', '账户登录': 'Account login', '引擎': 'Engine',
  '已保存的供应商': 'Saved providers', '确认模型': 'Confirm model', '从离线包安装': 'Install from offline package',
  '上一步': 'Previous step', '下一步': 'Next step', '本机配置复用': 'Reuse local configuration',
  '外部 CLI 参数': 'External CLI parameters', '由引擎账户选择': 'Selected by the engine account',
  '当前选择将用于新建会话': 'Current selection applies to new sessions.',
  'AI 引擎配置': 'AI engine settings', '配置分类': 'Settings categories', '当前配置引擎': 'Engine',
  '引擎与账户': 'Engines & accounts', 'MCP 服务': 'MCP services', '模型供应商': 'Model providers',
  '设为默认引擎': 'Default engine', '目标版本': 'Target version', '内置校验版本': 'Bundled verified version',
  '检查在线版本': 'Check online versions', '在线安装': 'Install online', '选择离线包': 'Choose offline package',
  '离线 tar.gz 引擎包的绝对路径': 'Absolute path to offline tar.gz engine package', '离线引擎包路径': 'Offline engine package',
  '导入离线包': 'Import offline package', '移除引擎': 'Remove engine', '尚未安装': 'Not installed', '已安装': 'Installed',
  '独立登录': 'Sign in', '独立登录 ChatGPT': 'Sign in to ChatGPT', '独立登录 Claude Code': 'Sign in to Claude Code',
  '设备码登录': 'Device code login', '取消登录': 'Cancel login', '退出登录': 'Sign out', '复制本机授权': 'Copy local credentials',
  '尚未读取账户': 'Account not loaded', '安装后可独立登录': 'Install an engine to sign in', '尚未登录': 'Not signed in',
  '复用本机 skills': 'Reuse local skills', '复用本机全局规范': 'Reuse local global rules',
  '刷新服务': 'Refresh services', '自动使用全部已启动服务': 'Use all started services automatically',
  '保存服务选择': 'Save service selection', '当前供应商': 'Active provider', '添加供应商': 'Add provider',
  '模板': 'Template', '自定义兼容接口': 'Custom compatible API', '名称': 'Name', '协议': 'Protocol',
  '接口地址': 'Base URL', '模型': 'Model', '留空保留原密钥': 'Leave blank to keep the saved key',
  '清除已保存密钥': 'Clear saved key', '保存': 'Save', '取消编辑': 'Cancel editing', '千问': 'Qwen',
  '编辑': 'Edit', '测试连接': 'Test connection', '删除': 'Delete', '独立账户登录': 'Independent account login',
  '供应商已删除，请重新选择': 'Provider removed; select another',
  '未发现服务，请先在 MCP 插件中启动服务': 'No services found. Start a service in the MCP plugin.',
  '服务由工作台能力协议发现，新会话应用当前选择': 'Discovered through workspace capabilities. Selection applies to new sessions.',
  '已保存，下一次新建会话生效': 'Saved. Applies to new sessions.',
  '已选择，下一次新建会话生效；现有会话保持原配置': 'Selected. New sessions use this provider; existing sessions keep their settings.',
  '正在测试连接…': 'Testing connection…',
  '接口协议测试通过；尚未验证模型在引擎中的工具调用': 'API protocol test passed. Engine tool calling has not been verified.',
  '正在读取官方版本和校验信息…': 'Loading official versions and checksums…',
  '在线版本检查失败；已保留原有选择，可稍后重试，或使用内置校验版本、离线包安装。': 'Online version check failed. Your selection is unchanged. Retry later, or install the bundled verified version or an offline package.',
  '引擎隔离说明': 'Engine isolation', '供应商协议说明': 'Provider protocol',
  '引擎与登录分别保存在插件独立空间。移除引擎保留配置、授权和历史。': 'Engines and credentials are stored in plugin-owned space. Removing an engine keeps settings, credentials and history.',
  'Codex 要求 Responses API；Claude Code 要求 Anthropic Messages 兼容接口。品牌名称不代表协议兼容，Chat Completions 接口不能直接供 Codex 使用。连接测试会产生一次小请求；保存不代表引擎验证通过。': 'Codex requires Responses API; Claude Code requires Anthropic Messages compatibility. Brand names do not guarantee compatibility. Connection testing sends a small request; saving does not verify the engine.'
};

// Translate only this page's UI text; never touch input values, provider names or credentials.
export async function localizeSettings(root = document.body) {
  const preferences = await api.storage.getPreferences();
  document.documentElement.dataset.theme = preferences.theme;
  const english = (preferences.language === 'system' || !preferences.language ? navigator.language : preferences.language).startsWith('en');
  if (!english) { return; }
  document.documentElement.lang = 'en';
  const translate = text => labels[text] || text;
  const visit = root => {
    if (root.nodeType === Node.TEXT_NODE) {
      const original = root.textContent.trim();
      const translated = translate(original);
      if (translated !== original) { root.textContent = root.textContent.replace(original, translated); }
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || ['SCRIPT', 'STYLE', 'TEXTAREA'].includes(root.tagName)) { return; }
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      const original = root.getAttribute(attribute);
      if (original && translate(original) !== original) { root.setAttribute(attribute, translate(original)); }
    }
    for (const child of root.childNodes) { visit(child); }
  };
  visit(root);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData' || record.type === 'attributes') { visit(record.target); }
      else { for (const node of record.addedNodes) { visit(node); } }
    }
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder'] });
  return () => observer.disconnect();
}

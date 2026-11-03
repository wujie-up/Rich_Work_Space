import { invoke, escape, action } from './api.js';

const help = (id, text) => `<span class="builtin-help"><button type="button" class="icon-button" title="配置说明" aria-label="配置说明" aria-describedby="${id}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 2-2.5 2-2.5 4M12 17h.01"/></svg></button><span role="tooltip" id="${id}">${escape(text)}</span></span>`;

// Credentials stay in the owner configuration view and never enter model prompts or tool descriptions.
export function renderBuiltinTools(container, config) {
  container.innerHTML = `<form id="builtin-config"><div class="row builtin-heading"><strong>飞书文档与电脑工具</strong>
${help('builtin-description', '启用后通过工作台向工作流 Agent 提供工具。不会改动已有 MCP 服务配置。需要外部授权时会弹窗，用户确认后才能继续。')}</div>
<label><input name="feishuEnabled" type="checkbox" role="switch" ${config.feishuEnabled ? 'checked' : ''}>飞书文档</label>
<div class="row builtin-heading"><span>飞书凭据</span>${help('feishu-credentials', 'App ID / App Secret 来自飞书自建应用；为应用开通文档读取权限和知识库读取权限，并将文档授权给该应用。也可填写用户访问令牌，填写后优先使用；令牌过期需更新。密钥只保存在本机，不要在 Agent 对话中填写。支持 docx 和 wiki 文档链接。')}</div>
<label>App ID<input name="appId" value="${escape(config.appId)}" autocomplete="off" spellcheck="false"></label>
<label>App Secret<input name="appSecret" type="password" value="${escape(config.appSecret)}" autocomplete="off"></label>
<label>用户访问令牌（可选）<input name="userAccessToken" type="password" value="${escape(config.userAccessToken)}" autocomplete="off"></label>
<label><input name="computerEnabled" type="checkbox" role="switch" ${config.computerEnabled ? 'checked' : ''}>macOS 电脑操作</label>
<div class="row builtin-heading"><span>截图、点击、输入、按键、滚动及打开网页</span>${help('computer-permissions', '首次使用需在 macOS 系统设置 → 隐私与安全性中，为 DeckPg 开启屏幕录制和辅助功能。授权不足时弹窗确认。操作作用于当前电脑前台窗口；工作流停止或插件停用会取消未完成的调用。')}</div>
<div class="row actions"><button id="save-builtin" type="button" class="icon-button" title="保存工具配置" aria-label="保存工具配置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h14l3 3v15H3V3z M7 3v6h10V3 M7 21v-8h10v8"/></svg></button><span id="builtin-status" role="status"></span></div></form>`;
  const form = container.querySelector('#builtin-config');
  form.onsubmit = event => event.preventDefault();
  // Plugin frames intentionally disallow form submission; save through the desktop bridge.
  form.querySelector('#save-builtin').onclick = () => action(async () => {
    await invoke('mcp.builtin.save', { feishuEnabled: form.elements.feishuEnabled.checked,
      computerEnabled: form.elements.computerEnabled.checked, appId: form.elements.appId.value,
      appSecret: form.elements.appSecret.value, userAccessToken: form.elements.userAccessToken.value });
    form.querySelector('#builtin-status').textContent = '已保存';
  });
  form.oninput = () => { form.querySelector('#builtin-status').textContent = ''; };
}

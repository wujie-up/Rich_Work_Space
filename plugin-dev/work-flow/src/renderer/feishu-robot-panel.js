// Keep credential fields mounted across node selections, and never refill them from saved configuration.
export function createFeishuRobotPanel(container, { invoke, setStatus }) {
  let configuration = { configured: false, hasKey: false, webhookHint: '' };
  let loaded = false;
  let busy = false;
  container.innerHTML = `<style>
    #feishu-robot-panel .robot-actions { position: relative; display: flex; justify-content: flex-end; gap: 6px; }
    #feishu-robot-hint { display: none; position: absolute; right: 0; top: 100%; z-index: 3;
      width: min(260px, calc(100vw - 24px)); padding: 10px; line-height: 1.6; }
    #feishu-robot-help:hover + #feishu-robot-hint, #feishu-robot-help:focus + #feishu-robot-hint { display: block; }
    #feishu-robot-state { overflow-wrap: anywhere; }
    </style><p id="feishu-robot-state" role="status">未配置</p>
    <label>Webhook<input id="feishu-robot-webhook" type="password" autocomplete="off" spellcheck="false"></label>
    <label>签名密钥<input id="feishu-robot-key" type="password" autocomplete="off" spellcheck="false"></label>
    <div class="robot-actions"><span class="robot-help">
      <button type="button" id="feishu-robot-help" class="icon-button" title="飞书机器人配置说明"
        aria-label="飞书机器人配置说明" aria-describedby="feishu-robot-hint"><svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3.5 M12 17v.1"/></svg></button>
      <span id="feishu-robot-hint" role="tooltip">填写飞书群自定义机器人的 Webhook 和签名密钥。
        编辑时字段留空保留原值。测试仅使用已保存配置，发送标记为测试的通知；有未保存输入时请先保存。</span></span>
      <button type="button" id="feishu-robot-save" class="icon-button" title="保存飞书机器人" aria-label="保存飞书机器人">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h12l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8"/></svg></button>
      <button type="button" id="feishu-robot-test" class="icon-button" title="发送飞书测试通知" aria-label="发送飞书测试通知">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 18-8-8 18-2-8z M11 13 21 3"/></svg></button>
    </div>`;
  const webhook = container.querySelector('#feishu-robot-webhook');
  const key = container.querySelector('#feishu-robot-key');
  const save = container.querySelector('#feishu-robot-save');
  const test = container.querySelector('#feishu-robot-test');

  function render() {
    container.querySelector('#feishu-robot-state').textContent = configuration.configured
      ? `已配置 · ${configuration.webhookHint} · ${configuration.hasKey ? '已设置签名密钥' : '未设置签名密钥'}` : '未配置';
    webhook.disabled = busy;
    key.disabled = busy;
    save.disabled = busy || !loaded;
    test.disabled = busy || !loaded || !configuration.configured || Boolean(webhook.value || key.value);
  }

  // Serialize read/save/test so a late read cannot replace a newer saved status or clear draft input.
  async function perform(method) {
    if (busy) {
      return;
    }
    busy = true;
    render();
    try {
      const result = method === 'save'
        ? await invoke('robots.feishu.save', { webhook: webhook.value, key: key.value })
        : await invoke(`robots.feishu.${method}`);
      if (method === 'test') {
        setStatus(`飞书测试通知已发送（${result.sentParts}/${result.totalParts}）。`);
      } else {
        configuration = result;
        loaded = true;
        if (method === 'save') {
          webhook.value = '';
          key.value = '';
          setStatus('飞书机器人配置已保存。');
        }
      }
    } catch {
      // Provider failures may include request URLs; keep credentials out of visible errors.
      setStatus(method === 'test' ? '飞书测试通知未确认成功，请先核对群消息后再测试。'
        : `飞书机器人${({ read: '配置读取', save: '配置保存' })[method]}失败，请重试。`, true);
    } finally {
      busy = false;
      render();
    }
  }

  webhook.addEventListener('input', render);
  key.addEventListener('input', render);
  save.addEventListener('click', () => perform('save'));
  test.addEventListener('click', () => perform('test'));
  render();
  return { show(visible) {
    container.closest('details').hidden = !visible;
    if (visible && !loaded) {
      perform('read');
    }
  } };
}

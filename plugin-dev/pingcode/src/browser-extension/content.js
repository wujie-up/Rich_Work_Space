if (location.protocol === 'http:' && location.hostname === '127.0.0.1' && location.pathname === '/pair'
  && /^#[A-Za-z0-9_-]{43}$/.test(location.hash)) {
  const container = document.getElementById('extension-pairing');
  const state = document.getElementById('state');
  if (container && state) {
    const button = document.createElement('button');
    button.title = '确认连接此工作台';
    button.setAttribute('aria-label', '确认连接此工作台');
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 5 10 7-10 7Z"/></svg>';
    container.append(button);
    state.textContent = '已检测到 PingCode 扩展。点击连接按钮，允许此工作台通过浏览器读取 PingCode。';
    button.addEventListener('click', async event => {
      if (!event.isTrusted) { return; }
      button.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({ type: 'request-pair', pairing: { origin: location.origin, token: location.hash.slice(1) } });
        state.textContent = result?.ok ? '请在扩展自己的页面中确认连接。' : '连接失败，请重新从工作台打开连接页。';
      } catch { state.textContent = '扩展不可用，请刷新此页后重试。'; }
      button.disabled = false;
    });
  }
}

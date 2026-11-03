async function update() {
  const result = await chrome.runtime.sendMessage({ type: 'status' });
  document.getElementById('status').textContent = result.connected ? '已连接工作台，使用当前浏览器的 PingCode 标签页'
    : result.paired ? '已配对，正在等待工作台。请确认 PingCode 插件已启用。' : '尚未连接工作台';
  document.getElementById('disconnect').disabled = !result.paired;
}
for (const type of ['retry', 'disconnect']) {
  document.getElementById(type).addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type });
    await update();
  });
}
update();

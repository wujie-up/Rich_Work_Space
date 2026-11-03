const id = location.hash.slice(1);
const button = document.getElementById('approve');
const status = document.getElementById('status');
const info = await chrome.runtime.sendMessage({ type: 'pair-info', id });
if (info?.ok) {
  document.getElementById('endpoint').textContent = '本机地址：' + info.origin;
  status.textContent = '请确认此连接由你刚才在工作台中发起。';
  button.disabled = false;
} else {
  status.textContent = '待确认连接已失效，请从工作台重新打开连接页。';
}
button.addEventListener('click', async event => {
  if (!event.isTrusted) { return; }
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'confirm-pair', id });
    status.textContent = result?.ok ? '已保存连接。返回工作台点击检查登录状态。此页可以关闭。' : '连接未保存，请重新从工作台发起。';
  } catch { status.textContent = '扩展连接失败，请重新发起连接。'; }
});

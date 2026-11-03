import { createCommands } from './commands.js';

const commands = createCommands(chrome);
let socket;
let pairing;
let connecting;
let timer;
let generation = 0;
const key = 'pingcodePairing';

function validPairing(value) {
  return value && /^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) && /^[A-Za-z0-9_-]{43}$/.test(value.token)
    && Number(new URL(value.origin).port) >= 1024 && Number(new URL(value.origin).port) <= 65535;
}

async function connect() {
  if (connecting || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) { return; }
  const turn = generation;
  connecting = (async () => {
    pairing = (await chrome.storage.local.get(key))[key];
    if (turn !== generation || !validPairing(pairing)) { return; }
    const client = new WebSocket(pairing.origin.replace('http:', 'ws:') + '/bridge', ['pingcode-v1', pairing.token]);
    socket = client;
    client.onopen = () => {
      client.send(JSON.stringify({ action: 'hello', protocol: 2 }));
      chrome.action.setBadgeText({ text: 'ON' });
    };
    client.onmessage = async event => {
      if (socket !== client) { return; }
      let command;
      try { command = JSON.parse(event.data); } catch { client.close(); return; }
      if (command.action === 'ping') { client.send(JSON.stringify({ action: 'pong' })); return; }
      if (command.action === 'unpair') { await disconnect(); return; }
      if (command.action === 'cancel') { await commands.cancel(command.id); return; }
      let response;
      try { response = { id: command.id, result: await commands.execute(command) }; }
      catch (error) { response = { id: command.id, error: { code: error.code || 'WEB_REQUEST_FAILED' } }; }
      if (socket === client && client.readyState === WebSocket.OPEN) { client.send(JSON.stringify(response)); }
    };
    client.onclose = () => {
      if (socket !== client) { return; }
      socket = null;
      commands.cancelAll();
      chrome.action.setBadgeText({ text: '' });
      clearTimeout(timer);
      timer = setTimeout(connect, 3000);
    };
    client.onerror = () => client.close();
  })().finally(() => { connecting = null; });
  await connecting;
}

async function disconnect() {
  generation++;
  clearTimeout(timer);
  const previous = socket;
  socket = null;
  await commands.cancelAll();
  previous?.close();
  await connecting?.catch(() => {});
  pairing = null;
  await chrome.storage.local.remove(key);
  await chrome.action.setBadgeText({ text: '' });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'request-pair') {
    const value = message.pairing;
    if (!validPairing(value) || !sender.tab || sender.frameId !== 0
      || !sender.url?.startsWith(value.origin + '/pair#')) {
      respond({ ok: false });
      return;
    }
    (async () => {
      const id = crypto.randomUUID();
      await chrome.storage.session.set({ pendingPairing: { id, value } });
      respond({ ok: true });
      await chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL('pair.html#' + id) });
    })().catch(() => respond({ ok: false }));
    return true;
  }
  // Popup commands are accepted only from this extension's own page.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) { return; }
  if (message.type === 'pair-info' || message.type === 'confirm-pair') {
    (async () => {
      const pending = (await chrome.storage.session.get('pendingPairing')).pendingPairing;
      if (!pending || pending.id !== message.id) { respond({ ok: false }); return; }
      if (message.type === 'pair-info') { respond({ ok: true, origin: pending.value.origin }); return; }
      await chrome.storage.session.remove('pendingPairing');
      await disconnect();
      await chrome.storage.local.set({ [key]: pending.value });
      await connect();
      respond({ ok: true });
    })().catch(() => respond({ ok: false }));
    return true;
  }
  if (message.type === 'status') { respond({ connected: socket?.readyState === WebSocket.OPEN, paired: Boolean(pairing) }); }
  if (message.type === 'disconnect') { disconnect().then(() => respond({ ok: true })); return true; }
  if (message.type === 'retry') { connect().then(() => respond({ ok: true })); return true; }
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'pingcode-reconnect') { connect(); } });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('pingcode-reconnect', { periodInMinutes: 1 });
  connect();
});
chrome.alarms.create('pingcode-reconnect', { periodInMinutes: 1 });
connect();

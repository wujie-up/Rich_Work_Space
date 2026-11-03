import { validWorkItemQuery } from '../shared/query-policy.js';

const failure = code => Object.assign(Error(code), { code });

function validSite(site) {
  try {
    const url = new URL(site);
    return url.protocol === 'https:' && url.origin === site && url.hostname.endsWith('.pingcode.com');
  } catch {
    return false;
  }
}

// This function is serialized by Chrome and runs in the extension's isolated world in the target tab.
export async function readInPage({ site, path, params, id, action }) {
  const query = action === 'query';
  if (location.origin !== site || (query && path !== '/api/agile/work-items')) {
    return { failure: 'site' };
  }
  const controller = new AbortController();
  globalThis.__pingcodeExtensionReads ||= new Map();
  globalThis.__pingcodeExtensionReads.set(id, controller);
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const url = new URL(path, site);
    for (const [key, value] of Object.entries(query ? {} : params || {})) {
      if (value !== undefined && value !== '') { url.searchParams.set(key, String(value)); }
    }
    const response = await fetch(url, { credentials: 'same-origin', method: query ? 'POST' : 'GET', redirect: 'error',
      headers: { Accept: 'application/json', ...(query ? { 'Content-Type': 'application/json' } : {}) }, signal: controller.signal,
      ...(query ? { body: JSON.stringify(params) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { failure: controller.signal.aborted ? 'aborted' : 'network' };
  } finally {
    clearTimeout(timer);
    globalThis.__pingcodeExtensionReads.delete(id);
  }
}

export function createCommands(api) {
  const active = new Map();
  const opening = new Map();
  async function tabFor(site, focus, request) {
    const tabs = await api.tabs.query({ url: `${site}/*` });
    const checkCancelled = () => { if (request.cancelled) { throw failure('CANCELLED'); } };
    checkCancelled();
    let tab = tabs.find(tab => tab.active) || tabs[0];
    if (!tab) {
      if (!opening.has(site)) {
        opening.set(site, api.tabs.create({ url: `${site}/pjm/projects`, active: true }).finally(() => opening.delete(site)));
      }
      tab = await opening.get(site);
    } else if (focus) {
      checkCancelled();
      await api.tabs.update(tab.id, { active: true });
      checkCancelled();
      await api.windows.update(tab.windowId, { focused: true });
    }
    const deadline = Date.now() + 7000;
    while (tab.status !== 'complete' && Date.now() < deadline) {
      checkCancelled();
      await new Promise(resolve => setTimeout(resolve, 150));
      tab = await api.tabs.get(tab.id);
    }
    if (tab.status !== 'complete') { throw failure('TAB_UNAVAILABLE'); }
    return tab;
  }

  async function cancel(id) {
    const request = active.get(id);
    if (!request) { return; }
    request.cancelled = true;
    if (request.tabId !== undefined) {
      await api.scripting.executeScript({ target: { tabId: request.tabId }, world: 'ISOLATED',
        func: id => globalThis.__pingcodeExtensionReads?.get(id)?.abort(), args: [id] }).catch(() => {});
    }
  }

  async function execute(command) {
    if (!validSite(command.site) || !['open', 'read', 'query'].includes(command.action)
      || typeof command.id !== 'string' || command.id.length > 100) {
      throw failure('WEB_REQUEST_FAILED');
    }
    if (command.action === 'read' && (!/^\/api\/[a-zA-Z0-9/_-]+$/.test(command.path)
      || !(command.path.startsWith('/api/agile/') || command.path === '/api/typhon/account/me'))) {
      throw failure('WEB_REQUEST_FAILED');
    }
    if (command.action === 'query' && (command.path !== '/api/agile/work-items' || !validWorkItemQuery(command.params))) {
      throw failure('WEB_REQUEST_FAILED');
    }
    const request = { cancelled: false };
    active.set(command.id, request);
    try {
      const tab = await tabFor(command.site, command.action === 'open', request);
      request.tabId = tab.id;
      if (request.cancelled) { throw failure('CANCELLED'); }
      if (command.action === 'open') { return { opened: true }; }
      const results = await api.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED',
        func: readInPage, args: [command] });
      if (request.cancelled) { throw failure('CANCELLED'); }
      if (!results[0]?.result) { throw failure('TAB_UNAVAILABLE'); }
      return results[0].result;
    } catch (error) {
      throw failure(error.code === 'CANCELLED' ? 'CANCELLED' : error.code === 'TAB_UNAVAILABLE' ? 'TAB_UNAVAILABLE' : 'WEB_REQUEST_FAILED');
    } finally {
      active.delete(command.id);
    }
  }

  return { execute, cancel, cancelAll: () => Promise.all([...active.keys()].map(cancel)) };
}

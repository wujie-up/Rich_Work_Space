import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

// Exercise the real shared entry and bridge while holding slow host replies in flight.
const cases = Object.entries({ chromium, webkit }).flatMap(([name, engine]) => [
  { name: `${name} mobile dark`, engine, width: 393, theme: 'dark' },
  { name: `${name} desktop light`, engine, width: 1280, theme: 'light' }
]);
for (const { name, engine, width, theme } of cases) {
  test(`workspace loading: ${name} restores serially without selecting a group`, { timeout: 30000 }, async t => {
    const bundle = await build({ entryPoints: [new URL('../src/renderer/app.js', import.meta.url).pathname],
      bundle: true, write: false, outfile: 'app.js', format: 'esm', loader: { '.html': 'text' } });
    const browser = await engine.launch();
    const page = await browser.newPage({ viewport: { width, height: 852 } });
    page.setDefaultTimeout(5000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const preferences = Promise.withResolvers();
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    t.after(async () => {
      preferences.resolve({ theme });
      first.resolve();
      second.resolve();
      await browser.close();
    });
    let windowId;
    let failRecovery = false;
    const sessions = [];
    const restores = [];
    await page.exposeFunction('invoke', async (method, ...args) => {
      if (method === 'storage.getPreferences') { return preferences.promise; }
      if (method === 'host.getWindowContext') { return { id: 'fixture' }; }
      if (method === 'host.listWindows') { return [windowId]; }
      const [action, params] = args;
      if (action === 'adapters.list') { return [{ id: 'custom', capabilities: {} }]; }
      if (action === 'storage.getLayout') { return { activeGroup: 'team', collapsed: ['b'] }; }
      if (action === 'storage.getAdapterConfig') { return {}; }
      if (action === 'sessions.list') { return { groups: [{ id: 'team', name: '团队' }], sessions }; }
      if (action === 'sessions.attach') { return { data: 'READY', cursor: 0 }; }
      if (action === 'sessions.recover') {
        if (failRecovery) { throw Error('fixture recovery unavailable'); }
        [windowId] = params;
        return { windowId, sessions: [], archives: [{ id: 'a', name: 'first' }, { id: 'b', name: 'second' }] };
      }
      if (action === 'sessions.restore') {
        restores.push(params[0]);
        await (params[0] === 'a' ? first.promise : second.promise);
        const session = { id: params[0], pluginId: 'ai-agent-sessions', windowId, name: `restored ${params[0]}`,
          groupId: 'team', adapterId: 'custom', cwd: '/tmp', activity: 'idle', exited: false };
        sessions.push(session);
        return session;
      }
      return null;
    });
    await page.route('https://workspace.test/**', route => route.fulfill({ contentType: 'text/html', body: `<iframe src="https://workspace.test:444/index.html?deskPlugin=ai-agent-sessions&fresh=1" style="border:0;width:100%;height:100vh"></iframe><script>
      addEventListener('message', async event => {
        if (event.origin !== 'https://workspace.test:444' || event.data.type !== 'desk:invoke') return;
        try { const value = await invoke(event.data.method, ...event.data.args);
          event.source.postMessage({type:'desk:result',id:event.data.id,value}, event.origin);
        } catch (error) { event.source.postMessage({type:'desk:result',id:event.data.id,error:{message:error.message}}, event.origin); }
      });</script>` }));
    await page.route('https://workspace.test:444/**', route => {
      const path = new URL(route.request().url()).pathname;
      const output = bundle.outputFiles.find(file => file.path.endsWith(path));
      return route.fulfill(output ? { body: Buffer.from(output.contents), contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' }
        : { contentType: 'text/html', body: '<link rel="stylesheet" href="/app.css"><div id="workspace"></div><div id="toast" hidden></div><script type="module" src="/app.js"></script>' });
    });
    await page.goto('https://workspace.test/', { waitUntil: 'commit' });
    const frame = page.frameLocator('iframe');
    await frame.getByRole('status').filter({ hasText: '正在载入工作区' }).waitFor({ timeout: 3000 });
    preferences.resolve({ theme });
    await frame.locator('.workspace-tools').waitFor({ timeout: 3000 });
    await frame.getByRole('progressbar', { name: '会话恢复进度' }).filter({ has: frame.locator('.restore-count', { hasText: '0 / 2' }) }).waitFor();
    assert.deepEqual(restores, ['a']);
    assert.equal(await frame.locator('.group-workspace').evaluate(node => node.inert), true);
    first.resolve();
    await frame.locator('[data-session="a"]').waitFor({ state: 'attached' });
    assert.equal(await frame.locator('.group-choice[aria-current=page]').count(), 0);
    assert.equal(await frame.locator('.session:visible').count(), 0);
    await frame.getByRole('progressbar', { name: '会话恢复进度' }).filter({ has: frame.locator('.restore-count', { hasText: '1 / 2' }) }).waitFor();
    assert.deepEqual(restores, ['a', 'b']);
    assert.equal(await frame.locator('[data-session="b"]').count(), 0);
    await page.screenshot({ path: `/tmp/deskpg-agent-loading-${name.replaceAll(' ', '-')}.png` });
    second.resolve();
    await frame.locator('[data-session="b"]').waitFor({ state: 'attached' });
    await frame.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(await frame.locator('.group-workspace').evaluate(node => node.inert), false);
    assert.equal(await frame.locator('.workspace-loading:visible').count(), 0);
    assert.equal(await frame.locator('.group-choice[aria-current=page]').count(), 0);
    assert.equal(await frame.locator('.session:visible').count(), 0);
    await frame.locator('.group-choice').filter({ hasText: '团队' }).click();
    await frame.locator('[data-session="a"]').waitFor();
    assert.equal(await frame.locator('[data-session="b"]').evaluate(node => node.classList.contains('collapsed')), true);
    await frame.locator('.workspace-tools button').first().click();
    await frame.getByRole('button', { name: '新建会话', exact: true }).first().click();
    await frame.getByRole('dialog').waitFor();
    failRecovery = true;
    await page.evaluate(() => { document.querySelector('iframe').src += '&retry=1'; });
    await frame.getByRole('alert').filter({ hasText: 'fixture recovery unavailable' }).waitFor();
    assert.equal(await frame.locator('#workspace').getAttribute('aria-busy'), 'false');
    assert.equal(await frame.locator('.session').count(), 0);
    assert.deepEqual(pageErrors, []);
  });
}

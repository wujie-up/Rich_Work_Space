import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const evidence = process.env.ELICITATION_EVIDENCE;

test('structured conversation MCP forms and URLs work across themes, streaming and request resolution', { timeout: 30000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'agent-elicitation-ui-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await build({ stdin: { contents: `
    import { api, conversationApi } from './plugin-dev/ai-agent/src/renderer/api.js';
    window.postMessage = () => {};
    api.host.getWindowContext = async () => ({ id: 'fixture' });
    window.opens = []; window.replies = []; window.records = [1,2].map(id => ({ id: 'chat-'+id, name: 'Chat '+id,
      windowId: '', cwd: '/fixture', engineId: 'codex', state: 'running', events: [] }));
    let listener; let sequence = 0;
    window.push = (event, index = 0) => {
      event = { ...event, sequence: ++sequence };
      window.records[index].events.push(event);
      listener({ conversationId: window.records[index].id, event, state: 'running' });
    };
    api.host.openExternal = async url => { window.opens.push(url); if (window.openError) { throw Error('打开失败'); } };
    conversationApi.onAccount = () => {};
    conversationApi.onEvent = callback => { listener = callback; };
    conversationApi.call = async (method, ...args) => {
      if (method === 'conversation.listWindows') { return []; }
      if (method === 'conversation.list') { return structuredClone(window.records); }
      if (method === 'conversation.read' || method === 'conversation.attachWindow') {
        return structuredClone(window.records.find(record => record.id === args[0]));
      }
      if (method === 'engines.list') { return [{ id:'codex', name:'Codex', state:'ready', pin:{version:'test'} }]; }
      if (method === 'engines.config') { return { defaultEngine:'codex' }; }
      if (method === 'conversation.elicit') {
        window.replies.push(args);
        if (window.hold) { await new Promise(resolve => { window.release = resolve; }); }
        const index = window.records.findIndex(record => record.id === args[0]);
        window.push({ method:'approval/answered', params:{requestId:args[1]} }, index);
      }
    };
    await import('./plugin-dev/ai-agent/src/renderer/conversation.js');
    window.ready = true;
  `, resolveDir: repository, sourcefile: 'elicitation-fixture.js' }, bundle: true, format: 'esm', loader: { '.html': 'text' }, outfile: join(fixture, 'app.js') });
  const html = await readFile(join(repository, 'plugin-dev/ai-agent/src/resource/conversation.html'), 'utf8');
  await writeFile(join(fixture, 'index.html'), html.replace('href="conversation.css"', 'href="app.css"').replace('src="conversation.js"', 'src="app.js"'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(new URL('../fixtures/git-branches.cjs', import.meta.url)), `--fixture=${fixture}`], env });
  t.after(() => app.close());
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.ready);
  await page.selectOption('#history', 'chat-1');
  const push = event => page.evaluate(event => window.push(event), event);
  const params = { mode: 'form', serverName: 'Local MCP', message: '<script>普通表单</script>', requestedSchema: {
    type: 'object', properties: {
      name: { type: 'string', title: '名称', minLength: 2, default: '草稿' },
      count: { type: 'integer', title: '次数', minimum: 0, maximum: 3, default: 0 },
      enabled: { type: 'boolean', title: '启用', default: false },
      choice: { type: 'string', title: '选项', oneOf: [{ const: 'a', title: '甲' }, { const: 'b', title: '乙' }], default: 'b' },
      tags: { type: 'array', title: '标签', items: { anyOf: [{ const: 'x', title: '一' }, { const: 'y', title: '二' }] }, default: ['x'] },
      optional: { type: 'string', title: '可选' }
    }, required: ['name', 'count', 'enabled']
  } };
  await push({ id: 0, method: 'mcpServer/elicitation/request', params });
  const card = page.locator('[data-request-id="0"]');
  await card.waitFor();
  await card.getByLabel('名称').fill('短');
  await card.getByRole('button', { name: '提交回答', exact: true }).click();
  assert.equal(await card.getByRole('alert').textContent().then(text => text.includes('格式')), true);
  assert.deepEqual(await page.evaluate(() => window.replies), []);
  await card.getByLabel('名称').fill('保留输入');
  await push({ method: 'item/agentMessage/delta', params: { itemId: 'stream', delta: '继续输出' } });
  assert.equal(await card.getByLabel('名称').inputValue(), '保留输入');
  assert.equal(await card.getByLabel('启用').inputValue(), 'false');
  assert.equal(await card.locator('script').count(), 0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(380, 720));
    await card.getByLabel('名称').focus();
    assert.equal(await card.getByLabel('名称').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `mcp-form-${theme}-narrow.png`) });
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 900));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (evidence) { await page.screenshot({ path: join(evidence, 'mcp-form-dark-normal.png') }); }
  await page.evaluate(() => { window.hold = true; });
  await card.getByRole('button', { name: '提交回答', exact: true }).click();
  assert.equal(await card.getByLabel('名称').isDisabled(), true);
  await page.selectOption('#history', 'chat-2');
  await page.evaluate(() => { window.release(); window.hold = false; });
  await page.waitForTimeout(80);
  assert.equal(await page.inputValue('#history'), 'chat-2');
  assert.deepEqual(await page.evaluate(() => window.replies[0]), ['chat-1', 0, 'accept', {
    name: '保留输入', count: 0, enabled: false, choice: 'b', tags: ['x']
  }]);
  await page.selectOption('#history', 'chat-1');
  assert.equal(await page.locator('[data-request-id="0"]').count(), 0);
  for (const [id, decision, label] of [[1, 'decline', '拒绝'], [2, 'cancel', '取消本次请求']]) {
    await push({ id, method: 'mcpServer/elicitation/request', params });
    await page.locator(`[data-request-id="${id}"]`).getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction(id => window.replies.some(reply => reply[1] === id), id);
    assert.equal((await page.evaluate(() => window.replies.at(-1)))[2], decision);
  }
  await push({ id: 3, method: 'mcpServer/elicitation/request', params });
  await page.locator('[data-request-id="3"]').waitFor();
  await push({ method: 'serverRequest/resolved', params: { requestId: 3 } });
  await page.waitForFunction(() => !document.querySelector('[data-request-id="3"]'));
  await push({ id: 3, method: 'mcpServer/elicitation/request', params: { ...params, message: '新的请求' } });
  await page.selectOption('#history', 'chat-2');
  await page.selectOption('#history', 'chat-1');
  assert.equal(await page.locator('[data-request-id="3"]').count(), 1, 'reused IDs must not revive historical forms');
  assert.equal(await page.locator('[data-request-id="3"]').textContent().then(text => text.includes('新的请求')), true);
  await push({ method: 'serverRequest/resolved', params: { requestId: 3 } });
  const url = 'https://example.com/auth?fixture=1';
  await push({ id: 4, method: 'mcpServer/elicitation/request', params: { mode: 'url', serverName: 'Local MCP', url, message: '授权', elicitationId: 'local' } });
  assert.deepEqual(await page.evaluate(() => window.opens), []);
  await page.evaluate(() => { window.openError = true; });
  await page.locator('[data-request-id="4"]').getByRole('button', { name: '打开授权页面并继续' }).click();
  assert.equal(await page.locator('[data-request-id="4"]').getByRole('alert').textContent(), '打开失败');
  assert.equal(await page.evaluate(() => window.replies.some(reply => reply[1] === 4)), false);
  await page.evaluate(() => { window.openError = false; });
  await page.locator('[data-request-id="4"]').getByRole('button', { name: '打开授权页面并继续' }).click();
  await page.waitForFunction(() => window.replies.some(reply => reply[1] === 4));
  assert.deepEqual(await page.evaluate(() => window.opens), [url, url]);
  await push({ id: 5, method: 'mcpServer/elicitation/request', params: { mode: 'url', url: 'javascript:alert(1)', message: '无效链接' } });
  assert.equal(await page.locator('[data-request-id="5"]').getByRole('button', { name: '打开授权页面并继续' }).isDisabled(), true);
  await page.locator('[data-request-id="5"]').getByRole('button', { name: '拒绝', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.opens), [url, url]);
});

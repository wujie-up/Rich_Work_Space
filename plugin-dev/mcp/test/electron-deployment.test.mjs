// Run explicitly with the latest packaged DeckPg and isolated test data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { remoteFixture } from './remote-fixture.mjs';
import { launch, openWorkspace, toggleTheme } from '../../../desk/test/electron/helpers.js';

const archive = resolve('plugin-dev/dist/mcp-services-0.4.4.plg');
async function install(app, page, id = 'mcp-services', source = archive) {
  await page.evaluate(async id => {
    const existing = (await workDesk.plugins.list()).find(plugin => plugin.id === id);
    if (existing) {
      const preview = await workDesk.plugins.preview(id, 'remove');
      await workDesk.plugins.remove(id, 'keep', preview.confirmationToken);
    }
  }, id);
  await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
  await page.evaluate(() => workDesk.plugins.install());
}
const invoke = (page, method, ...args) => page.evaluate(({ method, args }) => workDesk.plugins.invoke('mcp-services', method, args), { method, args });
async function until(predicate) {
  for (let n = 0; n < 150; n++) {
    const result = await predicate();
    if (result) { return result; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Expected MCP state was not observed');
}

test('latest DeckPg: editable code/config, lazy tools, AI failure cleanup, themes and upgrade', { timeout: 120000 }, async t => {
  const { app, page, data } = await launch(t, { openPlugin: false });
  await install(app, page);
  await install(app, page, 'ai-agent-sessions', resolve('plugin-dev/dist/ai-agent-sessions-0.5.5.plg'));
  await openWorkspace(page, 'mcp-services');
  const frame = page.frameLocator('iframe[title="MCP 服务"]');
  const source = (await readFile(new URL('./script-fixture.mjs', import.meta.url), 'utf8'))
    .replace("} else if (request.method === 'tools/list') {", "} else if (request.method === 'tools/list') { console.error('TOOLS_LIST');");
  const schema = [{ name: 'ENDPOINT', label: '日志地址', required: true }, { name: 'API_KEY', label: '访问密钥', secret: true, required: true }];
  await invoke(page, 'mcp.save', { id: 'logs-service', name: '日志查询', transport: 'script', language: 'javascript',
    entry: 'server.mjs', interpreter: process.execPath, source, fields: schema,
    env: { ENDPOINT: 'https://logs.example.test', API_KEY: 'private-ui-key' } });
  await frame.locator('#refresh').click();
  await frame.locator('#services').getByRole('button', { name: /日志查询/ }).click();
  await frame.locator('[name="source"]').fill(source);
  await frame.getByText('运行与导入设置', { exact: true }).click();
  await frame.locator('[name="interpreter"]').fill(process.execPath);
  await frame.getByText('配置字段声明', { exact: true }).click();
  await frame.locator('[name="fields"]').fill(JSON.stringify(schema));
  assert.equal(await frame.locator('[data-env]').count(), 0);
  await frame.locator('#save').click();
  await frame.locator('#status').getByText('已完成', { exact: true }).waitFor();
  assert.equal(await frame.locator('#start').isEnabled(), true);
  assert.equal(await frame.locator('#stop').isDisabled(), true);
  assert.equal(await frame.locator('#tools, #tool, #arguments, #call').count(), 0);
  assert.equal(await frame.locator('[name="source"]').inputValue(), source);
  await frame.locator('#start').click();
  await frame.locator('#services').getByText(/running/).waitFor();
  let records = await invoke(page, 'mcp.list');
  const id = records[0].id;
  assert.ok(!(await invoke(page, 'mcp.logs', id)).includes('TOOLS_LIST'));
  assert.equal(await frame.locator('#start').isDisabled(), true);
  assert.equal(await frame.locator('#stop').isEnabled(), true);

  // A running service can be edited; validation happens before its runtime is stopped.
  await frame.getByText('配置字段声明', { exact: true }).click();
  await frame.locator('[name="fields"]').fill(JSON.stringify([...schema, { name: 'MISSING', label: '缺失配置', required: true }]));
  await frame.locator('#save').click();
  await frame.locator('#status').getByText(/必填/).waitFor();
  assert.equal((await invoke(page, 'mcp.list'))[0].state, 'running');
  await frame.locator('[name="fields"]').fill(JSON.stringify(schema));
  await frame.locator('[name="source"]').fill(source.replace('JS:', 'EDITED:'));
  await frame.locator('#save').click();
  await frame.locator('#status').getByText('已完成', { exact: true }).waitFor();
  assert.equal((await invoke(page, 'mcp.list'))[0].state, 'stopped');
  await frame.locator('#start').click();
  await frame.locator('#services').getByText(/running/).waitFor();
  assert.match((await invoke(page, 'mcp.call', id, 'javascript_query', { text: 'SAVED' })).content[0].text,
    /EDITED:SAVED:https:\/\/logs.example.test/);

  // Isolated data has no managed engine or copied system authentication. Failure must clean only the preview.
  await frame.locator('[name="source"]').fill(source.replace('JS:', 'UNSAVED:'));
  await frame.locator('#debug').click();
  await frame.locator('#debug-panel').waitFor();
  try {
    await frame.locator('#debug-state').getByText(/调试失败，临时资源已清理/).waitFor({ timeout: 35000 });
  } catch (error) {
    console.error('Debug UI state:', await frame.locator('#debug-state').textContent());
    console.error('MCP UI status:', await frame.locator('#status').textContent());
    throw error;
  }
  assert.equal((await invoke(page, 'mcp.list'))[0].state, 'running');
  assert.equal((await invoke(page, 'mcp.connections')).services.length, 1);
  assert.match(await invoke(page, 'mcp.source', id), /EDITED:/);
  assert.equal(await frame.locator('[name="source"]').inputValue(), source.replace('JS:', 'UNSAVED:'));

  await mkdir('.test-results/mcp-deployment', { recursive: true });
  for (const theme of ['light', 'dark']) {
    const current = await page.locator('html').getAttribute('data-theme');
    if (current !== theme) { await toggleTheme(page); }
    await page.screenshot({ path: `.test-results/mcp-deployment/${theme}.png` });
  }
  await page.getByRole('button', { name: '平铺到桌面', exact: true }).click();
  await page.screenshot({ path: '.test-results/mcp-deployment/tiled.png' });
  await page.setViewportSize({ width: 700, height: 800 });
  assert.equal(await frame.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: '.test-results/mcp-deployment/narrow.png' });
  await frame.locator('#stop').click();
  await frame.locator('#status').getByText('已完成', { exact: true }).waitFor();

  // Python imports retain helper files when the entry is edited.
  const folder = join(data, 'service-source');
  await mkdir(folder);
  await writeFile(join(folder, 'main.py'), await readFile(new URL('./script-fixture.py', import.meta.url)));
  await writeFile(join(folder, 'helper.py'), 'VALUE = 42\n');
  await writeFile(join(folder, 'mcp-service.json'), JSON.stringify({ name: 'Python 目录部署', language: 'python', entry: 'main.py', fields: schema }));
  await invoke(page, 'mcp.save', { id: 'python-service', name: 'Python 目录部署', transport: 'script', language: 'python',
    entry: 'main.py', source: await readFile(join(folder, 'main.py'), 'utf8'), fields: schema,
    env: { ENDPOINT: 'https://python.example.test', API_KEY: 'python-ui-key' } });
  await frame.locator('#refresh').click();
  await frame.locator('#services').getByRole('button', { name: /Python 目录部署/ }).click();
  await frame.getByText('运行与导入设置', { exact: true }).click();
  await frame.locator('#script-directory').setInputFiles(folder);
  await frame.locator('#import-summary').getByText(/已选择 3 个文件/).waitFor();
  await frame.locator('[name="interpreter"]').fill(execFileSync('which', ['python3'], { encoding: 'utf8' }).trim());
  assert.equal(await frame.locator('[data-env]').count(), 0);
  await frame.locator('#save').click();
  await frame.locator('#status').getByText('已完成', { exact: true }).waitFor();
  await frame.locator('[name="source"]').fill((await frame.locator('[name="source"]').inputValue()).replace('PYTHON:', 'PY-EDIT:'));
  await frame.locator('#save').click();
  await frame.locator('#status').getByText('已完成', { exact: true }).waitFor();
  await frame.locator('#start').click();
  await frame.locator('#services').getByText(/running/).waitFor();
  records = await invoke(page, 'mcp.list');
  assert.match((await invoke(page, 'mcp.call', records[1].id, 'python_query', { text: 'PYTHON' })).content[0].text,
    /PY-EDIT:PYTHON:https:\/\/python.example.test/);
  const revision = join(data, 'plugin-data/mcp-services/deployments', records[1].id, records[1].deployment);
  assert.equal(await readFile(join(revision, 'helper.py'), 'utf8'), 'VALUE = 42\n');
  await frame.locator('#stop').click();
  await frame.locator('#status').getByText('已完成', { exact: true }).waitFor();
  const definitions = join(data, 'plugin-data/mcp-services/services.json');
  const saved = await readFile(definitions, 'utf8');
  const marker = join(data, 'plugin-data/mcp-services/history-marker.json');
  await writeFile(marker, '{"retained":true}');
  await install(app, page);
  assert.equal(await readFile(definitions, 'utf8'), saved);
  assert.equal(await readFile(marker, 'utf8'), '{"retained":true}');
});

test('0.4.1 to 0.4.2 preserves existing stdio/HTTP definitions, credentials and history', { timeout: 90000 }, async t => {
  const remote = await remoteFixture();
  t.after(() => remote.close());
  const { app, page, data } = await launch(t, { openPlugin: false });
  await install(app, page, 'mcp-services', resolve('plugin-dev/dist/mcp-services-0.4.1.plg'));
  await invoke(page, 'mcp.save', { id: 'legacy-local', name: 'Existing stdio', transport: 'stdio', command: process.execPath,
    args: [resolve('plugin-dev/mcp/test/script-fixture.mjs')], cwd: resolve('.'), env: { ENDPOINT: 'https://legacy.example.test', API_KEY: 'legacy-secret' } });
  await invoke(page, 'mcp.save', { id: 'legacy-remote', name: 'Existing remote', transport: 'http', url: remote.url, apiKey: remote.secret });
  for (const id of ['legacy-local', 'legacy-remote']) { await invoke(page, 'mcp.start', id); await invoke(page, 'mcp.stop', id); }
  const definitions = join(data, 'plugin-data/mcp-services/services.json');
  const marker = join(data, 'plugin-data/mcp-services/history-marker.json');
  await writeFile(marker, '{"oldHistory":true}');
  const saved = await readFile(definitions, 'utf8');
  await install(app, page);
  assert.equal(await readFile(definitions, 'utf8'), saved);
  assert.equal(await readFile(marker, 'utf8'), '{"oldHistory":true}');
  await invoke(page, 'mcp.start', 'legacy-local');
  assert.match((await invoke(page, 'mcp.call', 'legacy-local', 'javascript_query', { text: 'UPGRADED' })).content[0].text,
    /JS:UPGRADED:https:\/\/legacy.example.test/);
  await invoke(page, 'mcp.start', 'legacy-remote');
  assert.equal((await invoke(page, 'mcp.call', 'legacy-remote', 'verification_echo', { text: 'UPGRADED' })).content[0].text, 'REMOTE:UPGRADED');
  assert.ok((await invoke(page, 'mcp.logs', 'legacy-local')).includes('配置已保存'));
});


test('MCP settings hide internal IDs and retain service identity after editing', { timeout: 60000 }, async t => {
  const { app, page } = await launch(t, { openPlugin: false });
  await install(app, page);
  const definition = { id: 'retained-service', name: '原服务', transport: 'stdio', command: process.execPath,
    args: ['server.mjs'], cwd: resolve('.'), env: { API_KEY: 'isolated-test-value' } };
  await invoke(page, 'mcp.save', definition);
  await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  const frame = page.frameLocator('iframe[title="MCP 服务"]');
  await frame.locator('[name="name"]').waitFor();
  assert.equal(await frame.getByText('服务 ID', { exact: true }).count(), 0);
  assert.equal(await frame.locator('[name="id"]').isVisible(), false);
  await frame.locator('[name="name"]').fill('改名后的服务');
  await frame.locator('#save').click();
  await frame.locator('#status').getByText('已完成', { exact: true }).waitFor();
  const records = await invoke(page, 'mcp.list');
  assert.equal(records.length, 1);
  assert.equal(records[0].id, definition.id);
  assert.equal(records[0].name, '改名后的服务');
  assert.deepEqual(records[0].env, definition.env);
  await frame.locator('#new').click();
  assert.equal(await frame.locator('[name="id"]').isVisible(), false);
  await frame.locator('[name="name"]').fill('新服务');
  await frame.locator('[name="transport"]').selectOption('stdio');
  await frame.locator('[name="command"]').fill(process.execPath);
  await frame.locator('#save').click();
  await frame.locator('#status').getByText('已完成', { exact: true }).waitFor();
  const added = (await invoke(page, 'mcp.list')).find(service => service.id !== definition.id);
  assert.match(added.id, /^[a-z0-9-]+$/);
  assert.equal(added.name, '新服务');
  await mkdir('.test-results/mcp-settings', { recursive: true });
  await page.screenshot({ path: '.test-results/mcp-settings/service.png' });
});


test('MCP declared configuration has no parameter inputs and preserves saved values', { timeout: 60000 }, async t => {
  const { app, page } = await launch(t, { openPlugin: false });
  await install(app, page);
  const source = await readFile(new URL('./script-fixture.mjs', import.meta.url), 'utf8');
  await invoke(page, 'mcp.save', { id: 'configured-script', name: '配置折叠验证', transport: 'script', language: 'javascript',
    entry: 'server.mjs', interpreter: process.execPath, source,
    fields: [{ name: 'ENDPOINT', label: '服务地址', required: true }, { name: 'API_KEY', label: '密钥', secret: true }],
    env: { ENDPOINT: 'https://original.example.test', API_KEY: 'retained-secret' } });
  await page.locator('.shelf-app[data-plugin="mcp-services"]').click();
  const frame = page.frameLocator('iframe[title="MCP 服务"]');
  await frame.locator('[name="source"]').waitFor();
  assert.equal(await frame.locator('#script-fields, [data-env]').count(), 0);
  await frame.getByText('配置字段声明', { exact: true }).click();
  assert.equal(await frame.locator('#script-fields, [data-env]').count(), 0);
  await frame.locator('[name="fields"]').fill(JSON.stringify([
    { name: 'ENDPOINT', label: '更新后的服务地址', required: true }, { name: 'API_KEY', label: '密钥', secret: true }
  ]));
  await frame.locator('#save').click();
  await frame.locator('#status').getByText('已完成', { exact: true }).waitFor();
  assert.equal(await frame.locator('#script-fields, [data-env]').count(), 0);
  const [saved] = await invoke(page, 'mcp.list');
  assert.equal(saved.id, 'configured-script');
  assert.deepEqual(saved.env, { ENDPOINT: 'https://original.example.test', API_KEY: 'retained-secret' });
  assert.equal(saved.fields[0].label, '更新后的服务地址');
  await frame.locator('#save').click();
  await frame.locator('#status').getByText('已完成', { exact: true }).waitFor();
  assert.deepEqual((await invoke(page, 'mcp.list'))[0].env, saved.env);
  await mkdir('.test-results/mcp-settings', { recursive: true });
  await page.screenshot({ path: '.test-results/mcp-settings/folded.png' });
});

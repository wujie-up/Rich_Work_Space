import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch } from '../../../../desk/test/electron/helpers.js';

const { version } = JSON.parse(await readFile(resolve('plugin-dev/work-flow/plugin.json'), 'utf8'));
const archive = resolve(`plugin-dev/dist/work-flow-${version}.plg`);

// A local IMAP fixture keeps the whole run offline while still exercising the real protocol.
function imapFixture(messages, { delay = 0 } = {}) {
  const server = net.createServer(socket => {
    socket.write('* OK fixture ready\r\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\r\n');
        respond(socket, line, messages, delay);
      }
    });
    socket.on('error', () => {});
  });
  return server;
}

function respond(socket, line, messages, delay) {
  const [tag, name, ...rest] = line.split(' ');
  const command = (name || '').toUpperCase();
  if (command === 'LOGIN') {
    socket.write(`${tag} OK LOGIN completed\r\n`);
    return;
  }
  if (command === 'SELECT') {
    socket.write(`* ${messages.length} EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
    return;
  }
  if (command === 'SEARCH') {
    socket.write(`* SEARCH ${messages.map((entry, index) => index + 1).join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
    return;
  }
  if (command === 'FETCH') {
    const ids = rest[0].split(',').flatMap(part => {
      const [start, end] = part.split(':').map(Number);
      return Number.isInteger(start) && Number.isInteger(end)
        ? Array.from({ length: end - start + 1 }, (unused, index) => start + index) : [start];
    });
    // A slow mailbox keeps a run in flight while the desktop disables the plugin.
    setTimeout(() => {
      for (const id of ids) {
        const raw = messages[id - 1];
        if (raw) {
          socket.write(`* ${id} FETCH (BODY[] {${Buffer.byteLength(raw, 'utf8')}}\r\n${raw})\r\n`);
        }
      }
      socket.write(`${tag} OK FETCH completed\r\n`);
    }, delay);
    return;
  }
  if (command === 'LOGOUT') {
    socket.write(`${tag} OK LOGOUT completed\r\n`);
    socket.end();
    return;
  }
  socket.write(`${tag} BAD unsupported\r\n`);
}

const email = (subject, body) => `From: ops@example.com\r\nTo: dev@example.com\r\nDate: Sat, 24 Oct 2026 08:00:00 +0800\r\n`
  + `Subject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

async function install(app, page, { agent = false } = {}) {
  if (!agent) {
    await page.evaluate(async () => {
      const preview = await workDesk.plugins.preview('ai-agent-sessions', 'disable');
      await workDesk.plugins.disable('ai-agent-sessions', preview.confirmationToken);
    });
  }
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, archive);
  await page.evaluate(async () => {
    const installed = (await workDesk.plugins.list()).find(entry => entry.id === 'work-flow');
    if (installed && installed.state !== 'uninstalled') {
      const preview = await workDesk.plugins.preview('work-flow', 'remove');
      await workDesk.plugins.remove('work-flow', 'keep', preview.confirmationToken);
    }
    await workDesk.plugins.install();
  });
  const record = await page.evaluate(async () => (await workDesk.plugins.list()).find(entry => entry.id === 'work-flow'));
  assert.equal(record.version, version);
  if (record.state !== 'enabled') {
    await page.evaluate(() => workDesk.plugins.enable('work-flow'));
  }
  await page.locator('.shelf-app[data-plugin="work-flow"]').click();
  const frame = page.frameLocator('iframe.plugin-view:visible');
  await frame.locator('.node', { hasText: '报错邮件抓取' }).waitFor({ timeout: 60000 });
  return frame;
}

async function credential(frame, port) {
  await frame.locator('summary', { hasText: '邮件账号' }).click();
  await frame.locator('#credentials [data-credential="name"]').fill('本地测试邮箱');
  await frame.locator('#credentials [data-credential="host"]').fill('127.0.0.1');
  await frame.locator('#credentials [data-credential="port"]').fill(String(port));
  await frame.locator('#credentials [data-credential="security"]').selectOption('none');
  await frame.locator('#credentials [data-credential="username"]').fill('tester');
  await frame.locator('#credentials [data-credential="password"]').fill('secret-token');
  await frame.locator('#save-credential').click();
  await frame.locator('#credentials .result-item', { hasText: '本地测试邮箱' }).waitFor();
  await frame.locator('.node', { hasText: '报错邮件抓取' }).click();
  await frame.locator('#properties select[data-param="credentialId"]').selectOption({ index: 1 });
}

const runFile = async data => {
  const workflows = JSON.parse(await readFile(join(data, 'plugin-data/work-flow/workflows.json'), 'utf8'));
  const runs = JSON.parse(await readFile(join(data, 'plugin-data/work-flow/runs', `${workflows.items[0].id}.json`), 'utf8'));
  return { workflows, run: runs[runs.length - 1], runs };
};

test('真实宿主：安装插件包后在界面里跑通「邮件抓取 → 日志提取 → 条件继续 → 结果汇总」', { timeout: 180000 }, async t => {
  const server = imapFixture([email('每日日报', '版本发布完成，一切正常'),
    email('订单服务告警', 'INFO 心跳正常\nERROR 数据库连接池耗尽，等待 30s 后重试\nERROR 订单创建失败')]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { app, page, data, logs } = await launch(t, { openPlugin: false });
  t.after(() => writeLogs(logs.join('')));
  const errors = [];
  const network = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.context().route(/^https?:\/\//, route => { network.push(route.request().url()); return route.abort(); });

  const frame = await install(app, page);
  assert.equal(await frame.locator('.node').count(), 7);
  assert.match(await frame.locator('#notice').textContent(), /请在工作台启用或升级 AI Agent 插件/);

  await credential(frame, port);
  await frame.locator('.node', { hasText: 'Agent 排查' }).click();
  await frame.locator('#properties #delete-node').click();
  assert.equal(await frame.locator('.node').count(), 6);
  // Reconnect the gate to the summary node so the remaining four nodes still form one path.
  await frame.locator('.node', { hasText: '存在错误才继续' }).locator('.port.out').click();
  await frame.locator('.node', { hasText: '结果汇总' }).locator('.port.in').click();

  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  await frame.locator('#run').click();
  await frame.locator('#status').filter({ hasText: /运行完成|运行失败|运行已停止/ }).waitFor({ timeout: 120000 });
  const results = await frame.locator('#results').textContent();
  assert.match(await frame.locator('#status').textContent(), /运行完成/, `状态与结果面板：${results.slice(0, 3000)}`);
  assert.match(results, /已完成/);
  assert.match(results, /排查报告/);
  assert.match(results, /数据库连接池耗尽/);
  assert.match(results, /订单创建失败/);
  assert.doesNotMatch(results, /版本发布完成/);
  assert.equal(await frame.locator('#results .state-failed').count(), 0);

  const stored = await runFile(data);
  assert.equal(stored.workflows.items[0].nodes.length, 6);
  assert.equal(stored.run.status, 'succeeded');
  assert.ok(!JSON.stringify(stored.run).includes('secret-token'));
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
});

test('真实宿主：缺少 Agent 提供方时排查节点在界面上明确失败', { timeout: 180000 }, async t => {
  const server = imapFixture([email('订单服务告警', 'ERROR 数据库连接池耗尽')]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { app, page, data } = await launch(t, { openPlugin: false });
  const frame = await install(app, page);
  await credential(frame, port);
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  await frame.locator('#run').click();
  await frame.locator('#status').filter({ hasText: /运行完成|运行失败|运行已停止/ }).waitFor({ timeout: 120000 });
  const results = await frame.locator('#results').textContent();
  assert.match(await frame.locator('#status').textContent(), /运行失败/);
  assert.match(results, /AGENT_PROVIDER_MISSING|启用或升级/);
  const stored = await runFile(data);
  assert.equal(stored.run.status, 'failed');
  assert.equal(stored.run.error.code, 'AGENT_PROVIDER_MISSING');
  // The mail fetch, log extraction and gate before the agent call must still have succeeded.
  const succeeded = Object.values(stored.run.nodes).filter(node => node.status === 'succeeded').length;
  assert.ok(succeeded >= 3, `上游节点应已完成，实际完成 ${succeeded} 个`);
});

test('真实宿主：运行中停用插件会归档运行，宿主与其它插件仍可操作', { timeout: 180000 }, async t => {
  const server = imapFixture([email('订单服务告警', 'ERROR 数据库连接池耗尽')], { delay: 8000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { app, page, data } = await launch(t, { openPlugin: false });
  const frame = await install(app, page);
  await credential(frame, port);
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  await frame.locator('#run').click();
  await page.waitForTimeout(2000);

  const preview = await page.evaluate(() => workDesk.plugins.preview('work-flow', 'disable'));
  await page.evaluate(token => workDesk.plugins.disable('work-flow', token), preview.confirmationToken);
  const record = await page.evaluate(async () => (await workDesk.plugins.list()).find(entry => entry.id === 'work-flow'));
  assert.equal(record.state, 'disabled');
  assert.equal(await page.locator('.application-window').count(), 0);

  // The desktop stays usable and another plugin's window can still be opened.
  const others = await page.evaluate(async () => (await workDesk.plugins.list()).filter(entry => entry.state === 'enabled'));
  assert.ok(others.length > 0);
  await page.locator(`.shelf-app[data-plugin="${others[0].id}"]`).click();
  await page.locator('.application-window').first().waitFor();

  // Disabling tears down the mailbox socket, so the node may report the stop before the archive pass does.
  const stored = await runFile(data);
  assert.equal(stored.run.status, 'canceled');
  assert.ok(['RUN_CANCELED', 'PLUGIN_STOPPED'].includes(stored.run.error.code), stored.run.error.code);
});

test('真实宿主：设为固定周期后不点运行也会自动触发', { timeout: 180000 }, async t => {
  const server = imapFixture([email('订单服务告警', 'ERROR 数据库连接池耗尽')]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { app, page, data } = await launch(t, { openPlugin: false });
  const frame = await install(app, page);
  await credential(frame, port);
  await frame.locator('.node', { hasText: 'Agent 排查' }).click();
  await frame.locator('#properties #delete-node').click();
  await frame.locator('.node', { hasText: '存在错误才继续' }).locator('.port.out').click();
  await frame.locator('.node', { hasText: '结果汇总' }).locator('.port.in').click();

  await frame.locator('summary', { hasText: '运行方式' }).click();
  await frame.locator('#trigger-mode').selectOption('interval');
  await frame.locator('#trigger-every').fill('1');
  await frame.locator('#trigger-unit').selectOption('second');
  assert.equal(await frame.locator('#trigger-enabled').isChecked(), true);
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  assert.match(await frame.locator('#triggers').textContent(), /下次运行：\d/);

  await page.waitForTimeout(6000);
  const stored = await runFile(data);
  assert.ok(stored.runs.length >= 2, `周期触发应自动跑出多次，实际 ${stored.runs.length} 次`);
  assert.ok(stored.runs.some(run => run.status === 'succeeded'),
    `至少有一次自动运行成功：${stored.runs.map(run => run.status).join()}`);
  assert.ok(stored.runs.filter(run => run.status === 'running').length <= 1, '同一工作流不会出现并发运行');
  // Stop new ticks before observing the final result, so the next run cannot clear the output during the assertion.
  await frame.locator('#trigger-enabled').uncheck();
  await frame.locator('#save').click();
  await frame.locator('#results').filter({ hasText: '数据库连接池耗尽' }).waitFor();
});

test('真实宿主：节点按分类分组，输出节点落地，旧工作流可一键补齐起止节点', { timeout: 180000 }, async t => {
  const server = imapFixture([email('订单服务告警', 'ERROR 数据库连接池耗尽')]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { app, page, data, logs } = await launch(t, { openPlugin: false });
  t.after(() => writeLogs(logs.join('')));
  const frame = await install(app, page);
  // 场景工作流自带开始与终止节点，节点面板按功能分组。
  assert.deepEqual(await frame.locator('#node-category option').allTextContents(),
    ['数据输入', '数据处理', 'AI 能力', '结果输出', '流程控制']);
  assert.equal(await frame.locator('#palette #add-node').count(), 1);
  assert.deepEqual(await frame.locator('#node-capability option').allTextContents(), ['文本输入', '邮件读取']);
  await frame.locator('#node-category').selectOption('process');
  assert.deepEqual(await frame.locator('#node-capability option').allTextContents(), ['文本提取', '结果汇总']);
  await mkdir(resolve('.test-results/work-flow'), { recursive: true });
  await page.screenshot({ path: resolve('.test-results/work-flow/categories.png') });
  await credential(frame, port);
  assert.doesNotMatch(await frame.locator('#notice').textContent(), /缺少开始节点|缺少终止节点/);
  await frame.locator('.node', { hasText: 'Agent 排查' }).click();
  await frame.locator('#properties #delete-node').click();
  await frame.locator('.node', { hasText: '存在错误才继续' }).locator('.port.out').click();
  await frame.locator('.node', { hasText: '结果汇总' }).locator('.port.in').click();

  // 追加两个输出节点：HTTP 回调（打到本地服务）与写入文件。
  const received = [];
  const hook = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk.toString('utf8'); });
    request.on('end', () => { received.push(body); response.writeHead(200); response.end('ok'); });
  });
  await new Promise(resolve => hook.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => hook.close(resolve)));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
  const reportPath = join(data, 'reports', 'alarm.txt');

  await frame.locator('#node-category').selectOption('output');
  await frame.locator('#node-capability').selectOption('output.webhook');
  await frame.locator('#add-node').click();
  assert.equal(await frame.locator('#properties [data-field="title"]').inputValue(), 'HTTP 回调');
  await frame.locator('.node', { hasText: 'HTTP 回调' }).waitFor();
  await frame.locator('.node', { hasText: '结果汇总' }).locator('.port.out').click();
  await frame.locator('.node', { hasText: 'HTTP 回调' }).locator('.port.in').click();
  await frame.locator('.node', { hasText: 'HTTP 回调' }).click();
  await frame.locator('#properties [data-param="url"]').fill(hookUrl);

  await frame.locator('#node-capability').selectOption('output.file');
  await frame.locator('#add-node').click();
  await frame.locator('.node', { hasText: '写入文件' }).waitFor();
  await frame.locator('.node', { hasText: '结果汇总' }).locator('.port.out').click();
  await frame.locator('.node', { hasText: '写入文件' }).locator('.port.in').click();
  await frame.locator('.node', { hasText: '写入文件' }).click();
  await frame.locator('#properties [data-param="path"]').fill(reportPath);

  // 输出节点与终止节点都不能再连下游，连线应被拒绝。
  await frame.locator('.node', { hasText: 'HTTP 回调' }).locator('.port.out').click();
  await frame.locator('.node', { hasText: '终止' }).locator('.port.in').click();
  assert.match(await frame.locator('#status').textContent(), /不能再连到下游|不能有上游/);

  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  await frame.locator('#run').click();
  await frame.locator('#status').filter({ hasText: /运行完成|运行失败|运行已停止/ }).waitFor({ timeout: 120000 });
  assert.match(await frame.locator('#status').textContent(), /运行完成/);

  assert.equal(received.length, 1, 'HTTP 回调应收到一次投递');
  assert.match(received[0], /数据库连接池耗尽/);
  assert.match(await readFile(reportPath, 'utf8'), /数据库连接池耗尽/);

  const stored = await runFile(data);
  assert.equal(stored.run.status, 'succeeded');
  assert.ok(Object.values(stored.run.nodes).every(node => node.status === 'succeeded'),
    `所有节点都应成功：${JSON.stringify(stored.run.nodes).slice(0, 400)}`);
  assert.ok(stored.workflows.items[0].nodes.some(node => node.type === 'output.webhook'));
});

test('真实宿主：旧工作流提示补齐开始与终止节点', { timeout: 180000 }, async t => {
  const server = imapFixture([email('订单服务告警', 'ERROR 数据库连接池耗尽')]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { app, page, data } = await launch(t, { openPlugin: false });
  const frame = await install(app, page);
  await credential(frame, port);
  // 删掉开始与终止节点，模拟 0.1.2 之前保存的旧工作流。
  await frame.locator('.node', { hasText: '开始' }).click();
  await frame.locator('#properties #delete-node').click();
  await frame.locator('.node', { hasText: '终止' }).click();
  await frame.locator('#properties #delete-node').click();
  assert.match(await frame.locator('#notice').textContent(), /缺少开始节点[\s\S]*缺少终止节点/);
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();

  // 旧工作流仍能按“无上游的节点”推断入口并跑通。
  await frame.locator('.node', { hasText: 'Agent 排查' }).click();
  await frame.locator('#properties #delete-node').click();
  await frame.locator('.node', { hasText: '存在错误才继续' }).locator('.port.out').click();
  await frame.locator('.node', { hasText: '结果汇总' }).locator('.port.in').click();
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  await frame.locator('#run').click();
  await frame.locator('#status').filter({ hasText: /运行完成|运行失败|运行已停止/ }).waitFor({ timeout: 120000 });
  assert.match(await frame.locator('#status').textContent(), /运行完成/);

  // 一键补齐后起止节点就位。
  await frame.locator('#complete-ends').click();
  await frame.locator('#status').filter({ hasText: '已补齐' }).waitFor();
  assert.doesNotMatch(await frame.locator('#notice').textContent(), /缺少开始节点|缺少终止节点/);
  await frame.locator('#save').click();
  await frame.locator('#status').filter({ hasText: '已保存' }).waitFor();
  const stored = await runFile(data);
  const roles = stored.workflows.items[0].nodes.map(node => node.type);
  assert.ok(roles.includes('flow.start') && roles.includes('flow.end'), `应补齐起止节点：${roles.join()}`);
});

async function writeLogs(logs) {
  await mkdir(resolve('.test-results/work-flow'), { recursive: true });
  await writeFile(resolve('.test-results/work-flow/electron.log'), logs);
}

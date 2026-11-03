import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { feishuOutputType } from '../src/main/common/feishu-output.js';

const config = { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-3333-4444-555555555555', key: 'fixture-key' };

test('report output sends the complete saved MD and returns only delivery metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'report.md');
  const report = '# 放款报告\n\n## 渠道 A\n### AR\n申请单：123\n';
  await writeFile(path, report);
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    messages.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ code: 0 }) };
  });
  const node = feishuOutputType({ robots: { snapshot: async () => ({ ...config }) }, logger: () => {} });
  assert.equal(node.role, 'end');
  const result = await node.resolve({ value: () => path, shouldStop: () => false, runId: 'run', nodeId: 'notify' });
  assert.equal(result.delivered, true);
  assert.equal(messages[0].msg_type, 'interactive');
  assert.equal(messages[0].card.schema, '2.0');
  assert.match(JSON.stringify(messages[0].card), /申请单：123/);
  assert.equal(JSON.stringify(result).includes(config.key), false);
  assert.equal(JSON.stringify(result).includes(config.webhook), false);
});

test('a failed notification remains failed without changing the saved report or auto retrying', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-failed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'report.md');
  await writeFile(path, '# report');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return { ok: false, json: async () => ({ code: 1 }) };
  });
  const node = feishuOutputType({ robots: { snapshot: async () => ({ ...config }) }, logger: () => {} });
  await assert.rejects(node.resolve({ value: () => path, shouldStop: () => false, runId: 'run', nodeId: 'notify' }), { code: 'FEISHU_SEND_FAILED' });
  assert.equal(requests, 1);
});

test('cancellation while reading the credential snapshot prevents the first external POST', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'report.md');
  await writeFile(path, '# report');
  let stopped = false;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return { ok: true, json: async () => ({ code: 0 }) };
  });
  const robots = { snapshot: async () => { stopped = true; return { ...config }; } };
  const node = feishuOutputType({ robots, logger: () => {} });
  await assert.rejects(node.resolve({ value: () => path, shouldStop: () => stopped, runId: 'run', nodeId: 'notify' }));
  assert.equal(requests, 0);
});

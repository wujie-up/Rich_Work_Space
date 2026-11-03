import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { McpServices } from '../src/main/common/services.js';

test('service descriptions persist, appear in list and survive older clients saving without that field', async t => {
  const storage = await temporaryStore(t);
  const manager = new McpServices({ storage, pluginId: 'mcp-services' });
  t.after(() => manager.close());
  const input = { id: 'document-service', name: '文档服务', description: '读取文档正文并解析 Wiki 节点。',
    transport: 'stdio', command: 'node', args: ['server.mjs'], env: { TOKEN: 'existing-secret' } };
  await manager.save(input);
  assert.equal((await manager.list())[0].description, input.description);
  const { description, ...legacy } = input;
  await manager.save({ ...legacy, name: '更新显示名称' });
  const saved = (await manager.definitions())[0];
  assert.equal(saved.description, description);
  assert.equal(saved.env.TOKEN, 'existing-secret');
  await manager.save({ ...saved, description: '' });
  assert.equal((await manager.list())[0].description, '');
});

test('description validation rejects invalid edits before changing a saved service', async t => {
  const storage = await temporaryStore(t);
  const manager = new McpServices({ storage, pluginId: 'mcp-services' });
  t.after(() => manager.close());
  const input = { id: 'existing', name: '已有服务', description: '只读查询。', transport: 'http', url: 'https://example.test/mcp' };
  await manager.save(input);
  const before = await manager.definitions();
  for (const description of [null, 42, {}, 'x'.repeat(2001)]) {
    await assert.rejects(manager.save({ ...input, description }), /功能描述/);
  }
  assert.deepEqual(await manager.definitions(), before);
});

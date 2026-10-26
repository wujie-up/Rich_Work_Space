import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { withPackageSource } from '../../../desk/src/main/common/plugin-package.js';
import { createAgents } from '../src/main/common/agents.js';
import { TaskClient } from '../src/main/common/task-client.js';
import { createRegistry } from '../src/main/common/nodes.js';

// Only the external native engine is simulated; task handling is loaded from the unchanged release archive.
class Native {
  constructor(options) { Object.assign(this, options); }
  async start() {}
  async request(method) { return method === 'thread/start' ? { thread: { id: 'thread' } } : { turn: { id: 'turn' } }; }
  respond() {}
  close() {}
}

test('现有 AI Agent 0.6.1 原包完成角色节点和代码节点，无需新增能力或结果字段', async t => {
  await withPackageSource(resolve('plugin-dev/dist/ai-agent-sessions-0.6.1.plg'), async root => {
    const { AgentTasks, registerTasks } = await import(pathToFileURL(join(root, 'src/main/common/tasks.js')));
    const { Conversations } = await import(pathToFileURL(join(root, 'src/main/common/conversations.js')));
    const storage = await temporaryStore(t);
    const cwd = join(storage.root, 'workspace');
    await mkdir(cwd);
    await writeFile(join(cwd, 'source.js'), 'before');
    const conversations = new Conversations({ storage, pluginId: 'compat-agent', Engine: Native, ownProcesses: () => {}, emit: () => {},
      runtime: { launch: async () => ({ env: { HOME: cwd }, args: [], runtimeId: 'test' }) },
      createGateway: () => ({ token: 'token', url: 'http://localhost/mcp', start: async () => {}, refreshCatalog: async () => false,
        close: async () => {}, cancel: async () => {} }) });
    await conversations.load();
    const tasks = new AgentTasks({ storage, conversations, pluginId: 'compat-agent' });
    await tasks.load();
    try {
      const entries = new Map();
      const invocations = new Map();
      await registerTasks({ register: async (descriptor, handler) => entries.set(descriptor.id, { descriptor, handler }) }, tasks);
      const capabilities = {
        discover: async () => ({ providers: [...entries.values()].map(({ descriptor }) => ({ state: 'ready', descriptor,
          handle: { pluginId: 'compat-agent', capabilityId: descriptor.id } })) }),
        invoke: async (handle, input) => {
          const invocationId = crypto.randomUUID();
          invocations.set(invocationId, await entries.get(handle.capabilityId).handler(input));
          return { invocationId };
        },
        getInvocation: async id => ({ state: 'succeeded', result: invocations.get(id) }),
        cancel: async () => {}
      };
      const agents = createAgents({ tasks: new TaskClient(capabilities) });
      const node = createRegistry({ credentials: {} }).get('agent.review');
      for (const mode of ['plan', 'code']) {
        const params = { input: '评审并完成任务', rolePrompt: '你是开发 Agent', cwd, mode, files: 'source.js',
          outputFields: '{"passed":"boolean"}' };
        const request = await node.prepare({ params, variables: {}, value: name => params[name] });
        await agents.run(request);
        await tasks.active.get(request.taskKey);
        const active = [...conversations.engines.values()].at(-1);
        const record = conversations.read(tasks.get(request.taskKey).conversationId);
        assert.equal(record.task.kind, mode);
        if (mode === 'code') {
          await writeFile(join(cwd, 'source.js'), 'after');
        }
        for (const text of ['开始处理', '{"passed":true}']) {
          active.engine.onEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } });
        }
        active.engine.onEvent({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
        const result = await agents.run(request);
        assert.equal(result.state, 'succeeded');
        assert.deepEqual(node.after(result, request).output, { passed: true });
      }
      assert.equal(await readFile(join(cwd, 'source.js'), 'utf8'), 'after');
    } finally {
      await tasks.stop();
      await conversations.stop();
    }
  });
});

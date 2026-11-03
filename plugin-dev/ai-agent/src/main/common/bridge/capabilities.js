const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const bindingId = text(100);
const taskId = text(100);
const requestKey = { type: 'string', minLength: 64, maxLength: 64 };

export async function registerBridge(capabilities, bridge) {
  const definitions = [
    ['catalog', {}, []],
    ['bind', { bindingKey: text(500), sourceScope: { type: 'object', properties: { channelId: text(100), chatId: text(300),
      senderIds: { type: 'array', minItems: 1, maxItems: 100, items: text(300) } }, required: ['channelId', 'chatId', 'senderIds'], additionalProperties: false },
    target: { type: 'object', properties: { mode: { enum: ['existing', 'dedicated'], type: 'string' },
      targetRef: { type: 'object', properties: { kind: { type: 'string', enum: ['conversation', 'terminal'] }, id: text(100) },
        required: ['kind', 'id'], additionalProperties: false }, engineId: { type: 'string', enum: ['codex', 'claude'] }, cwd: text(4000), name: text(200) },
    required: ['mode'], additionalProperties: false },
    executionPolicy: { type: 'object', properties: { mode: { type: 'string', enum: ['readOnly', 'existing'] }, accepted: { type: 'boolean' } },
      required: ['mode'], additionalProperties: false } }, ['bindingKey', 'sourceScope', 'target', 'executionPolicy']],
    ['submit', { bindingId, requestKey, sourceMessageKey: text(1000), text: text(60000) }, ['bindingId', 'requestKey', 'sourceMessageKey', 'text']],
    ['read', { taskId, bindingId, requestKey }, []],
    ['respond', { taskId, requestId: { anyOf: [{ type: 'string' }, { type: 'number' }] }, answers: { type: 'object' } },
      ['taskId', 'requestId', 'answers']],
    ['cancel', { taskId }, ['taskId']],
    ['suspend', { bindingId }, ['bindingId']],
    ['unbind', { bindingId }, ['bindingId']]
  ];
  for (const [method, properties, required] of definitions) {
    await capabilities.register({ id: `agent.bridge.${method}.v1`, version: 1, title: `消息桥接 · ${method}`,
      description: '外部消息专用的会话绑定与轮次管理；授权不包含原生权限审批',
      inputSchema: { type: 'object', properties, required, additionalProperties: false }, outputSchema: { type: 'object' },
      effects: [method === 'catalog' || method === 'read' ? 'workspace.read' : 'workspace.write'], confirmation: 'policy',
      execution: { timeoutMs: 30000, cancellable: true, retry: 'never' }, state: 'ready' },
    (input, context) => bridge[method](input, context));
  }
}

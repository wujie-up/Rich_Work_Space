import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'native-parity-fixture', version: '1' }, { capabilities: { tools: {} } });
let rootChanges = 0;
server.setNotificationHandler(RootsListChangedNotificationSchema, () => { rootChanges++; });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'interact',
  description: 'Local native elicitation parity fixture', annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } }] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const action = request.params.arguments.action;
  if (action === 'rootChanges') {
    return { content: [{ type: 'text', text: String(rootChanges) }] };
  }
  if (action === 'roots') {
    const result = await server.listRoots();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
  if (action === 'sampling') {
    const result = await server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'fixture' } }], maxTokens: 10 });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
  if (action === 'wait') {
    await new Promise(resolve => {
      extra.signal.addEventListener('abort', resolve, { once: true });
      if (extra.signal.aborted) { resolve(); }
    });
    return { content: [{ type: 'text', text: 'CANCELLED' }] };
  }
  if (action === 'slow') {
    await new Promise(resolve => setTimeout(resolve, 19000));
    return { content: [{ type: 'text', text: 'SLOW_NATIVE_TOOL_OK' }] };
  }
  if (action === 'form' || action === 'url') {
    const params = action === 'url' ? { mode: 'url', message: 'Open the local authorization fixture',
      url: 'https://example.com/native-fixture', elicitationId: 'native-fixture' }
      : { mode: 'form', message: 'Enter typed local test values', requestedSchema: { type: 'object', properties: {
        name: { type: 'string' }, count: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string', enum: ['one', 'two'] } }
      }, required: ['name', 'count', 'enabled', 'tags'] } };
    const answer = await server.elicitInput(params, { relatedRequestId: extra.requestId, signal: extra.signal });
    return { content: [{ type: 'text', text: JSON.stringify({ fixture: action, answer }) }] };
  }
  const answer = await server.elicitInput({ mode: 'form', message: 'Choose the local test value',
    requestedSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
  { relatedRequestId: extra.requestId, signal: extra.signal });
  return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
});
await server.connect(new StdioServerTransport());

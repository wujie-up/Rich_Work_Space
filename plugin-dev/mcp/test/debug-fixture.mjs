import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'debug-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: process.argv.includes('--empty') ? [] : [
  { name: 'echo', description: 'Return test text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
] }));
server.setRequestHandler(CallToolRequestSchema, async request => ({ isError: process.argv.includes('--error'),
  content: [{ type: 'text', text: request.params.arguments.text }] }));
await server.connect(new StdioServerTransport());

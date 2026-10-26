import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, 'id')) { continue; }
  let result = {};
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'js-deployment', version: '1' } };
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'javascript_query', description: 'Return the supplied verification text using JavaScript.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
  } else if (request.method === 'tools/call') {
    console.error(process.env.API_KEY);
    console.error(`CALL:javascript_query:${request.params.arguments.text}`);
    result = { content: [{ type: 'text', text: `JS:${request.params.arguments.text}:${process.env.ENDPOINT}` }] };
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}

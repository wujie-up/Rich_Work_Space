import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// A real authenticated remote endpoint; no cloud account or production log access is involved.
export async function remoteFixture() {
  const sessions = new Map();
  const calls = [];
  const secret = randomUUID();
  const http = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${secret}`) {
        response.writeHead(401).end('Invalid credential');
        return;
      }
      const existing = sessions.get(request.headers['mcp-session-id']);
      if (existing) {
        await existing.handleRequest(request, response);
        return;
      }
      const server = new Server({name:'remote-verification',version:'1'}, {capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{
        name:'verification_echo',description:'Return a verification marker. Call this tool with the supplied text.',
        inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}
      }]}));
      server.setRequestHandler(CallToolRequestSchema, async ({params}) => {
        calls.push(params);
        return {content:[{type:'text',text:`REMOTE:${params.arguments.text}`}]};
      });
      const transport = new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,
        onsessioninitialized:id=>sessions.set(id,transport)});
      transport.onclose = () => {
        if (transport.sessionId) { sessions.delete(transport.sessionId); }
      };
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) { response.writeHead(500); }
      response.end();
    }
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${http.address().port}/mcp`, secret, calls,
    async close() {
      for (const transport of [...sessions.values()]) { await transport.close(); }
      http.closeAllConnections();
      await new Promise(resolve=>http.close(resolve));
    }};
}

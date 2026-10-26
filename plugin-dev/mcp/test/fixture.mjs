import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'work-desk-test',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',description:'Echo test text',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true},inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>({content:[{type:'text',text:request.params.arguments.text}]}));
await server.connect(new StdioServerTransport());

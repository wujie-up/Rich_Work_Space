import { randomUUID } from 'node:crypto';
import { AppServer } from './app-server.js';

// Translate Claude's bidirectional native stream into the existing conversation event contract.
export class ClaudeEngine extends AppServer {
  async start(launch) {
    this.threadId = launch.threadId || randomUUID();
    this.toolRequests = new Map();
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool=stdio', '--permission-mode', launch.plan ? 'plan' : 'default',
      '--setting-sources', 'user,project,local', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: launch.gateway ? {
        work_desk: { type: 'http', url: launch.gateway.url, headers: { Authorization: `Bearer ${launch.gateway.token}` } }
      } : {} }), launch.resume ? '--resume' : '--session-id', this.threadId];
    return super.start({ ...launch, protocolArgs: args });
  }

  send(message) {
    if (message.method === 'initialized') { return; }
    if (message.method) {
      const request = message.method === 'initialize' ? { subtype: 'initialize' } : { subtype: message.method, ...message.params };
      return super.send({ type: 'control_request', request_id: String(message.id), request });
    }
    return super.send(message);
  }

  async request(method, params = {}, timeoutMs) {
    if (method === 'thread/start' || method === 'thread/resume') {
      return { thread: { id: this.threadId } };
    }
    if (method === 'turn/start') {
      this.turnId = randomUUID();
      this.streamed = false;
      this.messageId = randomUUID();
      this.send({ type: 'user', session_id: this.threadId, parent_tool_use_id: null,
        message: { role: 'user', content: params.input.map(item => ({ type: 'text', text: item.text })) } });
      return { turn: { id: this.turnId, status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') {
      return super.request('interrupt', {}, timeoutMs);
    }
    return super.request(method, params, timeoutMs);
  }

  receive(message) {
    if (message.type === 'control_response') {
      return super.receive({ id: Number(message.response.request_id), result: message.response.response,
        ...(message.response.subtype === 'error' ? { error: { message: message.response.error } } : {}) });
    }
    if (message.type === 'control_request') {
      if (message.request.subtype !== 'can_use_tool') {
        this.send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id,
          error: 'Unsupported control request' } });
        return;
      }
      this.toolRequests ||= new Map();
      this.toolRequests.set(message.request_id, message.request);
      if (message.request.tool_name === 'AskUserQuestion') {
        this.onEvent({ id: message.request_id, method: 'item/tool/requestUserInput', params: {
          questions: message.request.input.questions.map((question, index) => ({ ...question, id: String(index) }))
        } });
        return;
      }
      this.onEvent({ id: message.request_id, method: 'item/commandExecution/requestApproval', params: {
        command: `${message.request.tool_name}: ${JSON.stringify(message.request.input)}`, reason: message.request.decision_reason
      } });
    } else if (message.type === 'control_cancel_request') {
      this.toolRequests.delete(message.request_id);
      this.onEvent({ method: 'item/completed', params: { item: { type: 'approvalCancelled', requestId: message.request_id } } });
    } else if (message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
      this.streamed = true;
      this.onEvent({ method: 'item/agentMessage/delta', params: { itemId: this.messageId, delta: message.event.delta.text } });
    } else if (message.type === 'assistant') {
      for (const item of message.message.content) {
        if (item.type === 'text' && !this.streamed) {
          this.onEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', id: message.uuid, text: item.text } } });
        } else if (item.type === 'tool_use') {
          this.onEvent({ method: 'item/completed', params: { item: { type: 'toolCall', name: item.name, input: item.input } } });
        }
      }
      this.streamed = false;
      this.messageId = randomUUID();
    } else if (message.type === 'result') {
      if (message.is_error) {
        this.onEvent({ method: 'error', params: { message: 'Claude 执行失败，请检查授权、网络和额度。' } });
      }
      this.onEvent({ method: 'turn/completed', params: { turn: { id: this.turnId, status: message.is_error ? 'failed' : 'completed' } } });
    }
  }

  respond(id, result) {
    const request = this.toolRequests.get(id);
    if (!request) { throw Error('审批已失效'); }
    this.toolRequests.delete(id);
    // Claude keys answers by question text; the shared conversation UI uses stable numeric IDs.
    const updatedInput = request.tool_name === 'AskUserQuestion' && result.answers ? { ...request.input,
      answers: Object.fromEntries(request.input.questions.map((question, index) =>
        [question.question, result.answers[String(index)].answers.join(', ')])) } : request.input;
    const response = result.answers || result.decision === 'accept' ? { behavior: 'allow', updatedInput }
      : { behavior: 'deny', message: '用户拒绝了此操作' };
    this.send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  }
}

// Errors cross IPC as data so renderer failures retain a stable, actionable code.
export function fail(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

export function pluginId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw fail('INVALID_ARGUMENT', '插件 ID 无效');
  }
  return value;
}

export function sessionName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60 || /[\x00-\x1f]/.test(value)) {
    throw fail('INVALID_ARGUMENT', '窗口名称需为 1–60 个字符');
  }
  return value.trim();
}

export const CHANNELS = ['plugins.changed', 'sessions.changed', 'sessions.output', 'host.error'];

// Codex now requests MCP tool approval through elicitation rather than requestApproval.
export const isApprovalRequest = event => event.method.endsWith('/requestApproval')
  || event.method === 'mcpServer/elicitation/request' && event.params?._meta?.codex_approval_kind === 'mcp_tool_call';

export const isElicitationRequest = event => event.method === 'mcpServer/elicitation/request' && !isApprovalRequest(event);

// Replay native resolution in order so numeric IDs, request ID reuse and interrupted turns share one lifecycle.
export function pendingRequests(events) {
  const pending = new Map();
  for (const event of events) {
    if (event.id !== undefined && (isApprovalRequest(event) || isElicitationRequest(event)
      || event.method === 'item/tool/requestUserInput')) {
      pending.set(event.id, event);
    } else if (['approval/answered', 'serverRequest/resolved'].includes(event.method)) {
      pending.delete(event.params.requestId);
    } else if (event.params?.item?.type === 'approvalCancelled') {
      pending.delete(event.params.item.requestId);
    } else if (event.method === 'turn/completed') {
      for (const [id, request] of pending) {
        if (request.params?.turnId && request.params.turnId === event.params.turn.id
          && request.params.threadId === event.params.threadId) { pending.delete(id); }
      }
    }
  }
  return [...pending.values()];
}

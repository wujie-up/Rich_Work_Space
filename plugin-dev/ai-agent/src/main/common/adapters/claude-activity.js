import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const events = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'StopFailure', 'Notification', 'Elicitation', 'ElicitationResult'];

function activity(event) {
  const blocked = { PermissionRequest: 'permission', Elicitation: 'question' }[event.hook_event_name];
  if (blocked || event.hook_event_name === 'PreToolUse' && event.tool_name === 'AskUserQuestion') {
    return { activity: 'idle', blocked: blocked || 'question' };
  }
  if (event.hook_event_name === 'Notification') {
    const kind = { permission_prompt: 'permission', elicitation_dialog: 'question', elicitation_url_dialog: 'question' }[event.notification_type];
    return kind ? { activity: 'idle', blocked: kind } : null;
  }
  return { activity: { Stop: 'done', StopFailure: 'error' }[event.hook_event_name] || 'working', blocked: null };
}

// Hooks only report lifecycle. Empty responses deliberately leave every native permission decision to the user.
export async function prepareClaudeActivity(changed) {
  const path = `/${randomUUID()}`;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== path) {
      response.writeHead(404).end();
      return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
      }
      const event = JSON.parse(body);
      if (events.includes(event.hook_event_name) && !event.agent_id) {
        const state = activity(event);
        if (state) { changed({ ...state, ...(event.session_id ? { contextId: event.session_id } : {}) }); }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } catch (error) {
      console.error('[claude:activity]', { message: error.message });
      response.writeHead(400).end();
    }
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}${path}`;
  return {
    settings: { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'http', url, timeout: 3 }] }]])) },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

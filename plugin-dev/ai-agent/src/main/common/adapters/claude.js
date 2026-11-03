import { basename } from 'node:path';
import { prepareClaudeActivity } from './claude-activity.js';

// Native session IDs allow terminal history to resume without parsing terminal output.
export function createClaudeAdapter() {
  return {
    id: 'claude', name: 'Claude Code',
    capabilities: { restore: true, fork: false, permissions: true, activity: true },
    prepareActivity: prepareClaudeActivity,
    permissionModes: [{ id: 'default', label: '请求批准', description: '由 Claude Code 原生审批交互确认操作' },
      { id: 'plan', label: '计划模式', description: '只读探索和制定计划' },
      { id: 'unrestricted', label: '完全访问权限', description: '可不受限制地访问互联网和你电脑上的任何文件' }],
    buildLaunch(input) {
      const permission = input.permission || 'default';
      if (!['default', 'plan', 'unrestricted'].includes(permission)) { throw Error('不支持此权限模式'); }
      if (input.mode === 'resume' && !input.contextId) { throw Error('尚未保存 Claude 上下文'); }
      // Keep the shared permission ID out of Claude's native command-line protocol.
      return { args: ['--permission-mode', permission === 'unrestricted' ? 'bypassPermissions' : permission,
        '--setting-sources', 'user,project,local', '--strict-mcp-config',
        '--mcp-config', JSON.stringify(input.launchOverrides || { mcpServers: {} }), ...(input.activitySettings ? ['--settings', JSON.stringify(input.activitySettings)] : []),
        ...(input.roleInstructions ? ['--append-system-prompt', input.roleInstructions] : []),
        ...(input.mode === 'resume' ? ['--resume', input.contextId]
          : ['--session-id', basename(input.sessionDataDir)])] };
    },
    resolveContext: session => session.contextId || basename(session.sessionDataDir)
  };
}

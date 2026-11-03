import { join } from 'node:path';
import { readActivity } from './activity.js';
import { prepareCodexActivity } from './codex-activity.js';
import { readCodexSession, restoreCodexSession } from './codex-session.js';

const PERMISSION_MODES = [
  {
    id: 'request-approval', label: '请求批准', description: '编辑外部文件和使用互联网时始终询问',
    args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '-c', 'approvals_reviewer="user"',
      '-c', 'sandbox_workspace_write.network_access=false']
  },
  {
    id: 'approve-for-me', label: '帮我批准', description: '仅对检测到的风险操作请求批准',
    args: ['--approve-for-me', '-c', 'sandbox_workspace_write.network_access=false']
  },
  {
    id: 'unrestricted', label: '完全访问权限', description: '可不受限制地访问互联网和你电脑上的任何文件',
    args: ['--dangerously-bypass-approvals-and-sandbox']
  }
];

// Existing archives retain their original boundary; the new full-access preset has a distinct ID.
const LEGACY_PERMISSIONS = {
  default: [],
  'read-only': ['--sandbox', 'read-only', '--ask-for-approval', 'never'],
  'workspace-write': ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
  'full-access': ['--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request']
};

// Codex private protocols stay here; host sessions do not infer CLI state from silence.
export function createCodexAdapter(config = {}) {
  return {
    id: 'codex', name: 'Codex', permissionModes: PERMISSION_MODES.map(({ args, ...mode }) => mode),
    capabilities: { restore: true, fork: true, permissions: true, activity: true, inputProtocol: 'codex' },
    prepareActivity: (changed, session) => prepareCodexActivity(changed, session, config.dataRoot),
    buildLaunch(input) {
      const permission = input.permission || 'request-approval';
      const permissionArgs = PERMISSION_MODES.find((mode) => mode.id === permission)?.args
        ?? (Object.hasOwn(LEGACY_PERMISSIONS, permission) ? LEGACY_PERMISSIONS[permission] : undefined);
      if (!permissionArgs) {
        throw new Error('不支持此权限模式');
      }
      const args = [...(config.args || []), ...permissionArgs, '-c', `log_dir=${JSON.stringify(input.sessionDataDir)}`];
      if (input.roleInstructions) { args.push('-c', `developer_instructions=${JSON.stringify(input.roleInstructions)}`); }
      args.push(...(input.launchOverrides || []).flatMap(value => ['-c', value]));
      if (['resume', 'fork'].includes(input.mode) && !input.contextId) {
        throw new Error('尚未识别上下文，无法恢复或分叉');
      }
      if (['resume', 'fork'].includes(input.mode)) {
        // A moved project must not stop restoration at Codex's historical/current directory chooser.
        if (input.cwd) {
          args.push('--cd', input.cwd);
        }
        args.push(input.mode, input.contextId);
      }
      return {
        command: config.command || 'codex', args,
        env: { RUST_LOG: `${process.env.RUST_LOG || 'warn'},codex_core::session=info` }
      };
    },
    parseActivity(state, data) {
      const activity = readActivity(state, data);
      if (state.blocked === 'question' && ['idle', 'done'].includes(activity)) {
        return { activity, blocked: 'question' };
      }
      return ['permission', 'question', 'auth', 'blocked'].includes(activity)
        ? { activity: 'unknown', blocked: activity === 'blocked' ? 'question' : activity,
          question: activity === 'question' && state.blocked === 'question' ? state.question : null }
        : { activity, blocked: null, question: null };
    },
    resolveContext: (session) => readCodexSession(join(session.sessionDataDir, 'codex-tui.log'), session.contextId),
    async restoreContext(session) {
      if (!config.dataRoot || session.protocol !== 'managed-terminal' || !session.runtimeId) {
        return session.contextId;
      }
      const profileId = session.profileId || 'default';
      if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) {
        throw Error('无效运行配置 ID');
      }
      return restoreCodexSession(session, join(config.dataRoot, 'profiles', profileId, 'codex'), join(config.dataRoot, 'logs'));
    }
  };
}

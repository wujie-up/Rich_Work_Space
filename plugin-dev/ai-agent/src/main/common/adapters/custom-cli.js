// Executable plus argv is passed directly to PTY, never interpreted by a shell.
export function createCustomCliAdapter(config = {}) {
  return {
    id: 'custom', name: '自定义 CLI', permissionModes: [],
    capabilities: { restore: false, fork: false, permissions: false, activity: false, inputProtocol: config.inputProtocol || null },
    buildLaunch(input) {
      if (input.mode && input.mode !== 'new') {
        throw new Error('自定义 CLI 不支持上下文恢复或分叉');
      }
      if (typeof config.command !== 'string' || !config.command.trim() || !Array.isArray(config.args)
        || !config.args.every((arg) => typeof arg === 'string')) {
        throw new Error('请配置 CLI 可执行文件及 JSON 参数数组');
      }
      return { command: config.command, args: config.args, env: {} };
    }
  };
}

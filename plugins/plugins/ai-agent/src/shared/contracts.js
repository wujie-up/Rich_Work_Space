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

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

export const CHANNELS = ['plugins.changed', 'plugins.event', 'host.error'];

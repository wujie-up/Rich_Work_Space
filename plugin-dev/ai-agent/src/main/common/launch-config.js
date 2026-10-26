// Launch providers are optional; an installed provider's failure must remain visible to the caller.
export async function resolveLaunchConfig(context, adapterId, input = {}) {
  if (!['codex', 'claude'].includes(adapterId)) { return []; }
  const deadline = Date.now() + 5000;
  const providers = await context.services.discover('agent.launch-config.v1');
  if (!providers.length) { return adapterId === 'claude' ? { mcpServers: {} } : []; }
  if (providers.length > 1) {
    throw Object.assign(Error('多个插件提供 AI 启动配置，请仅启用一个 Adapter'), { code: 'LAUNCH_PROVIDER_CONFLICT' });
  }
  const result = await context.services.invoke(providers[0], { clientId: adapterId, cwd: input.cwd, mode: input.mode }, { timeout: Math.max(1, Math.min(4500, deadline - Date.now())) });
  if (adapterId === 'claude') {
    const servers = result?.mcpConfig?.mcpServers;
    if (result?.version !== 1 || !servers || typeof servers !== 'object' || Array.isArray(servers)
      || Object.keys(result.mcpConfig).some(key => key !== 'mcpServers')
      || Object.entries(servers).some(([name, server]) => !/^desk_[a-zA-Z0-9_]+$/.test(name)
        || !server || server.type !== 'http' || typeof server.url !== 'string'
        || typeof server.headers?.Authorization !== 'string'
        || Object.keys(server).some(key => !['type', 'url', 'headers'].includes(key))
        || Object.keys(server.headers).some(key => key !== 'Authorization'))) {
      throw Object.assign(Error('AI 启动配置契约无效'), { code: 'LAUNCH_CONFIG_INVALID' });
    }
    return result.mcpConfig;
  }
  if (result?.version !== 1 || !Array.isArray(result.overrides)
    || result.overrides.some(value => typeof value !== 'string' || !/^mcp_servers\.desk_[a-zA-Z0-9_]+\.(url|http_headers)=/.test(value))) {
    throw Object.assign(Error('AI 启动配置契约无效'), { code: 'LAUNCH_CONFIG_INVALID' });
  }
  return result.overrides;
}

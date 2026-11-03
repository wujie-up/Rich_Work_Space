import { createHash } from 'node:crypto';

// Persist service identities only: host handles and loopback credentials are resolved again at launch.
export function serviceAllowed({ handle, descriptor }, selection) {
  return !descriptor.source?.serviceId || selection?.mode !== 'selected'
    || selection.services.some(service => service.pluginId === handle.pluginId && service.serviceId === descriptor.source.serviceId);
}

export function serviceCatalog(catalog) {
  const services = new Map();
  for (const { handle, descriptor, state } of catalog.providers) {
    if (!descriptor.source?.serviceId || descriptor.source.debug) { continue; }
    const serviceId = descriptor.source.serviceId;
    const key = JSON.stringify([handle.pluginId, serviceId]);
    const previous = services.get(key);
    services.set(key, { pluginId: handle.pluginId, serviceId, name: descriptor.title.split(' · ')[0],
      state: state === 'ready' || previous?.state === 'ready' ? 'ready' : state });
  }
  return [...services.values()];
}

// agent.launch-config.v1 uses stable desk_<hash(pluginId:serviceId)> names for both supported clients.
export function filterLaunchServices(engineId, config, selection) {
  if (selection?.mode !== 'selected') { return config; }
  const names = new Set(selection.services.map(({ pluginId, serviceId }) =>
    `desk_${createHash('sha256').update(`${pluginId}:${serviceId}`).digest('hex').slice(0, 16)}`));
  const available = new Set(engineId === 'claude' ? Object.keys(config.mcpServers)
    : config.map(value => value.match(/^mcp_servers\.([^.]+)\./)?.[1]));
  if ([...names].some(name => !available.has(name))) { throw Error('所选 MCP 服务不可用，请先启动服务或重新选择'); }
  if (engineId === 'claude') {
    return { mcpServers: Object.fromEntries(Object.entries(config.mcpServers).filter(([name]) => names.has(name))) };
  }
  return config.filter(value => names.has(value.match(/^mcp_servers\.([^.]+)\./)?.[1]));
}

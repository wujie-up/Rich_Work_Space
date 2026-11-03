import { setTimeout as delay } from 'node:timers/promises';
import { fail } from './errors.js';

export const payoutTimeoutMs = 1800000;
const timeoutMs = payoutTimeoutMs;

function serviceProviders(catalog, serviceId) {
  const calls = catalog.providers.filter(item => item.state === 'ready' && item.descriptor.source?.debug !== true
    && item.descriptor.effects.includes('mcp.tool') && (serviceId ? item.descriptor.source?.serviceId === serviceId
      : /m[ae]tabase/i.test(item.descriptor.title)));
  if (calls.length !== 1) {
    throw fail('PAYOUT_MCP_MISSING', '请启动 Metabase MCP；有多个服务时填写唯一的 MCP 服务ID');
  }
  const call = calls[0];
  const describe = catalog.providers.find(item => item.state === 'ready'
    && item.handle.pluginId === call.handle.pluginId && item.descriptor.source?.serviceId === call.descriptor.source.serviceId
    && item.descriptor.effects.includes('network.read') && !item.descriptor.effects.includes('mcp.tool'));
  if (!describe) {
    throw fail('PAYOUT_MCP_MISSING', 'Metabase MCP 缺少工具说明能力');
  }
  return { call, describe };
}

function toolData(result) {
  if (result.isError) {
    throw Error('Metabase MCP 工具返回错误');
  }
  const texts = result.content?.filter(block => block.type === 'text') || [];
  if (texts.length !== 1) {
    throw Error('Metabase MCP 返回格式不符合预期');
  }
  return JSON.parse(texts[0].text);
}

export async function withPayoutMcp(context, tasks, logger, operation) {
  const { serviceId } = context.params;
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs - 10000;
  const cancelIfNeeded = () => {
    if (context.shouldStop() || Date.now() >= deadline) {
      controller.abort(fail('PAYOUT_STOPPED', '巡检已停止或超时，未生成完整报告'));
    }
  };
  const check = () => {
    cancelIfNeeded();
    controller.signal.throwIfAborted();
  };
  check();
  const timer = setInterval(cancelIfNeeded, 100);
  timer.unref?.();
  let lease;
  try {
    const { call, describe } = serviceProviders(await tasks.capabilities.discover(), String(serviceId || ''));
    check();
    lease = await tasks.capabilities.authorize({ scopeKey: `payout-audit:${context.nodeId}:${call.descriptor.source.serviceId}`,
      title: '每日放款未回调巡检 · Metabase 只读查询', providers: [describe.handle, call.handle], approval: 'automatic' });
    while (true) {
      check();
      const authorization = await tasks.capabilities.authorization(lease.id);
      if (authorization.state === 'granted') {
        break;
      }
      if (authorization.state !== 'pending') {
        throw fail('PAYOUT_AUTHORIZATION_DENIED', 'Metabase 巡检授权被拒绝或失效');
      }
      await delay(150, undefined, { signal: controller.signal });
    }
    const options = { providerId: call.handle.pluginId, authorizationId: lease.id, signal: controller.signal };
    const tools = await tasks.call(describe.descriptor.id, {}, options);
    if (!['metabase_databases', 'metabase_query'].every(name => tools.tools?.some(tool => tool.name === name))) {
      throw Error('所选 MCP 服务未提供 metabase_databases / metabase_query');
    }
    const invoke = async (name, args) => {
      check();
      const data = toolData(await tasks.call(call.descriptor.id, { name, arguments: args }, options));
      check();
      return data;
    };
    const databases = await invoke('metabase_databases', {});
    if (databases.status !== 'ok' || !Array.isArray(databases.databases)) {
      throw Error('无法读取 Metabase 数据库列表');
    }
    const names = new Set(databases.databases.map(database => database.name));
    return await operation(async query => {
      if (!names.has(query.database)) {
        throw Error(`当前账号无法访问数据库：${query.database}`);
      }
      return invoke('metabase_query', query);
    }, { signal: controller.signal, onPage: page => logger('info', 'payout-query', {
      runId: context.runId, nodeId: context.nodeId, ...page }) });
  } catch (error) {
    logger('error', 'payout-failed', { runId: context.runId, nodeId: context.nodeId, stack: error.stack });
    throw error;
  } finally {
    clearInterval(timer);
    if (lease) {
      await tasks.capabilities.revoke(lease.id);
    }
  }
}

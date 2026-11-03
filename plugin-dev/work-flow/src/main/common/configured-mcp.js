import { setTimeout as delay } from 'node:timers/promises';
import { fieldOf, resolveMapping } from './configured-data.js';
import { readPath } from './template.js';
import { fail } from './errors.js';

function sqlLiteral(binding) {
  const input = binding?.value;
  if (input === null) {
    return 'NULL';
  }
  if (binding?.type === 'integer' && ((typeof input === 'string' && /^-?\d{1,20}$/.test(input)) || Number.isSafeInteger(input))) {
    return String(input);
  }
  if (binding?.type === 'number' && typeof input === 'number' && Number.isFinite(input) && Math.abs(input) <= Number.MAX_SAFE_INTEGER) {
    return String(input);
  }
  if (binding?.type === 'boolean' && typeof input === 'boolean') {
    return input ? '1' : '0';
  }
  if (binding?.type === 'string' && typeof input === 'string' && !/[\\\u0000-\u001f]/.test(input)) {
    return `'${input.replaceAll("'", "''")}'`;
  }
  throw fail('INVALID_ARGUMENT', 'SQL绑定类型不匹配；大整数请用十进制字符串，文本不包含反斜线或控制字符');
}

// SQL placeholders always become typed literals, never raw interpolated upstream text.
export function bindSql(sql, bindings) {
  if (/--|\/\*|\*\/|#/.test(sql)) {
    throw fail('INVALID_ARGUMENT', 'SQL绑定模板不支持注释符号');
  }
  if (/\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$|\bq'/i.test(sql)) {
    throw fail('INVALID_ARGUMENT', 'SQL绑定模板不支持dollar/q引用语法');
  }
  let quote = '';
  let output = '';
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const token = sql.slice(index).match(/^\{\{\s*([\w.-]+)\s*\}\}/);
    if (token) {
      if (quote) {
        throw fail('INVALID_ARGUMENT', 'SQL占位符不能放在引号内；绑定会自动添加类型和引号');
      }
      if (!Object.hasOwn(bindings, token[1])) {
        throw fail('INVALID_ARGUMENT', `SQL绑定不存在：${token[1]}`);
      }
      output += sqlLiteral(bindings[token[1]]);
      index += token[0].length - 1;
    } else {
      output += char;
      if (quote && (char === '\\' || char === quote && sql[index + 1] === quote)) {
        output += sql[++index] || '';
      } else if (char === quote) {
        quote = '';
      } else if (!quote && char === '[') {
        quote = ']';
      } else if (!quote && ['"', "'", '\u0060'].includes(char)) {
        quote = char;
      }
    }
  }
  return output;
}

function toolData(result) {
  if (result.isError) {
    throw fail('MCP_TOOL_FAILED', 'MCP工具返回错误，未产生完整结果');
  }
  const texts = result.content?.filter(item => item.type === 'text') || [];
  const data = result.structuredContent ?? (texts.length === 1 && texts[0].text.length <= 4194304 ? JSON.parse(texts[0].text) : undefined);
  if (data === undefined || Buffer.byteLength(JSON.stringify(data)) > 4194304 || data?.status === 'error') {
    throw fail('MCP_TOOL_FAILED', `MCP结果无效或失败：${data?.error_code || 'INVALID_RESULT'}`);
  }
  if (Array.isArray(data.columns) && Array.isArray(data.rows)) {
    if (data.rows.some(row => !Array.isArray(row) || row.length !== data.columns.length)) {
      throw fail('MCP_TOOL_FAILED', 'MCP结果列与行不匹配');
    }
    return { ...data, rows: data.rows.map(row => Object.fromEntries(data.columns.map((column, index) => [column.name, row[index]]))) };
  }
  return data;
}

function providersOf(catalog, serviceId) {
  const calls = catalog.providers.filter(item => item.state === 'ready' && item.descriptor.source?.debug !== true
    && item.descriptor.effects.includes('mcp.tool') && (!serviceId || item.descriptor.source?.serviceId === serviceId));
  if (calls.length !== 1) {
    throw fail('MCP_PROVIDER_MISSING', '需要唯一可用MCP服务；请在config中填写serviceId');
  }
  const call = calls[0];
  const describe = catalog.providers.find(item => item.state === 'ready' && item.handle.pluginId === call.handle.pluginId
    && item.descriptor.source?.serviceId === call.descriptor.source?.serviceId && item.descriptor.effects.includes('network.read')
    && !item.descriptor.effects.includes('mcp.tool'));
  if (!describe) {
    throw fail('MCP_PROVIDER_MISSING', '该MCP服务缺少工具描述能力');
  }
  return { call, describe };
}

function paginationOf(config) {
  if (!config) {
    return null;
  }
  const pageSize = config.pageSize ?? 100;
  const maxPages = config.maxPages ?? 10000;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000
    || typeof config.cursorField !== 'string' || !['integer', 'string'].includes(config.cursorType || 'integer')) {
    throw fail('INVALID_ARGUMENT', '分页需要cursorField、1–100的pageSize、1–10000的maxPages及integer/string游标类型');
  }
  return { ...config, pageSize, maxPages, cursorType: config.cursorType || 'integer' };
}

function advanceCursor(row, cursor, paging) {
  const next = fieldOf(row, paging.cursorField);
  if (paging.cursorType === 'integer') {
    const valid = typeof next === 'string' && /^\d{1,20}$/.test(next) || Number.isSafeInteger(next) && next >= 0;
    if (!valid || !/^\d{1,20}$/.test(String(cursor)) || BigInt(next) <= BigInt(cursor)) {
      throw fail('MCP_CURSOR_INVALID', '分页游标精度丢失、缺失或未严格递增');
    }
  } else if (typeof next !== 'string' || next <= String(cursor)) {
    throw fail('MCP_CURSOR_INVALID', '字符串分页游标未严格递增');
  }
  return String(next);
}

async function queryItems(invoke, config, input, context, check) {
  const paging = paginationOf(config.pagination);
  if (config.forEach && !Array.isArray(input)) {
    throw fail('INVALID_ARGUMENT', 'forEach需要数组输入');
  }
  const items = config.forEach ? input : [input];
  const combined = [];
  let pages = 0;
  let totalBytes = 0;
  const append = value => {
    totalBytes += Buffer.byteLength(JSON.stringify(value));
    if (totalBytes > 4194304) {
      throw fail('MCP_RESULT_LIMIT', '累计MCP结果超过4MiB，未返回不完整结果');
    }
    combined.push(value);
  };
  for (const item of items) {
    let cursor = paging?.initial ?? '0';
    for (let page = 0; ; page++) {
      check();
      if (paging && page >= paging.maxPages) {
        throw fail('MCP_PAGE_LIMIT', '达到配置分页上限，无法证明结果完整');
      }
      const variables = { ...context.variables, input: item, cursor };
      const bindings = resolveMapping(config.bindings || {}, variables);
      if (paging) {
        bindings.cursor = { type: paging.cursorType, value: cursor };
      }
      const args = Object.fromEntries(Object.entries(config.arguments || {}).map(([key, value]) => [key,
        key === 'sql' && typeof value === 'string' ? bindSql(value, bindings) : resolveMapping(value, variables)]));
      const data = await invoke({ name: config.tool, arguments: args });
      pages++;
      check();
      const result = config.resultPath ? readPath(data, config.resultPath) : data;
      if (result === undefined) {
        throw fail('MCP_RESULT_INVALID', '配置的resultPath不存在');
      }
      if (!paging) {
        if (readPath(data, config.truncatedPath || 'truncated') === true) {
          throw fail('MCP_RESULT_TRUNCATED', 'MCP结果被截断，请配置分页，不能发布部分结果');
        }
        if (!config.forEach) {
          return { value: result, pages };
        }
        if (config.includeInput) {
          append({ input: item, value: result });
        } else {
          for (const row of Array.isArray(result) ? result : [result]) {
            append(row);
          }
        }
        break;
      }
      if (!Array.isArray(result) || result.length > paging.pageSize) {
        throw fail('MCP_RESULT_INVALID', '分页结果必须为数组且不超过pageSize');
      }
      const truncated = readPath(data, config.truncatedPath || 'truncated');
      if (truncated !== undefined && typeof truncated !== 'boolean') {
        throw fail('MCP_RESULT_INVALID', 'truncated字段必须为布尔值');
      }
      if (!result.length && truncated) {
        throw fail('MCP_RESULT_INVALID', '结果截断且无可用游标');
      }
      for (const row of result) {
        cursor = advanceCursor(row, cursor, paging);
        append(config.includeInput ? { input: item, value: row } : row);
      }
      if (result.length < paging.pageSize && !truncated) {
        break;
      }
    }
  }
  return { value: combined, pages };
}

export async function callConfiguredMcp(tasks, config, input, context) {
  if (typeof config.tool !== 'string' || !config.tool.trim()) {
    throw fail('INVALID_ARGUMENT', 'MCP配置需要tool名称');
  }
  const controller = new AbortController();
  const deadline = Date.now() + context.timeoutSeconds * 1000;
  const check = () => {
    if (context.shouldStop() || Date.now() >= deadline) {
      controller.abort(fail('MCP_STOPPED', 'MCP节点已取消或超时'));
    }
    controller.signal.throwIfAborted();
  };
  const timer = setInterval(() => {
    if (context.shouldStop() || Date.now() >= deadline) {
      controller.abort(fail('MCP_STOPPED', 'MCP节点已取消或超时'));
    }
  }, 50);
  let lease;
  try {
    check();
    const { call, describe } = providersOf(await tasks.capabilities.discover(), config.serviceId);
    lease = await tasks.capabilities.authorize({ scopeKey: `configured:${context.nodeId}:${call.descriptor.source.serviceId}`,
      title: '自定义节点 · MCP工具调用', providers: [call.handle, describe.handle] });
    while (true) {
      check();
      const authorization = await tasks.capabilities.authorization(lease.id);
      if (authorization.state === 'granted') {
        break;
      }
      if (authorization.state !== 'pending') {
        throw fail('MCP_AUTHORIZATION_DENIED', 'MCP授权被拒绝或已失效');
      }
      await delay(150, undefined, { signal: controller.signal });
    }
    const options = { providerId: call.handle.pluginId, authorizationId: lease.id, signal: controller.signal };
    const description = await tasks.call(describe.descriptor.id, {}, options);
    if (!description.tools?.some(tool => tool.name === config.tool)) {
      throw fail('MCP_TOOL_MISSING', '所选服务不存在配置的工具');
    }
    return await queryItems(async payload => toolData(await tasks.call(call.descriptor.id, payload, options)), config, input, context, check);
  } finally {
    clearInterval(timer);
    if (lease) {
      await tasks.capabilities.revoke(lease.id);
    }
  }
}

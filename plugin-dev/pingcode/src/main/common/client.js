import { selectedRole, roleMember, memberId } from '../../shared/roles.js';
import { filterTasks } from '../../shared/month-filter.js';

const failure = (code, message) => Object.assign(Error(message), { code });

export function validateConfig(config) {
  for (const field of ['apiRoot', 'site']) {
    let url;
    try {
      url = new URL(config[field]);
    } catch {
      throw failure('INVALID_CONFIG', '请输入有效的 HTTPS 地址');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (field === 'site' && url.pathname !== '/')) {
      throw failure('INVALID_CONFIG', '地址必须为 HTTPS，且不能包含账号、密码、查询参数或片段');
    }
  }
  if (!['web', 'token', 'client'].includes(config.authMode) || !/^[a-zA-Z0-9_]{1,128}$/.test(config.valueKey)) {
    throw failure('INVALID_CONFIG', '授权模式或价值分字段键无效');
  }
  return config;
}

export function expirationTime(value, now = Date.now()) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return now;
  }
  return seconds > 1000000000 ? seconds * 1000 : now + seconds * 1000;
}

function statusError(status) {
  const errors = {
    401: ['UNAUTHORIZED', '授权无效或已过期，请检查连接配置'],
    403: ['FORBIDDEN', 'OpenAPI 无权访问，请检查应用数据范围和成员权限'],
    429: ['RATE_LIMITED', 'OpenAPI 请求过于频繁，请稍后重试']
  };
  const [code, message] = errors[status] || ['API_FAILED', `OpenAPI 请求失败（HTTP ${status}）`];
  return failure(code, message);
}

export class PingCodeClient {
  constructor(config, { fetch = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.config = { ...validateConfig(config) };
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.token = null;
  }

  async http(path, params, token, signal) {
    if (signal?.aborted) {
      throw failure('CANCELLED', '查询已取消');
    }
    const url = new URL(`${this.config.apiRoot.replace(/\/+$/, '')}${path}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const result = await this.fetch(url, { method: 'GET', redirect: 'error', signal: combined,
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      if (!result.ok) {
        throw statusError(result.status);
      }
      try {
        return await result.json();
      } catch (error) {
        if (combined.aborted) {
          throw error;
        }
        throw failure('INVALID_RESPONSE', 'OpenAPI 返回了无效的数据');
      }
    } catch (error) {
      if (signal?.aborted) {
        throw failure('CANCELLED', '查询已取消');
      }
      if (timeout.aborted) {
        throw failure('TIMEOUT', 'OpenAPI 请求超时，请稍后重试');
      }
      if (['UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED', 'API_FAILED', 'INVALID_RESPONSE'].includes(error.code)) {
        throw error;
      }
      // Fetch errors can contain full credential-bearing URLs; never forward the original message or cause.
      throw failure('NETWORK_FAILED', '无法连接 OpenAPI，请检查地址与网络');
    }
  }

  async authorization(signal, renew = false) {
    const config = this.config;
    if (config.authMode === 'token') {
      if (!config.accessToken) {
        throw failure('NOT_CONFIGURED', '请先在插件配置中填写访问令牌');
      }
      return config.accessToken;
    }
    if (!config.clientId || !config.clientSecret) {
      throw failure('NOT_CONFIGURED', '请先在插件配置中填写 Client ID 和 Client Secret');
    }
    if (!renew && this.token?.expires > Date.now() + 60000) {
      return this.token.value;
    }
    const result = await this.http('/v2/auth/token', { grant_type: 'client_credentials',
      client_id: config.clientId, client_secret: config.clientSecret }, null, signal);
    if (typeof result.access_token !== 'string' || !result.access_token) {
      throw failure('INVALID_RESPONSE', 'OpenAPI 未返回有效的访问令牌');
    }
    this.token = { value: result.access_token, expires: expirationTime(result.expires_in) };
    return this.token.value;
  }

  async request(path, params, signal) {
    const token = await this.authorization(signal);
    try {
      return await this.http(path, params, token, signal);
    } catch (error) {
      if (error.code !== 'UNAUTHORIZED' || this.config.authMode !== 'client') {
        throw error;
      }
      return this.http(path, params, await this.authorization(signal, true), signal);
    }
  }

  async pages(path, params, signal, onProgress = () => {}) {
    const rows = new Map();
    let page = 0;
    for (;;) {
      const result = await this.request(path, { ...params, page_size: 100, page_index: page }, signal);
      if (!Array.isArray(result.values) || !Number.isSafeInteger(result.total) || result.total < 0) {
        throw failure('INVALID_RESPONSE', 'OpenAPI 分页响应无效');
      }
      const before = rows.size;
      for (const row of result.values) {
        if (typeof row?.id !== 'string' || !row.id) {
          throw failure('INVALID_RESPONSE', 'OpenAPI 分页数据缺少资源 ID');
        }
        rows.set(row.id, row);
      }
      onProgress({ loaded: rows.size, total: result.total });
      if (rows.size >= result.total) {
        return [...rows.values()];
      }
      if (!result.values.length || before === rows.size) {
        throw failure('INCOMPLETE_PAGE', 'OpenAPI 分页未完整返回，本次结果不可统计');
      }
      page++;
    }
  }

  async members(keywords, signal) {
    const values = await this.pages('/v2/directory/users', { keywords }, signal);
    return values.map(row => ({ id: row.id, name: row.display_name || row.name || row.id, username: row.name || row.id }));
  }

  async projects(signal) {
    const values = await this.pages('/v2/pjm/projects', {}, signal);
    return values.map(row => ({ id: row.id, name: row.name, identifier: row.identifier }));
  }

  async tasks({ assigneeId, projectId = '', role: roleId, month = '', dateField = 'completedAt', onProgress }, signal) {
    const role = selectedRole(roleId);
    if (!assigneeId) {
      throw failure('INVALID_ARGUMENT', '请先选择负责人');
    }
    const values = await this.pages('/v2/pjm/workitems', { assignee_id: role.key ? undefined : assigneeId, project_id: projectId,
      include_deleted: false, include_archived: false }, signal, onProgress);
    const result = values.filter(row => !role.key || memberId(roleMember(row, role)) === assigneeId)
      .map(row => ({ id: row.id, number: row.whole_identifier || String(row.identifier || ''),
      title: row.title || '', project: row.project?.name || '',
      assignee: roleMember(row, role)?.display_name || roleMember(row, role)?.name || memberId(roleMember(row, role)) || '',
      stateId: row.state?.id || '', state: row.state?.name || '未设置', score: row.properties?.[this.config.valueKey] ?? null,
      createdAt: row.created_at ?? null, completedAt: row.completed_at ?? null,
      url: row.short_id ? `${new URL(this.config.site).origin}/pjm/workitems/${encodeURIComponent(row.short_id)}` : '' }));
    return filterTasks(result, { month, dateField });
  }
}

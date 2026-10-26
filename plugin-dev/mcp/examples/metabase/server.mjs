import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const invalid = message => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
const sensitive = /password|passwd|pwd|secret|token|credential|authorization|cookie|api.?key|access.?key|private.?key|phone|mobile|email|cpf|身份证/i;
const functions = new Set(('count sum min max avg coalesce ifnull nullif concat concat_ws lower upper trim ltrim rtrim length '
  + 'char_length substring substr left right replace round floor ceil ceiling abs date date_format datediff timestampdiff '
  + 'year month day hour minute second now current_date current_timestamp unix_timestamp from_unixtime cast convert '
  + 'json_extract json_unquote json_length if greatest least '
  + 'in exists over partition as from where having and or not on join using when then else by distinct select').split(' '));

// Credentials and the HTTPS target remain operator configuration; database metadata is discovered separately.
export function configuration(env = process.env) {
  const url = new URL(env.METABASE_URL || 'https://bi.dbaifin.com');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !env.METABASE_SESSION?.trim()) {
    throw invalid('请配置 HTTPS Metabase 地址和有效的 METABASE_SESSION');
  }
  url.pathname = url.pathname.replace(/\/$/, '') + '/api/dataset';
  return { url, session: env.METABASE_SESSION.trim() };
}

// Conservative SQL subset: reject ambiguous syntax instead of trying to parse every database dialect.
export function queryParameters(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['sql', 'limit', 'database'].includes(key))) {
    throw invalid('仅接受 sql、limit 和 database 参数');
  }
  if (input.database !== undefined && !(typeof input.database === 'string' && input.database.trim()
    && input.database.length <= 256) && !(Number.isSafeInteger(input.database) && input.database > 0)) {
    throw invalid('database 应为可访问数据库的完整名称或正整数 ID');
  }
  const requested = input.limit ?? 20;
  if (typeof input.sql !== 'string' || !input.sql.trim() || input.sql.length > 16_384
    || !Number.isInteger(requested) || requested < 1 || requested > 100 || /[\\\u0000]/.test(input.sql)) {
    throw invalid('需要单条 SELECT，sql 最长 16384 字符，limit 为 1..100；不支持反斜线转义');
  }
  let sql = input.sql.trim().replace(/;$/, '').trim();
  const tokens = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`/g, value => {
    if (value[0] === "'") { return ' '; }
    const identifier = value.slice(1, -1);
    if (!/^[a-zA-Z_][\w$]*$/.test(identifier)) { throw invalid('带引号的标识符只支持字母、数字、下划线'); }
    return identifier;
  });
  if (!/^select\b/i.test(tokens) || /['"`;@#$]|--|\/\*|\*\/|\b(?:insert|update|delete|replace|create|alter|drop|truncate|grant|revoke|call|execute|exec|copy|into|for|lock|unlock|set|use|outfile|dumpfile|procedure)\b/i.test(tokens)) {
    throw invalid('仅允许单条 SELECT，不支持注释、写入、锁定、变量或多条语句');
  }
  for (const match of tokens.matchAll(/(?:\b([a-z_]\w*)\s*\.\s*)?\b([a-z_]\w*)\s*\(/gi)) {
    if (match[1] || !functions.has(match[2].toLowerCase())) {
      throw invalid('不支持该 SQL 函数，请使用常见聚合、日期、字符串函数及普通 SELECT');
    }
  }
  const limits = [...tokens.matchAll(/\blimit\b/gi)];
  const ending = tokens.match(/\blimit\s+(\d+)\s*$/i);
  if (limits.length && (limits.length !== 1 || !ending || Number(ending[1]) < 1 || Number(ending[1]) > 100)) {
    throw invalid('显式 LIMIT 必须位于末尾且在 1..100；不支持嵌套 LIMIT 或 OFFSET');
  }
  const limit = Math.min(requested, ending ? Number(ending[1]) : requested);
  sql = ending ? sql.replace(/\blimit\s+\d+\s*$/i, `LIMIT ${limit}`) : `${sql} LIMIT ${limit}`;
  return { sql, limit };
}

function redact(value, secret) {
  if (typeof value === 'string') {
    const text = value.split(secret).join('[REDACTED]');
    // Configuration columns often contain serialized JSON rather than individual credential columns.
    if (/^\s*[\[{]/.test(text)) {
      try { return JSON.stringify(redact(JSON.parse(text), secret)); }
      catch { /* Non-JSON text still receives inline credential redaction below. */ }
    }
    return text.replace(/((?:password|secret|token|authorization|api[_-]?key|access[_-]?key)[\w-]*[\s"']*[:=][\s"']*)(?:Bearer\s+)?[^\s,"'}\]&]+/gi,
      '$1[REDACTED]');
  }
  if (Array.isArray(value)) { return value.map(item => redact(item, secret)); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, sensitive.test(key) ? '[REDACTED]' : redact(item, secret)]));
  }
  return value;
}

const messages = {
  AUTH_EXPIRED: 'Metabase 登录已失效，请更新本机 METABASE_SESSION 后重新启用服务。',
  ACCESS_DENIED: '当前 Metabase 账号没有该数据库的查询权限。',
  UPSTREAM_ERROR: 'Metabase 服务请求失败，请检查服务状态。',
  QUERY_FAILED: '查询执行失败，请检查表名、字段、SQL 语法和数据库权限。',
  INVALID_RESPONSE: 'Metabase 返回了无法识别的结果。',
  RESPONSE_TOO_LARGE: '上游响应超过 1 MiB，请减少字段或收紧查询条件。',
  RESULT_TOO_LARGE: '查询结果超过 256 KiB，请减少字段、行数或收紧条件。',
  TIMEOUT: '查询超过 15 秒，请缩小范围。停止等待不保证数据库端已取消执行。',
  CONNECTION_ERROR: '连接 Metabase 失败，请检查网络和 HTTPS 证书。',
  BUSY: '该服务正在执行请求，请等待完成后再试。',
  DATABASE_REQUIRED: '存在多个数据库，请先调用 metabase_databases，根据排障场景选择数据库名称并传入 database。',
  DATABASE_NOT_FOUND: '未找到该数据库，请调用 metabase_databases 刷新列表后选择。',
  DATABASE_AMBIGUOUS: '存在同名数据库，请使用 metabase_databases 返回的 ID。',
  NO_DATABASES: '当前账号没有可访问的数据库，请检查 Metabase 权限。'
};

async function responseJson(response) {
  if (!response.body) { throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' }); }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw Object.assign(new Error(), { code: 'RESPONSE_TOO_LARGE' });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' }); }
}

export class MetabaseClient {
  constructor(config, { fetch: request = globalThis.fetch, timeoutMs = 15_000, now = Date.now } = {}) {
    this.config = config;
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.controller = null;
    this.now = now;
    this.databaseCache = null;
  }
  close() { this.controller?.abort(); }

  // Only cache public catalog metadata in memory, never connection details or query results.
  async catalog(signal, refresh = false) {
    if (refresh || (this.databaseCache && this.now() >= this.databaseCache.expires)) { this.databaseCache = null; }
    if (this.databaseCache) { return { databases: this.databaseCache.databases, cached: true }; }
    const body = await this.requestJson(new URL('database', this.config.url), { method: 'GET', signal });
    const entries = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(entries) || entries.some(entry => !Number.isSafeInteger(entry?.id) || entry.id < 1
      || typeof entry.name !== 'string' || !entry.name.trim())) {
      throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
    }
    const databases = entries.map(({ id, name, engine }) => ({ id, name: redact(name, this.config.session),
      ...(typeof engine === 'string' ? { engine: redact(engine, this.config.session) } : {}) }));
    this.databaseCache = { databases, expires: this.now() + 300_000 };
    return { databases, cached: false };
  }

  async requestJson(url, options) {
    const response = await this.request(url, { ...options, redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Metabase-Session': this.config.session } });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) { this.databaseCache = null; }
      throw Object.assign(new Error(), {
        code: response.status === 401 ? 'AUTH_EXPIRED' : response.status === 403 ? 'ACCESS_DENIED' : 'UPSTREAM_ERROR'
      });
    }
    return responseJson(response);
  }

  databases(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => key !== 'refresh')
      || (input.refresh !== undefined && typeof input.refresh !== 'boolean')) {
      throw invalid('仅接受布尔参数 refresh');
    }
    return this.perform({}, async (_metadata, signal) => ({ status: 'ok', ...await this.catalog(signal, input.refresh) }));
  }

  // A query and its catalog lookup share one deadline; failed requests are never retried implicitly.
  async perform(metadata, action) {
    const started = Date.now();
    metadata.request_id = randomUUID();
    const failure = error_code => ({ ...metadata, status: 'error', error_code, message: messages[error_code],
      elapsed_ms: Date.now() - started });
    if (this.controller) { return failure('BUSY'); }
    const controller = new AbortController();
    this.controller = controller;
    // Stay below the host's 18-second tool deadline; never retry a production query implicitly.
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return { ...await action(metadata, controller.signal), ...metadata, elapsed_ms: Date.now() - started };
    } catch (error) {
      return failure(controller.signal.aborted ? 'TIMEOUT' : Object.hasOwn(messages, error.code) ? error.code : 'CONNECTION_ERROR');
    } finally {
      clearTimeout(timeout);
      this.controller = null;
    }
  }

  async query(input) {
    const { sql, limit } = queryParameters(input);
    return this.perform({ limit }, async (metadata, signal) => {
      const { databases } = await this.catalog(signal);
      if (!databases.length) { throw Object.assign(new Error(), { code: 'NO_DATABASES' }); }
      if (input.database === undefined && databases.length > 1) {
        throw Object.assign(new Error(), { code: 'DATABASE_REQUIRED' });
      }
      const matches = input.database === undefined ? databases : databases.filter(database =>
        typeof input.database === 'number' ? database.id === input.database : database.name === input.database);
      if (matches.length !== 1) {
        throw Object.assign(new Error(), { code: matches.length ? 'DATABASE_AMBIGUOUS' : 'DATABASE_NOT_FOUND' });
      }
      metadata.database = matches[0].id;
      const body = await this.requestJson(this.config.url, { method: 'POST', signal,
        body: JSON.stringify({ type: 'native', database: metadata.database,
          native: { query: sql, 'template-tags': {} }, parameters: [],
          constraints: { 'max-results': limit, 'max-results-bare-rows': limit } }) });
      const failure = code => { throw Object.assign(new Error(), { code }); };
      if (body.status === 'failed' || body.error) { return failure('QUERY_FAILED'); }
      const { rows, cols, rows_truncated: truncated } = body.data || {};
      if (body.status !== 'completed' || !Array.isArray(rows) || !Array.isArray(cols)
        || cols.some(column => typeof column?.name !== 'string')
        || rows.some(row => !Array.isArray(row) || row.length !== cols.length)) { return failure('INVALID_RESPONSE'); }
      const result = { ...metadata, status: 'ok',
        columns: cols.map(column => ({ name: redact(column.name, this.config.session),
          type: typeof column.base_type === 'string' ? redact(column.base_type, this.config.session) : undefined })),
        rows: rows.slice(0, limit).map(row => row.map((value, index) =>
          sensitive.test(cols[index].name) ? '[REDACTED]' : redact(value, this.config.session))),
        row_count: Math.min(rows.length, limit), truncated: Boolean(truncated) || rows.length >= limit };
      return Buffer.byteLength(JSON.stringify(result)) > 256 * 1024 ? failure('RESULT_TOO_LARGE') : result;
    });
  }
}

export const queryTool = {
  name: 'metabase_query',
  description: '通过 Metabase 只读查询线上数据库；自动发现数据库并缓存5分钟。多个数据库时先调用 metabase_databases，按业务场景选择完整库名传入 database。仅单条 SELECT；默认最多20行，上限100行，15秒超时。'
    + '优先指定字段并按订单ID、用户ID、国家和时间范围过滤；勿全表扫描。支持 information_schema 的 SELECT 查询表结构。'
    + '不支持注释、CTE、OFFSET、自定义函数、写入或锁定；截断时缩小查询条件，不能当作完整结果。敏感字段按列名脱敏。',
  inputSchema: { type: 'object', properties: { sql: { type: 'string', maxLength: 16384, description: '单条 SELECT SQL' },
    database: { anyOf: [{ type: 'string', minLength: 1, maxLength: 256 }, { type: 'integer', minimum: 1 }],
      description: 'metabase_databases 返回的完整数据库名称或 ID；仅有一个数据库时可省略' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, required: ['sql'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
};

export const databasesTool = {
  name: 'metabase_databases',
  description: '自动发现当前账号可访问的数据库，仅返回 ID、名称和引擎。缓存5分钟；refresh=true 强制刷新。根据业务场景选择库名用于 metabase_query。',
  inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', default: false } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
};

export function serve(client, input = process.stdin, output = process.stdout) {
  let pending = '';
  const send = value => output.write(JSON.stringify(value) + '\n');
  async function handle(line) {
    let request;
    try { request = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
      return;
    }
    if (request.id === undefined) { return; }
    const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
    const error = (code, message) => send({ jsonrpc: '2.0', id: request.id, error: { code, message } });
    if (request.method === 'initialize') {
      reply({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(request.params?.protocolVersion)
        ? request.params.protocolVersion : '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'metabase-readonly', version: '1.1.0' } });
      return;
    }
    if (request.method === 'ping') { reply({}); return; }
    if (request.method === 'tools/list') { reply({ tools: [queryTool, databasesTool] }); return; }
    if (request.method !== 'tools/call') { error(-32601, 'Method not found'); return; }
    const tool = [queryTool, databasesTool].find(tool => tool.name === request.params?.name);
    if (!tool) { error(-32602, 'Unknown tool'); return; }
    try {
      const result = await (tool === queryTool ? client.query(request.params.arguments) : client.databases(request.params.arguments));
      process.stderr.write(`[${result.status === 'ok' ? 'info' : 'error'}] service=metabase tool=${tool.name} database=${result.database ?? '-'}`
        + ` request_id=${result.request_id} status=${result.status} code=${result.error_code || 'OK'} elapsed_ms=${result.elapsed_ms}\n`);
      reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.status !== 'ok' });
    } catch (cause) {
      process.stderr.write(`[error] service=metabase tool=${tool.name} code=INVALID_ARGUMENT\n`);
      reply({ content: [{ type: 'text', text: cause.code === 'INVALID_ARGUMENT' ? cause.message : '查询失败' }], isError: true });
    }
  }
  input.setEncoding('utf8');
  input.on('data', chunk => {
    pending += chunk;
    if (Buffer.byteLength(pending) > 1024 * 1024) {
      process.stderr.write('[error] service=metabase code=INPUT_TOO_LARGE\n');
      input.destroy();
      client.close();
      return;
    }
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (line) { void handle(line); }
    }
  });
  input.on('end', () => client.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const client = new MetabaseClient(configuration());
    serve(client);
    for (const signal of ['SIGTERM', 'SIGINT']) { process.on(signal, () => { client.close(); process.exit(0); }); }
  } catch {
    process.stderr.write('[error] service=metabase code=CONFIG_INVALID 配置地址和METABASE_SESSION后启动\n');
    process.exitCode = 1;
  }
}

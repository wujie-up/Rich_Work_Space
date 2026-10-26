import https from 'node:https';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const privateKey = /access.?key|secret|token|authorization|password|pwd|verifyCode|phone|mobile|cpf|身份证/i;
const inlinePrivate = /((?:accessKey(?:Id|Secret)?|secret|token|authorization|password|pwd|verifyCode|phone|mobile|cpf)[\w-]*[\s"']*[:=][\s"']*)(\[REDACTED\]|[^\s,"'}\]&]+)/gi;
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });

// Defaults are optional; every query still requires an explicit or configured target.
export function configuration(env = process.env) {
  const endpoint = (env.SLS_ENDPOINT || '').replace(/^https:\/\//, '').replace('-intranet.log.', '.log.').replace(/\/$/, '');
  if (!/^[a-z0-9-]+\.log\.aliyuncs\.com$/.test(endpoint) || (env.SLS_PROJECT !== undefined && !/^[a-z0-9_-]+$/.test(env.SLS_PROJECT))
    || (env.SLS_LOGSTORE !== undefined && !/^[a-zA-Z0-9_-]+$/.test(env.SLS_LOGSTORE))) {
    throw invalid('请配置有效的 SLS 区域地址、Project 和 Logstore');
  }
  if (!env.ALIBABA_CLOUD_ACCESS_KEY_ID || !env.ALIBABA_CLOUD_ACCESS_KEY_SECRET) {
    throw invalid('请配置阿里云 AccessKey ID 和 Secret');
  }
  return { endpoint, project: env.SLS_PROJECT, logstore: env.SLS_LOGSTORE,
    accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID, accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    securityToken: env.ALIBABA_CLOUD_SECURITY_TOKEN || '' };
}

function epoch(value) {
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number >= 100_000_000_000) { throw invalid('时间戳必须是秒'); }
    return number;
  }
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw invalid('ISO 时间必须包含时区');
  }
  return Math.floor(Date.parse(value) / 1000);
}

export function queryParameters(input) {
  const end = input.to === undefined ? Math.floor(Date.now() / 1000) : epoch(input.to);
  const minutes = input.minutes ?? 15;
  const start = input.from === undefined ? end - minutes * 60 : epoch(input.from);
  const lines = input.lines ?? 20;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(minutes) || minutes <= 0 || start < 0 || start >= end
    || !Number.isInteger(lines) || lines < 1 || lines > 100 || !Number.isInteger(offset) || offset < 0) {
    throw invalid('要求有效时间范围、正整数 minutes、lines 在 1..100、offset >= 0');
  }
  if (offset && (input.from === undefined || input.to === undefined)) { throw invalid('分页必须指定首条结果的 from/to'); }
  if (('term' in input) === ('query' in input)) { throw invalid('term 和 query 必须二选一'); }
  const text = input.term ?? input.query;
  if (typeof text !== 'string' || !text.trim()) { throw invalid('查询条件不能为空'); }
  // Literal pipes are allowed in term searches; SQL mode must explicitly bound returned rows.
  if ('query' in input && /\|/.test(text)) {
    // A bounded single SQL statement avoids mistaking comments or a later statement for the effective LIMIT.
    if (/--|\/\*|\*\/|;\s*\S/.test(text)) { throw invalid('SQL 不支持注释或多条语句'); }
    const limit = text.match(/\blimit\s+(\d+)\s*;?\s*$/i);
    if (!limit || Number(limit[1]) < 1 || Number(limit[1]) > 100) { throw invalid('SQL 必须以 LIMIT 1..100 结尾'); }
    if (offset) { throw invalid('SQL 查询不支持 offset，请缩小时间范围'); }
  }
  return { type: 'log', from: String(start), to: String(end), topic: '', query: 'term' in input ? JSON.stringify(text) : text,
    line: String(lines), offset: String(offset), reverse: 'true' };
}

export function signedHeaders(config, resource, params, date = new Date().toUTCString()) {
  const headers = { 'x-log-apiversion': '0.6.0', 'x-log-signaturemethod': 'hmac-sha1', Date: date };
  if (config.securityToken) { headers['x-acs-security-token'] = config.securityToken; }
  const canonicalHeaders = Object.keys(headers).sort().filter(key => key.startsWith('x-')).map(key => `${key}:${headers[key]}\n`).join('');
  const canonicalResource = resource + '?' + Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
  const message = `GET\n\n\n${date}\n${canonicalHeaders}${canonicalResource}`;
  headers.Authorization = `LOG ${config.accessKeyId}:${createHmac('sha1', config.accessKeySecret).update(message).digest('base64')}`;
  headers['Accept-Encoding'] = 'identity';
  return headers;
}

export function redact(value, secrets = []) {
  if (Array.isArray(value)) { return value.map(item => redact(item, secrets)); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privateKey.test(key) ? '[REDACTED]' : redact(item, secrets)]));
  }
  if (typeof value === 'string') {
    for (const secret of secrets.filter(Boolean)) { value = value.split(secret).join('[REDACTED]'); }
    return value.replace(/(authorization[\s"']*[:=][\s"']*)(?:Bearer|Basic|LOG)\s+[^\s,"'}\]&]+/gi, '$1[REDACTED]')
      .replace(inlinePrivate, '$1[REDACTED]');
  }
  return value;
}

export class SlsClient {
  constructor(config, connection = {}) {
    this.config = config;
    this.connection = { ...connection };
    if (connection.host) { this.connection.hostname = connection.host; }
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
    this.queries = 0;
  }

  close() { this.agent.destroy(); }

  // Bound response memory and never pass upstream error bodies or signed headers back to the agent.
  request(resource, params, project) {
    return new Promise((resolve, reject) => {
      const req = https.get({ hostname: `${project}.${this.config.endpoint}`, ...this.connection, path: resource + '?' + new URLSearchParams(params), agent: this.agent,
        headers: signedHeaders(this.config, resource, params) }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) { res.destroy(new Error('ResponseTooLarge')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), reused: req.reusedSocket }));
      });
      req.setTimeout(60000, () => req.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
    });
  }

  async query(input) {
    const params = queryParameters(input);
    const project = input.project === undefined ? this.config.project : input.project;
    const logstore = input.logstore === undefined ? this.config.logstore : input.logstore;
    if (typeof project !== 'string' || !/^[a-z0-9_-]+$/.test(project)) { throw invalid('请指定有效 Project'); }
    if (typeof logstore !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(logstore)) { throw invalid('无效 Logstore'); }
    const started = Date.now();
    let response;
    let attempts = 0;
    // Retry only incomplete results, preserving the exact first query time range and pagination.
    do {
      attempts++;
      try { response = await this.request(`/logstores/${logstore}`, params, project); }
      catch (error) {
        if (!['ECONNRESET', 'EPIPE'].includes(error.code)) { throw error; }
        response = await this.request(`/logstores/${logstore}`, params, project);
      }
      this.queries++;
    } while (response.status === 200 && response.headers['x-log-progress'] === 'Incomplete' && attempts < 3);
    const secrets = [this.config.accessKeyId, this.config.accessKeySecret, this.config.securityToken];
    const metadata = { project, logstore, endpoint: this.config.endpoint,
      from: params.from, to: params.to, offset: Number(params.offset), limit: Number(params.line),
      request_id: response.headers['x-log-requestid'], elapsed_ms: Date.now() - started, attempts };
    if (response.status !== 200) {
      let code = 'NON_JSON_RESPONSE';
      try { code = String(JSON.parse(response.body).errorCode || 'UNKNOWN'); } catch {}
      return { status: 'error', ...metadata, http_status: response.status, error_code: redact(code, secrets) };
    }
    return { status: 'ok', ...metadata, query: redact(params.query, secrets), progress: response.headers['x-log-progress'] || 'Unknown',
      count: response.headers['x-log-count'], connection_reused: response.reused, logs: redact(JSON.parse(response.body), secrets) };
  }
}

export const queryTool = { name: 'sls_query', description: '只读查询阿里云 SLS 日志。term 字面搜索或 query SLS 语句二选一；SQL 必须包含 LIMIT。默认最近15分钟；搜索默认20行，上限100行。SQL的LIMIT必须为1..100，不支持注释、多条语句或SQL分页；搜索分页复用 from/to；Incomplete/Unknown 不能视为完整。输出已作常见敏感字段脱敏，仍需核查后展示。',
  inputSchema: { type: 'object', properties: {
    term: { type: 'string' }, query: { type: 'string' }, minutes: { type: 'integer', minimum: 1, default: 15 },
    from: { type: ['string', 'integer'], description: 'Unix秒或带时区ISO时间' }, to: { type: ['string', 'integer'] },
    lines: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, offset: { type: 'integer', minimum: 0 },
    project: { type: 'string', description: '查询目标 Project；省略时使用服务默认值。支持当前区域内凭据有权访问的项目' },
    logstore: { type: 'string', description: '查询目标 Logstore；省略时使用服务默认值' }
  }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } };

// A single-file stdio deployment needs no npm install; stdout is reserved for MCP JSON-RPC.
export function serve(client, input = process.stdin, output = process.stdout) {
  let pending = '';
  const send = value => output.write(JSON.stringify(value) + '\n');
  async function handle(line) {
    let message;
    try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); return;
    }
    if (message.id === undefined) { return; }
    const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      reply({ protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sls-readonly', version: '1.1.0' } }); return;
    }
    if (message.method === 'ping') { reply({}); return; }
    if (message.method === 'tools/list') { reply({ tools: [queryTool] }); return; }
    if (message.method !== 'tools/call') { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
    try {
      if (message.params?.name !== 'sls_query') { throw invalid('未知工具'); }
      const result = await client.query(message.params.arguments || {});
      process.stderr.write(`[info] service=sls-readonly tool=sls_query status=${result.status} project=${result.project} logstore=${result.logstore} request_id=${result.request_id || '-'}\n`);
      reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.status !== 'ok' });
    } catch (error) {
      process.stderr.write('[error] service=sls-readonly tool=sls_query failed\n');
      reply({ isError: true, content: [{ type: 'text', text: error.code === 'INVALID_ARGUMENT' ? error.message : 'SLS 请求失败，请检查配置、网络、TLS 和查询范围；敏感错误详情已隐藏。' }] });
    }
  }
  input.setEncoding('utf8');
  input.on('data', chunk => {
    pending += chunk;
    if (Buffer.byteLength(pending) > 1024 * 1024) { process.stderr.write('[error] service=sls-readonly input_too_large\n'); input.destroy(); client.close(); return; }
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) { void handle(line); }
    }
  });
  input.on('end', () => client.close());
  for (const signal of ['SIGTERM', 'SIGINT']) { process.once(signal, () => { client.close(); process.exit(0); }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { serve(new SlsClient(configuration())); }
  catch { process.stderr.write('[error] service=sls-readonly configuration_invalid\n'); process.exitCode = 1; }
}

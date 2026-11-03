import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const invalid = message => Object.assign(Error(message), { code: 'INVALID_ARGUMENT' });
const failure = code => Object.assign(Error(code), { code });
const messages = {
  AUTH_REQUIRED: 'Jenkins 认证失败，请检查配置的账号和密码。',
  ACCESS_DENIED: 'Jenkins 拒绝访问，请检查读取权限及该 Job 的构建权限。',
  JOB_NOT_FOUND: 'Job 不存在或当前账号不可见，请检查完整 Job 路径。',
  REQUEST_REJECTED: 'Jenkins 拒绝部署请求，请检查 Job 类型和部署参数。',
  JOB_NOT_BUILDABLE: '目标 Job 已停用或不支持直接构建，未提交部署。',
  JOB_BUSY: '目标 Job 已在排队或构建中，未重复提交部署。',
  INVALID_PARAMETERS: '部署参数名称、类型或选项不匹配，请检查 Jenkins Job 的实际参数。',
  PARAMETERS_REQUIRED: '部分部署参数没有默认值，请填写 missing_parameters 后再触发。',
  METADATA_FAILED: '无法读取完整有效的目标 Job 信息，未提交部署。',
  RECEIPT_NOT_FOUND: '队列记录或构建记录已不可用，不能据此判断部署结果。',
  IDENTITY_MISMATCH: '队列或构建信息与本次部署不匹配，不能据此判断部署结果。',
  STATUS_UNAVAILABLE: 'Jenkins 尚未提供可确认的构建结果。',
  CRUMB_FAILED: '无法获取有效的 Jenkins CSRF crumb，尚未提交部署。',
  CONNECTION_ERROR: '无法连接 Jenkins，尚未提交部署。',
  TIMEOUT: '连接 Jenkins 超时，尚未提交部署。',
  BUSY: '此服务正在提交另一项部署，本次请求未发送。',
  SUBMISSION_UNKNOWN: '部署请求可能已被 Jenkins 接收，但无法确认；请在 Jenkins 页面核实，勿自动重试。'
};

export function configuration(env = process.env) {
  let url;
  try {
    url = new URL(env.JENKINS_URL || 'http://192.168.3.21:8080/');
  } catch {
    throw invalid('JENKINS_URL 必须是 Jenkins HTTP/HTTPS 地址');
  }
  const username = env.JENKINS_USERNAME?.trim() || '';
  const password = env.JENKINS_PASSWORD || '';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !username || !password || /[:\u0000-\u001f\u007f]/.test(username) || /[\r\n\0]/.test(password)) {
    throw invalid('请配置 Jenkins HTTP/HTTPS 地址、JENKINS_USERNAME 和 JENKINS_PASSWORD；地址中不能包含凭据或查询参数');
  }
  // A view is a UI grouping, not a prefix of Jenkins job endpoints.
  url.pathname = url.pathname.replace(/\/view\/[^/]+\/?$/, '/').replace(/\/?$/, '/');
  return { url, username, password };
}

function deployment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['job', 'parameters'].includes(key))
    || typeof input.job !== 'string' || !input.job || input.job.length > 512
    || /[%?#\\:\u0000-\u001f\u007f]/.test(input.job)
    || input.job.split('/').some(part => !part.trim() || ['.', '..'].includes(part))) {
    throw invalid('job 须为真实 Job 路径，例如 folder/service；不接受 URL、空路径段或路径转义');
  }
  const parameterized = Object.hasOwn(input, 'parameters');
  const parameters = input.parameters;
  if (parameterized && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
    || Object.keys(parameters).length > 100 || Object.entries(parameters).some(([name, value]) =>
      !name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)
      || !['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))
      || (typeof value === 'string' && (value.length > 16384 || value.includes('\0')))))) {
    throw invalid('parameters 须为字符串、数字或布尔值的键值对象；最多 100 项，不支持文件或对象参数');
  }
  const body = new URLSearchParams(Object.entries(parameters || {}).map(([name, value]) => [name, String(value)])).toString();
  if (Buffer.byteLength(body) > 128 * 1024) {
    throw invalid('部署参数编码后不能超过 128 KiB');
  }
  return { path: input.job.split('/').map(part => `job/${encodeURIComponent(part)}`).join('/'), body };
}

async function responseJson(response, limit, code) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw failure(code);
  }
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw failure(code);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw error.code === code ? error : failure(code);
  } finally {
    reader.releaseLock();
  }
}

export class JenkinsClient {
  constructor(config, { timeoutMs = 15000, receiptTimeoutMs = 1000 } = {}) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.receiptTimeoutMs = receiptTimeoutMs;
    this.controller = null;
    this.queries = new Set();
  }

  close() {
    this.controller?.abort();
    for (const controller of this.queries) {
      controller.abort();
    }
  }

  headers() {
    return { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`)
      .toString('base64')}` };
  }

  async csrf(signal) {
    const response = await fetch(new URL('crumbIssuer/api/json', this.config.url), {
      headers: this.headers(), signal, redirect: 'manual'
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 404) {
        return {};
      }
      throw failure(response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : 'CRUMB_FAILED');
    }
    const body = await responseJson(response, 64 * 1024, 'CRUMB_FAILED');
    const name = body?.crumbRequestField;
    const value = body?.crumb;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)
      || /^(?:authorization|cookie|host|content-type|content-length|accept|connection|transfer-encoding)$/i.test(name)
      || typeof value !== 'string' || !value || value.length > 4096 || /[^\x21-\x7e]/.test(value)) {
      throw failure('CRUMB_FAILED');
    }
    const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]);
    return { [name]: value, ...(cookies.length ? { Cookie: cookies.join('; ') } : {}) };
  }

  queue(location) {
    if (!location) {
      return {};
    }
    try {
      const url = new URL(location, this.config.url);
      const prefix = `${this.config.url.pathname}queue/item/`;
      if (url.origin !== this.config.url.origin || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith(prefix) || !/^[1-9]\d*\/$/.test(url.pathname.slice(prefix.length))) {
        return {};
      }
      const queue_id = Number(url.pathname.slice(prefix.length, -1));
      return Number.isSafeInteger(queue_id) ? { queue_id, queue_url: url.href } : {};
    } catch {
      return {};
    }
  }

  async read(path, tree, signal, code = 'STATUS_UNAVAILABLE', limit = 64 * 1024) {
    const url = new URL(path, this.config.url);
    url.searchParams.set('tree', tree);
    const response = await fetch(url, { headers: this.headers(), signal, redirect: 'manual' });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw failure(response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED'
        : response.status === 404 ? code === 'METADATA_FAILED' ? 'JOB_NOT_FOUND' : 'RECEIPT_NOT_FOUND' : code);
    }
    return responseJson(response, limit, code);
  }

  async preflight(path, parameters, signal) {
    const job = await this.read(`${path}/api/json`,
      'buildable,inQueue,lastBuild[building],allBuilds[building],property[parameterDefinitions[name,type,choices,defaultParameterValue[value]]]',
      signal, 'METADATA_FAILED', 512 * 1024);
    if (!job || job.buildable !== true) {
      throw failure('JOB_NOT_BUILDABLE');
    }
    if (typeof job.inQueue !== 'boolean' || !Array.isArray(job.property) || !Array.isArray(job.allBuilds)
      || job.allBuilds.some(build => typeof build?.building !== 'boolean')
      || (job.lastBuild !== null && typeof job.lastBuild?.building !== 'boolean')) {
      throw failure('METADATA_FAILED');
    }
    if (job.inQueue || job.lastBuild?.building || job.allBuilds.some(build => build.building)) {
      throw failure('JOB_BUSY');
    }
    const definitions = job.property.flatMap(property => property?.parameterDefinitions || []);
    if (definitions.some(item => !item || typeof item.name !== 'string' || !item.name
      || typeof item.type !== 'string') || new Set(definitions.map(item => item.name)).size !== definitions.length) {
      throw failure('METADATA_FAILED');
    }
    const values = parameters || {};
    const names = new Set(definitions.map(item => item.name));
    if (Object.keys(values).some(name => !names.has(name))) {
      throw failure('INVALID_PARAMETERS');
    }
    const missing = [];
    for (const item of definitions) {
      const supplied = Object.hasOwn(values, item.name);
      if (!supplied && (!item.defaultParameterValue || !Object.hasOwn(item.defaultParameterValue, 'value')
        || item.defaultParameterValue.value === null)) {
        missing.push(item.name);
      }
      if (supplied && (/FileParameterDefinition/i.test(item.type)
        || (/BooleanParameterDefinition/i.test(item.type) && ![true, false, 'true', 'false'].includes(values[item.name]))
        || (Array.isArray(item.choices) && !item.choices.includes(String(values[item.name]))))) {
        throw failure('INVALID_PARAMETERS');
      }
    }
    if (missing.length) {
      throw Object.assign(failure('PARAMETERS_REQUIRED'), { missing_parameters: missing });
    }
    return definitions.length ? '/buildWithParameters' : '/build';
  }

  matchesJob(task, job, path) {
    if (task?.fullName) {
      return task.fullName === job;
    }
    try {
      return task?.url ? new URL(task.url).pathname === new URL(`${path}/`, this.config.url).pathname
        : !job.includes('/') && task?.name === job;
    } catch {
      return false;
    }
  }

  async receipt(queue, job, path, signal) {
    if (!queue.queue_id) {
      return {};
    }
    try {
      const receiptSignal = AbortSignal.any([signal, AbortSignal.timeout(this.receiptTimeoutMs)]);
      const item = await this.read(`queue/item/${queue.queue_id}/api/json`, 'id,task[name,fullName,url],executable[number]', receiptSignal);
      if (item?.id === queue.queue_id && this.matchesJob(item.task, job, path)
        && Number.isSafeInteger(item.executable?.number) && item.executable.number > 0) {
        return { build_number: item.executable.number,
          build_url: new URL(`${path}/${item.executable.number}/`, this.config.url).href };
      }
    } catch {
      // Acceptance is already confirmed. An optional receipt failure cannot undo or retry a deployment.
    }
    return {};
  }

  async deploy(input) {
    const { path, body } = deployment(input);
    const request_id = randomUUID();
    const started = Date.now();
    const result = (error_code, submission) => ({ status: 'error', error_code, submission,
      message: messages[error_code], request_id, elapsed_ms: Date.now() - started });
    if (this.controller) {
      return result('BUSY', 'not_sent');
    }
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let sent = false;
    try {
      const endpoint = await this.preflight(path, input.parameters, controller.signal);
      const headers = { ...this.headers(), ...await this.csrf(controller.signal),
        'Content-Type': 'application/x-www-form-urlencoded' };
      controller.signal.throwIfAborted();
      // Never retry a mutation: a dropped connection may follow a successful enqueue.
      sent = true;
      const response = await fetch(new URL(path + endpoint, this.config.url), {
        method: 'POST', headers, body, signal: controller.signal, redirect: 'manual'
      });
      const status = response.status;
      const queue = this.queue(response.headers.get('location'));
      await response.body?.cancel();
      if ([201, 202].includes(status)) {
        const receipt = await this.receipt(queue, input.job, path, controller.signal);
        return { status: 'submitted', message: 'Jenkins 已接收部署请求；此结果不代表部署完成或成功。',
          job: input.job, job_url: new URL(`${path}/`, this.config.url).href,
          http_status: status, ...queue, ...receipt, request_id, elapsed_ms: Date.now() - started,
          next_action: '调用 jenkins_deployment_status 回查本次队列 ID 或构建号，直到 completed=true，再报告最终结果；不要重新触发。' };
      }
      const rejected = { 400: 'REQUEST_REJECTED', 401: 'AUTH_REQUIRED', 403: 'ACCESS_DENIED',
        404: 'JOB_NOT_FOUND', 405: 'REQUEST_REJECTED' }[status];
      return { ...result(rejected || 'SUBMISSION_UNKNOWN', rejected ? 'rejected' : 'unknown'), http_status: status };
    } catch (error) {
      const code = sent ? 'SUBMISSION_UNKNOWN' : controller.signal.aborted ? 'TIMEOUT'
        : Object.hasOwn(messages, error.code) ? error.code : 'CONNECTION_ERROR';
      return { ...result(code, sent ? 'unknown' : 'not_sent'),
        ...(code === 'PARAMETERS_REQUIRED' ? { missing_parameters: error.missing_parameters } : {}) };
    } finally {
      clearTimeout(timer);
      this.controller = null;
    }
  }

  async deploymentStatus(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['job', 'queue_id', 'build_number'].includes(key))
      || Number(Object.hasOwn(input, 'queue_id')) + Number(Object.hasOwn(input, 'build_number')) !== 1
      || !Number.isSafeInteger(input.queue_id ?? input.build_number) || (input.queue_id ?? input.build_number) < 1) {
      throw invalid('需要 job 和且仅一个正整数 queue_id 或 build_number');
    }
    const { path } = deployment({ job: input.job });
    const request_id = randomUUID();
    const controller = new AbortController();
    this.queries.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    const base = { job: input.job, request_id, ...(input.queue_id ? { queue_id: input.queue_id } : {}) };
    try {
      let number = input.build_number;
      if (input.queue_id) {
        const item = await this.read(`queue/item/${input.queue_id}/api/json`,
          'id,cancelled,task[name,fullName,url],executable[number]', controller.signal);
        if (item?.id !== input.queue_id || !this.matchesJob(item.task, input.job, path)) {
          throw failure('IDENTITY_MISMATCH');
        }
        if (item.cancelled === true) {
          return { ...base, status: 'cancelled', completed: true, elapsed_ms: Date.now() - started,
            message: '部署在队列中被取消。' };
        }
        number = item.executable?.number;
        if (number === undefined || number === null) {
          return { ...base, status: 'queued', completed: false, poll_after_seconds: 5, elapsed_ms: Date.now() - started,
            message: '部署仍在排队，请继续回查本次 queue_id。' };
        }
        if (!Number.isSafeInteger(number) || number < 1) {
          throw failure('IDENTITY_MISMATCH');
        }
      }
      const build = await this.read(`${path}/${number}/api/json`, 'number,building,result,duration,queueId', controller.signal);
      if (build?.number !== number || (input.queue_id && build.queueId !== input.queue_id)) {
        throw failure('IDENTITY_MISMATCH');
      }
      const details = { ...base, build_number: number, build_url: new URL(`${path}/${number}/`, this.config.url).href,
        ...(Number.isSafeInteger(build.queueId) && build.queueId > 0 ? { queue_id: build.queueId } : {}),
        ...(Number.isFinite(build.duration) && build.duration >= 0 ? { duration_ms: build.duration } : {}) };
      if (build.building === true) {
        return { ...details, status: 'running', completed: false, poll_after_seconds: 5, elapsed_ms: Date.now() - started,
          message: '部署仍在执行，请继续按本次 build_number 回查直至完成。' };
      }
      const terminal = { SUCCESS: 'succeeded', FAILURE: 'failed', UNSTABLE: 'unstable', ABORTED: 'aborted', NOT_BUILT: 'not_built' };
      if (build.building !== false || !Object.hasOwn(terminal, build.result)) {
        throw failure('STATUS_UNAVAILABLE');
      }
      return { ...details, status: terminal[build.result], completed: true, result: build.result, elapsed_ms: Date.now() - started,
        message: `Jenkins 构建已结束，结果为 ${build.result}；请按此结果汇报。` };
    } catch (error) {
      const error_code = controller.signal.aborted ? 'TIMEOUT' : Object.hasOwn(messages, error.code) ? error.code : 'CONNECTION_ERROR';
      return { ...base, status: 'error', completed: false, error_code,
        message: '无法确认本次部署的完成状态；请核实认证、队列或构建记录后继续查询，不要重新触发部署。',
        elapsed_ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
      this.queries.delete(controller);
    }
  }
}

export const deployTool = {
  name: 'jenkins_deploy',
  description: '触发指定 Jenkins Job 部署。此操作会产生实际部署影响，仅在用户明确要求部署该 Job 及参数后调用。'
    + 'job 为真实 Job 路径；视图 co 不等于文件夹，不要自动添加 co 前缀。'
    + '自动读取目标 Job 并选择提交方式；parameters 可省略以使用默认值。已排队或构建中的 Job 不重复提交。'
    + '只提交一次。submitted 仅表示接收请求，必须继续调用 jenkins_deployment_status 回查到 completed=true，再汇报成功或失败。'
    + 'unknown 必须核实，禁止自动重试。'
    + '账号密码由服务本机配置，不作为工具参数。',
  inputSchema: { type: 'object', properties: {
    job: { type: 'string', minLength: 1, maxLength: 512, description: 'Job 完整名称；文件夹用 / 分隔，例如 folder/service' },
    parameters: { type: 'object', maxProperties: 100, description: 'Jenkins 部署参数；空对象使用参数化 Job 的默认值',
      additionalProperties: { anyOf: [{ type: 'string', maxLength: 16384 }, { type: 'number' }, { type: 'boolean' }] } }
  }, required: ['job'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
};

export const statusTool = {
  name: 'jenkins_deployment_status',
  description: '只读回查本次 Jenkins 部署的完成状态。使用 jenkins_deploy 返回的 job 和 queue_id 或 build_number，二选一。'
    + 'queued/running 时按 poll_after_seconds 等待后继续调用；取得 build_number 后优先用它回查，避免队列记录过期。'
    + 'completed=true 后按 result、耗时和构建链接汇报；SUCCESS 才可报告 Jenkins 构建成功。'
    + '查询失败或记录过期不能视为部署失败或成功，不得改查最新构建或重新触发。',
  inputSchema: { type: 'object', properties: {
    job: { type: 'string', minLength: 1, maxLength: 512 },
    queue_id: { type: 'integer', minimum: 1, description: '本次触发返回的队列 ID；与 build_number 二选一' },
    build_number: { type: 'integer', minimum: 1, description: '本次队列分配的构建号；与 queue_id 二选一' }
  }, required: ['job'], oneOf: [{ required: ['queue_id'] }, { required: ['build_number'] }], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
};

export function serve(client, input = process.stdin, output = process.stdout) {
  let pending = '';
  const send = value => output.write(JSON.stringify(value) + '\n');
  async function handle(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const validId = request && (typeof request.id === 'string' || Number.isSafeInteger(request.id));
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0'
      || typeof request.method !== 'string' || (Object.hasOwn(request, 'id') && !validId)) {
      send({ jsonrpc: '2.0', id: validId ? request.id : null, error: { code: -32600, message: 'Invalid request' } });
      return;
    }
    if (!Object.hasOwn(request, 'id')) {
      return;
    }
    const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
    const error = (code, message) => send({ jsonrpc: '2.0', id: request.id, error: { code, message } });
    if (request.method === 'initialize') {
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
      reply({ protocolVersion: supported.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name: 'mcp-jenkins', version: '1.1.0' } });
    } else if (request.method === 'ping') {
      reply({});
    } else if (request.method === 'tools/list') {
      reply({ tools: [deployTool, statusTool] });
    } else if (request.method !== 'tools/call') {
      error(-32601, 'Method not found');
    } else if (![deployTool.name, statusTool.name].includes(request.params?.name)) {
      error(-32602, 'Unknown tool');
    } else {
      try {
        const checking = request.params.name === statusTool.name;
        const result = await (checking ? client.deploymentStatus(request.params.arguments) : client.deploy(request.params.arguments));
        process.stderr.write(`[${result.status !== 'error' ? 'info' : 'error'}] service=mcp-jenkins tool=${request.params.name}`
          + ` request_id=${result.request_id} status=${result.status} code=${result.error_code || 'OK'} elapsed_ms=${result.elapsed_ms}\n`);
        reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.status === 'error' });
      } catch {
        process.stderr.write(`[error] service=mcp-jenkins tool=${request.params.name} code=INVALID_ARGUMENT\n`);
        reply({ content: [{ type: 'text', text: 'INVALID_ARGUMENT：请按工具说明检查 Job、参数或本次部署标识；未触发新部署。' }], isError: true });
      }
    }
  }
  input.setEncoding('utf8');
  input.on('data', chunk => {
    pending += chunk;
    if (Buffer.byteLength(pending) > 1024 * 1024) {
      process.stderr.write('[error] service=mcp-jenkins code=INPUT_TOO_LARGE\n');
      input.destroy();
      client.close();
      return;
    }
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (line) {
        void handle(line);
      }
    }
  });
  input.on('end', () => client.close());
}

// Node resolves module symlinks; normalize the configured entry path the same way.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const client = new JenkinsClient(configuration());
    serve(client);
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => { client.close(); process.exit(0); });
    }
  } catch {
    process.stderr.write('[error] service=mcp-jenkins code=CONFIG_INVALID 请配置 Jenkins 地址、账号及密码后启动\n');
    process.exitCode = 1;
  }
}

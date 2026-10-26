import { KIND_TAGS } from '../../shared/node-categories.js';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { fail } from './errors.js';
import { controlTypes } from './control-flow.js';
import { agentRequest, agentOutput } from './agent-data.js';
import { messageTypes } from './message-input.js';
import { menuTypes } from './menu-workflow.js';
import { fetchErrorEmails } from './imap.js';

const ERROR_KEYWORDS = 'ERROR,Exception,Failed,FATAL,panic,Traceback,报错,异常,失败';

// Every node carries three orthogonal tags: io (data direction), kind (what it does), role (where it sits in the flow).
export const IO_TAGS = { source: '输入', transform: '输入输出', sink: '输出' };
export { KIND_TAGS };
export const ROLE_TAGS = { start: '开始', step: '过程', end: '终止' };

// Node types are the only extension point of this version; the canvas renders whatever this registry describes.
export function createRegistry({ credentials, menus }) {
  const types = new Map();
  for (const type of  [...presetTypes({ credentials }), ...messageTypes(), ...(menus ? menuTypes(menus) : [])]) {
    types.set(type.type, type);
  }
  return {
    list: () => [...types.values()].map(describe),
    get(typeId) {
      const type = types.get(typeId);
      if (!type) {
        throw fail('NODE_TYPE_UNKNOWN', `未知节点类型：${typeId}`);
      }
      return type;
    },
    isGate: typeId => Boolean(types.get(typeId)?.gate),
    role: typeId => types.get(typeId)?.role || null
  };
}

function describe(type) {
  return { type: type.type, label: type.label, summary: type.summary, gate: Boolean(type.gate), service: Boolean(type.service), manual: Boolean(type.manual),
    io: type.io, kind: type.kind, role: type.role, timeoutMs: type.timeoutMs, params: type.params };
}

function presetTypes({ credentials }) {
  return [startType(), inputType(), mailType({ credentials }), extractType(), gateType(), ...controlTypes(), agentType(), collectType(),
    webhookType(), fileType(), notifyType(), endType()];
}

// The start node only marks the entry; parameters stay on the nodes that actually use them.
function startType() {
  return { type: 'flow.start', label: '开始', summary: '流程入口标记，不处理数据。', io: 'source', kind: 'flow', role: 'start',
    timeoutMs: 2000,
    async resolve() {
      return { started: true };
    } };
}

function inputType() {
  return { type: 'text.input', label: '文本输入', summary: '流程起点：静态文本或 JSON。', io: 'source', kind: 'input', role: 'step',
    params: [
      { name: 'content', label: '内容', kind: 'textarea', rows: 6, default: '', placeholder: '粘贴告警内容或 JSON' },
      { name: 'format', label: '解析方式', kind: 'select', default: 'text',
        options: [{ value: 'text', label: '纯文本' }, { value: 'json', label: 'JSON' }] }
    ],
    timeoutMs: 5000,
    async resolve(context) {
      const content = String(context.params.content || '');
      if (context.params.format === 'json') {
        try {
          return { text: content, value: JSON.parse(content) };
        } catch (error) {
          throw fail('INVALID_JSON', `JSON 解析失败：${error.message}`);
        }
      }
      return { text: content };
    } };
}

function mailType({ credentials }) {
  return { type: 'mail.fetch', label: '邮件读取', summary: '按时间范围和关键字读取邮件正文，可配置为告警、通知等节点。', io: 'source', kind: 'input', role: 'step',
    params: [
      { name: 'credentialId', label: '邮件账号', kind: 'credential', default: '' },
      { name: 'mailbox', label: '文件夹', kind: 'text', default: 'INBOX' },
      { name: 'sinceDays', label: '最近天数', kind: 'number', default: 3 },
      { name: 'keywords', label: '包含关键字（逗号分隔，留空取全部）', kind: 'text', default: ERROR_KEYWORDS },
      { name: 'limit', label: '最多返回', kind: 'number', default: 5 },
      { name: 'scanLimit', label: '最多抓取', kind: 'number', default: 40 }
    ],
    timeoutMs: 60000,
    async resolve(context) {
      const credentialId = String(context.params.credentialId || '');
      if (!credentialId) {
        throw fail('INVALID_ARGUMENT', '请先选择邮件账号');
      }
      const credential = await credentials.secret(credentialId);
      const emails = await fetchErrorEmails({ credential: { host: credential.host, port: credential.port,
        security: credential.security, username: credential.username, password: credential.password },
      mailbox: context.params.mailbox, sinceDays: positive(context.params.sinceDays, 3),
      keywords: csv(context.params.keywords), limit: positive(context.params.limit, 5),
      scanLimit: positive(context.params.scanLimit, 40), shouldStop: context.shouldStop, timeout: context.timeoutMs });
      return { emails, count: emails.length, subject: emails[0]?.subject || '' };
    } };
}

function extractType() {
  return { type: 'log.extract', label: '文本提取', summary: '按关键字或正则提取文本行，可配置为日志、告警等节点。',
    io: 'transform', kind: 'process', role: 'step',
    params: [
      { name: 'input', label: '输入（支持 {{节点.字段}}）', kind: 'textarea', rows: 3, default: '', placeholder: '{{邮件抓取.emails}}' },
      { name: 'keywords', label: '关键字（逗号分隔）', kind: 'text', default: ERROR_KEYWORDS },
      { name: 'pattern', label: '正则（可留空）', kind: 'text', default: '' },
      { name: 'maxItems', label: '最多条数', kind: 'number', default: 20 }
    ],
    timeoutMs: 10000,
    async resolve(context) {
      const regex = compile(context.params.pattern);
      const keywords = csv(context.params.keywords);
      const maxItems = positive(context.params.maxItems, 20);
      const matches = [];
      for (const line of lines(context.value('input'))) {
        const hit = regex ? regex.test(line) : keywords.some(keyword => line.toLowerCase().includes(keyword.toLowerCase()));
        if (hit && matches.length < maxItems) {
          matches.push(line.trim());
        }
      }
      const unique = [...new Set(matches)];
      return { matches: unique, count: unique.length, report: unique.join('\n') };
    } };
}

function gateType() {
  return { type: 'flow.gate', label: '条件继续', summary: '不满足条件时跳过后续节点，避免无意义的 Agent 调用。',
    io: 'transform', kind: 'flow', role: 'step',
    params: [
      { name: 'input', label: '判断输入（支持 {{节点.字段}}）', kind: 'textarea', rows: 3, default: '' },
      { name: 'mode', label: '条件', kind: 'select', default: 'non-empty',
        options: [{ value: 'non-empty', label: '不为空' }, { value: 'contains', label: '包含' }, { value: 'regex', label: '匹配正则' }] },
      { name: 'value', label: '比较值', kind: 'text', default: '' }
    ],
    gate: true,
    timeoutMs: 5000,
    async resolve(context) {
      const raw = context.value('input');
      const text = typeof raw === 'string' ? raw : stringifyValue(raw);
      if (context.params.mode === 'contains') {
        return { passed: text.includes(String(context.params.value || '')), value: text.slice(0, 500) };
      }
      if (context.params.mode === 'regex') {
        const regex = compile(context.params.value);
        return { passed: regex ? regex.test(text) : false, value: text.slice(0, 500) };
      }
      const passed = Array.isArray(raw) ? raw.length > 0 : text.trim().length > 0;
      return { passed, value: text.slice(0, 500) };
    } };
}

// The agent call needs an RPC caller, so this node only prepares the request and maps the result back.
function agentType() {
  return { type: 'agent.review', label: 'Agent 任务',
    summary: '由工作台协调 AI Agent；可配置角色、输入映射、固定输出和限定文件的代码任务。',
    io: 'transform', kind: 'invoke', role: 'step',
    params: [
      { name: 'input', label: '任务输入（支持 {{节点.字段}}）', kind: 'textarea', rows: 4, default: '' },
      { name: 'inputMapping', label: '输入映射 JSON（填写后代替任务输入）', kind: 'textarea', rows: 3, default: '', templated: false,
        placeholder: '{"requirement":"{{source.text}}","review":"{{review.output}}"}' },
      { name: 'rolePrompt', label: '角色提示词', kind: 'textarea', rows: 2, default: '', placeholder: '你是产品 Agent，负责需求分析和验收。' },
      { name: 'instructions', label: '任务指令', kind: 'textarea', rows: 3, default: '请根据以下输入完成任务，并说明结论与依据：' },
      { name: 'outputFields', label: '固定输出字段 JSON（留空则输出文本）', kind: 'textarea', rows: 3, default: '', templated: false,
        placeholder: '{"passed":"boolean","issues":"string[]","route":["code","design"]}' },
      { name: 'mode', label: '任务模式', kind: 'select', default: 'plan',
        options: [{ value: 'plan', label: '只读分析 / 评审 / 路由' }, { value: 'code', label: '限定文件的代码编辑' }] },
      { name: 'files', label: '代码模式允许修改的文件（相对目录，每行一个）', kind: 'textarea', rows: 2, default: '' },
      { name: 'providerId', label: 'Agent 提供方', kind: 'provider', default: '' },
      { name: 'cwd', label: '工作目录（代码模式必填）', kind: 'text', default: '' }
    ], service: true, timeoutMs: 15000,
    async prepare(context) {
      return agentRequest(context);
    },
    after: agentOutput };
}

function collectType() {
  return { type: 'result.collect', label: '结果汇总', summary: '合并上游输出，生成最终报告。',
    io: 'transform', kind: 'process', role: 'step',
    params: [
      { name: 'title', label: '报告标题', kind: 'text', default: '排查报告' },
      { name: 'input', label: '汇总内容（留空则合并所有上游输出）', kind: 'textarea', rows: 4, default: '' },
      { name: 'format', label: '输出格式', kind: 'select', default: 'text',
        options: [{ value: 'text', label: '文本' }, { value: 'json', label: 'JSON' }] }
    ],
    timeoutMs: 10000,
    async resolve(context) {
      const raw = String(context.params.input || '').trim() ? context.value('input')
        : context.parents.map(entry => entry.output).filter(output => output !== undefined);
      const items = Array.isArray(raw) ? raw : [raw];
      const blocks = items.filter(item => item !== undefined && item !== null)
        .map(item => (typeof item === 'string' ? item : lines(item).join('\n'))).filter(Boolean);
      const title = String(context.params.title || '排查报告');
      const report = `${title}\n${'-'.repeat(title.length)}\n${blocks.join('\n\n')}`;
      return context.params.format === 'json' ? { title, items, report, json: JSON.stringify({ title, items }) } : { title, items, report };
    } };
}

function upstreamText(context, paramName = null) {
  const raw = paramName && String(context.params[paramName] || '').trim() ? context.value(paramName)
    : context.parents.map(entry => entry.output).filter(output => output !== undefined);
  const items = Array.isArray(raw) ? raw : [raw];
  return items.filter(item => item !== undefined && item !== null)
    .map(item => (typeof item === 'string' ? item : lines(item).join('\n'))).filter(Boolean).join('\n\n');
}

function webhookType() {
  return { type: 'output.webhook', label: 'HTTP 回调', summary: '把结果发送到指定 URL（告警群、机器人等）。',
    io: 'sink', kind: 'output', role: 'end',
    params: [
      { name: 'url', label: '目标 URL', kind: 'text', default: '', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...' },
      { name: 'method', label: '方法', kind: 'select', default: 'POST',
        options: [{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }] },
      { name: 'body', label: '请求体（留空则合并上游输出，支持 {{节点.字段}}）', kind: 'textarea', rows: 5, default: '' }
    ],
    timeoutMs: 15000,
    async resolve(context) {
      const url = String(context.params.url || '').trim();
      if (!/^https?:\/\/\S+$/.test(url)) {
        throw fail('INVALID_ARGUMENT', 'HTTP 回调需要 http(s) 开头的 URL');
      }
      const response = await fetch(url, { method: String(context.params.method || 'POST'), body: upstreamText(context, 'body'),
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        signal: AbortSignal.timeout(Math.min(context.timeoutMs, 15000)) }).catch(error => {
        throw fail('WEBHOOK_FAILED', `HTTP 回调请求失败：${error.message}`);
      });
      const text = (await response.text()).slice(0, 500);
      if (!response.ok) {
        throw fail('WEBHOOK_FAILED', `HTTP 回调返回 ${response.status}：${text}`);
      }
      return { url, status: response.status, response: text };
    } };
}

function fileType() {
  return { type: 'output.file', label: '写入文件', summary: '把结果写入本机文件，覆盖或追加。',
    io: 'sink', kind: 'output', role: 'end',
    params: [
      { name: 'path', label: '文件路径（绝对路径）', kind: 'text', default: '', placeholder: '/Users/me/reports/alarm.txt' },
      { name: 'mode', label: '写入方式', kind: 'select', default: 'overwrite',
        options: [{ value: 'overwrite', label: '覆盖' }, { value: 'append', label: '追加' }] },
      { name: 'content', label: '内容（留空则合并上游输出）', kind: 'textarea', rows: 4, default: '' }
    ],
    timeoutMs: 10000,
    async resolve(context) {
      const target = String(context.params.path || '').trim();
      if (!isAbsolute(target)) {
        throw fail('INVALID_ARGUMENT', '写入文件需要绝对路径');
      }
      const text = upstreamText(context, 'content');
      await mkdir(dirname(target), { recursive: true });
      if (context.params.mode === 'append') {
        await appendFile(target, `${text}\n`, 'utf8');
      } else {
        await writeFile(target, text, 'utf8');
      }
      return { path: target, bytes: Buffer.byteLength(text, 'utf8') };
    } };
}

// The host gives plugins no system notification channel, so this node produces the reminder as a result.
function notifyType() {
  return { type: 'output.notify', label: '运行提醒', summary: '生成一条提醒（宿主未提供系统通知，展示在结果面板）。',
    io: 'sink', kind: 'output', role: 'end',
    params: [
      { name: 'title', label: '提醒标题', kind: 'text', default: '工作流提醒' },
      { name: 'content', label: '提醒内容（留空则合并上游输出）', kind: 'textarea', rows: 4, default: '' }
    ],
    timeoutMs: 5000,
    async resolve(context) {
      const title = String(context.params.title || '工作流提醒').trim();
      const body = upstreamText(context, 'content');
      if (!body) {
        throw fail('INVALID_ARGUMENT', '运行提醒需要内容');
      }
      return { title, body: body.slice(0, 2000), notified: true };
    } };
}

function endType() {
  return { type: 'flow.end', label: '终止', summary: '流程终点，收集上游内容作为最终结果。',
    io: 'sink', kind: 'flow', role: 'end',
    params: [
      { name: 'input', label: '最终内容（留空则合并所有上游输出）', kind: 'textarea', rows: 4, default: '' }
    ],
    timeoutMs: 5000,
    async resolve(context) {
      const final = upstreamText(context, 'input');
      return { final, length: final.length };
    } };
}

export function compile(pattern) {
  const source = String(pattern || '').trim();
  if (!source) {
    return null;
  }
  try {
    return new RegExp(source);
  } catch (error) {
    throw fail('INVALID_ARGUMENT', `无效的正则表达式：${source}`);
  }
}

export function csv(value) {
  return String(value || '').split(',').map(keyword => keyword.trim()).filter(Boolean);
}

export function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function stringifyValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

// Upstream output may be a raw string, an array of emails or a node object; all become readable lines.
export function lines(value) {
  const texts = [];
  const push = item => {
    if (typeof item === 'string') {
      texts.push(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(push);
      return;
    }
    if (item && typeof item === 'object') {
      texts.push(String(item.text ?? item.body ?? item.report ?? item.output ?? JSON.stringify(item)));
    }
  };
  push(value);
  return String(texts.join('\n')).split(/\r?\n/).filter(line => line.trim());
}

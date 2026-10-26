import { isAbsolute } from 'node:path';
import { fail } from './errors.js';
import { stringify, value } from './template.js';

const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
const isObject = input => input !== null && typeof input === 'object' && !Array.isArray(input);

function parseObject(raw, label) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (isObject(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw fail('INVALID_ARGUMENT', `${label}需要合法的 JSON 对象：${error.message}`);
  }
  throw fail('INVALID_ARGUMENT', `${label}需要 JSON 对象`);
}

// Compact field definitions keep the node editable without a separate schema management feature.
function validField(rule) {
  if (typeof rule === 'string') {
    return TYPES.includes(rule.endsWith('[]') ? rule.slice(0, -2) : rule);
  }
  if (Array.isArray(rule)) {
    return rule.length > 0 && rule.every(entry => typeof entry === 'string');
  }
  return isObject(rule) && Object.keys(rule).length > 0 && Object.values(rule).every(validField);
}

function matches(output, rule) {
  if (Array.isArray(rule)) {
    return rule.includes(output);
  }
  if (isObject(rule)) {
    return isObject(output) && Object.keys(output).length === Object.keys(rule).length
      && Object.entries(rule).every(([key, field]) => Object.hasOwn(output, key) && matches(output[key], field));
  }
  if (rule.endsWith('[]')) {
    return Array.isArray(output) && output.every(entry => matches(entry, rule.slice(0, -2)));
  }
  if (rule === 'object') {
    return isObject(output);
  }
  if (rule === 'array') {
    return Array.isArray(output);
  }
  if (rule === 'integer') {
    return Number.isInteger(output);
  }
  return typeof output === rule && (rule !== 'number' || Number.isFinite(output));
}

function mapped(input, variables) {
  if (Array.isArray(input)) {
    return input.map(entry => mapped(entry, variables));
  }
  if (isObject(input)) {
    return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, mapped(entry, variables)]));
  }
  const resolved = value(input, variables);
  if (resolved === undefined) {
    throw fail('INVALID_ARGUMENT', `Agent 输入映射引用了不存在的变量：${input}`);
  }
  return resolved;
}

export function agentRequest(context) {
  const params = context.params;
  const fields = params.outputFields ? parseObject(params.outputFields, '输出字段') : null;
  if (fields && (!Object.keys(fields).length || !Object.values(fields).every(validField))) {
    throw fail('INVALID_ARGUMENT', '输出字段支持 string、number、integer、boolean、object、array、类型[]、嵌套字段及字符串枚举数组');
  }
  const material = params.inputMapping
    ? mapped(parseObject(params.inputMapping, '输入映射'), context.variables) : context.value('input');
  if (!stringify(material).trim()) {
    throw fail('INVALID_ARGUMENT', 'Agent 节点需要任务输入或输入映射');
  }
  const request = { providerId: String(params.providerId || ''), cwd: String(params.cwd || ''),
    prompt: [params.rolePrompt, params.instructions, stringify(material), fields
      ? `只返回一个 JSON 对象，不要附带解释。所有字段必填，类型严格匹配；数组定义表示可选字符串枚举。输出字段定义：\n${JSON.stringify(fields)}` : '']
      .filter(Boolean).join('\n\n'), outputFields: fields };
  if (params.mode === 'code') {
    const files = String(params.files || '').split(/[,\n]/).map(file => file.trim()).filter(Boolean);
    if (!isAbsolute(request.cwd) || !files.length || files.length > 30) {
      throw fail('INVALID_ARGUMENT', '代码任务需要绝对工作目录及 1–30 个允许修改的文件（相对路径，每行一个）');
    }
    Object.assign(request, { mode: 'code', files });
    request.prompt += `\n\n允许修改的文件范围（相对于工作目录）：\n${files.join('\n')}\n如果需要修改范围外文件，立即停止并说明原因，等待用户调整范围。`;
  }
  return request;
}

function structuredOutput(text) {
  let raw = text.trim();
  const block = [...raw.matchAll(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/gmi)].at(-1);
  if (block && !raw.slice(block.index + block[0].length).trim()) {
    raw = block[1].trim();
  }
  // Legacy providers aggregate progress and answers. Only accept a complete JSON object at the end, never an earlier example.
  const starts = [0, ...[...raw.matchAll(/\n[ \t]*(?=\{)/g)].map(match => match.index + match[0].length)];
  for (const index of starts.reverse()) {
    try {
      return JSON.parse(raw.slice(index));
    } catch {
      // A candidate boundary inside progress text or a nested object is not the final JSON document.
    }
  }
  throw fail('AGENT_OUTPUT_INVALID', 'Agent 未返回有效的 JSON 对象，请重试当前节点');
}

export function agentOutput(result, request = {}) {
  if (!request.outputFields) {
    return { output: result.output, provider: result.provider, length: result.output.length };
  }
  const output = structuredOutput(result.output);
  if (!matches(output, request.outputFields)) {
    throw fail('AGENT_OUTPUT_INVALID', 'Agent 输出字段、类型或枚举值与配置不匹配，请重试当前节点');
  }
  return { output, provider: result.provider, length: result.output.length };
}

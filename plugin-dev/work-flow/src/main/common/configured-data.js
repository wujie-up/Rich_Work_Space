import { readPath, value } from './template.js';
import { fail } from './errors.js';

export function configObject(raw, label = '节点配置') {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw fail('INVALID_ARGUMENT', `${label}需要合法JSON对象`);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('INVALID_ARGUMENT', `${label}需要JSON对象`);
  }
  return parsed;
}

// Only explicitly mapped values are interpolated; executable code and configuration templates remain literal.
export function resolveMapping(input, variables) {
  if (Array.isArray(input)) {
    return input.map(item => resolveMapping(item, variables));
  }
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, resolveMapping(item, variables)]));
  }
  const result = typeof input === 'string' ? value(input, variables) : input;
  if (result === undefined) {
    throw fail('INVALID_ARGUMENT', `输入变量不存在：${input}`);
  }
  return result;
}

export function mappedInput(raw, variables) {
  return resolveMapping(configObject(raw, '输入映射'), variables);
}

export function fieldOf(row, field) {
  if (typeof field !== 'string' || !field || field.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) {
    throw fail('INVALID_ARGUMENT', '字段路径不能为空或包含原型属性');
  }
  const result = readPath(row, field);
  if (result === undefined) {
    throw fail('INVALID_ARGUMENT', `输入记录缺少字段：${field}`);
  }
  return result;
}

function arrays(input) {
  if (!Array.isArray(input)) {
    throw fail('INVALID_ARGUMENT', '数据处理需要数组输入');
  }
  return input;
}

function fieldsOf(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.some(field => typeof field !== 'string' || !field)) {
    throw fail('INVALID_ARGUMENT', '分组/去重需要非空字段列表');
  }
  return fields;
}

function grouped(rows, by) {
  const fields = fieldsOf(by);
  const groups = new Map();
  for (const row of rows) {
    const key = Object.fromEntries(fields.map(field => [field, fieldOf(row, field)]));
    const fingerprint = JSON.stringify(key);
    if (!groups.has(fingerprint)) {
      groups.set(fingerprint, { key, items: [] });
    }
    groups.get(fingerprint).items.push(row);
  }
  return [...groups.values()];
}

function matches(row, rule, allowed) {
  const actual = fieldOf(row, rule.field);
  switch (rule.operator || 'equals') {
    case 'equals': return JSON.stringify(actual) === JSON.stringify(rule.value);
    case 'not-equals': return JSON.stringify(actual) !== JSON.stringify(rule.value);
    case 'in': return allowed.has(JSON.stringify(actual));
    case 'contains': return typeof actual === 'string' && actual.includes(String(rule.value));
    case 'lt': return actual < rule.value;
    case 'lte': return actual <= rule.value;
    case 'gt': return actual > rule.value;
    case 'gte': return actual >= rule.value;
    default: throw fail('INVALID_ARGUMENT', `不支持的筛选操作：${rule.operator}`);
  }
}

function joined(input, rule) {
  const left = arrays(input?.left);
  const right = arrays(input?.right);
  if (!['inner', 'left'].includes(rule.kind || 'inner') || typeof rule.as !== 'string' || !rule.as
    || ['__proto__', 'constructor', 'prototype'].includes(rule.as)) {
    throw fail('INVALID_ARGUMENT', '关联需要kind=inner/left和结果字段as');
  }
  const leftKeys = fieldsOf(Array.isArray(rule.leftKey) ? rule.leftKey : [rule.leftKey]);
  const rightKeys = fieldsOf(Array.isArray(rule.rightKey) ? rule.rightKey : [rule.rightKey]);
  if (leftKeys.length !== rightKeys.length) {
    throw fail('INVALID_ARGUMENT', '关联字段数量不一致');
  }
  const index = new Map();
  for (const row of right) {
    const key = JSON.stringify(rightKeys.map(field => fieldOf(row, field)));
    if (!index.has(key)) {
      index.set(key, []);
    }
    index.get(key).push(row);
  }
  const result = [];
  let bytes = 0;
  for (const row of left) {
    const matches = index.get(JSON.stringify(leftKeys.map(field => fieldOf(row, field))))
      || (rule.kind === 'left' ? [null] : []);
    for (const match of matches) {
      const joined = { ...row, [rule.as]: match };
      bytes += Buffer.byteLength(JSON.stringify(joined));
      if (result.length >= 100000 || bytes > 4194304) {
        throw fail('CONFIGURED_OUTPUT_LIMIT', '关联展开超过10万行或4MiB上限，未构建完整笛卡尔积');
      }
      result.push(joined);
    }
  }
  return result;
}

function operation(input, rule) {
  if (rule.op === 'join') {
    return joined(input, rule);
  }
  const rows = arrays(input);
  switch (rule.op) {
    case 'filter': {
      const allowed = rule.operator === 'in' ? new Set(arrays(rule.value).map(item => JSON.stringify(item))) : null;
      return rows.filter(row => matches(row, rule, allowed));
    }
    case 'select': {
      const fields = Object.entries(configObject(rule.fields, '字段映射'));
      return rows.map(row => Object.fromEntries(fields.map(([name, field]) => [name, fieldOf(row, field)])));
    }
    case 'group': return grouped(rows, rule.by);
    case 'unique': return grouped(rows, rule.by).map(group => group.items[0]);
    case 'batch': {
      if (!Number.isInteger(rule.size) || rule.size < 1 || rule.size > 1000) {
        throw fail('INVALID_ARGUMENT', '批次大小必须为1–1000的整数');
      }
      const result = [];
      for (const group of rule.by?.length ? grouped(rows, rule.by) : [{ key: {}, items: rows }]) {
        for (let start = 0; start < group.items.length; start += rule.size) {
          result.push({ key: group.key, items: group.items.slice(start, start + rule.size) });
        }
      }
      return result;
    }
    case 'sort': {
      if (!Array.isArray(rule.by) || !rule.by.length || rule.by.some(item => !['asc', 'desc'].includes(item.direction || 'asc'))) {
        throw fail('INVALID_ARGUMENT', '排序需要字段及asc/desc方向');
      }
      return [...rows].sort((a, b) => {
        for (const field of rule.by) {
          const left = fieldOf(a, field.field);
          const right = fieldOf(b, field.field);
          const direction = left < right ? -1 : left > right ? 1 : 0;
          if (direction) {
            return direction * (field.direction === 'desc' ? -1 : 1);
          }
        }
        return 0;
      });
    }
    default: throw fail('INVALID_ARGUMENT', `不支持的数据操作：${rule.op}`);
  }
}

export function transformData(input, config) {
  if (!Array.isArray(config.operations) || config.operations.length > 30) {
    throw fail('INVALID_ARGUMENT', '配置需要operations数组，最多30个处理步骤');
  }
  return config.operations.reduce((result, rule) => operation(result, rule), input);
}

const cell = input => String(input ?? '（空）').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
  .replace(/[\\`*_{}\[\]#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');

export function renderReport(input, config) {
  const rows = arrays(input);
  if (!Array.isArray(config.columns) || !config.columns.length || config.columns.length > 30
    || (config.groupBy || []).length > 4) {
    throw fail('INVALID_ARGUMENT', '报告需要1–30个展示列，最多4级分组');
  }
  const lines = [`# ${cell(config.title || '工作流报告')}`, '', `记录数：${rows.length}`, ''];
  const render = (items, level) => {
    const group = config.groupBy?.[level];
    if (group) {
      for (const entry of grouped(items, [group.field])) {
        lines.push(`${'#'.repeat(level + 2)} ${cell(group.label || group.field)}：${cell(entry.key[group.field])}`, '');
        render(entry.items, level + 1);
      }
      return;
    }
    lines.push(`| ${config.columns.map(column => cell(column.label || column.field)).join(' | ')} |`,
      `| ${config.columns.map(() => '---').join(' | ')} |`);
    for (const row of items) {
      lines.push(`| ${config.columns.map(column => cell(fieldOf(row, column.field))).join(' | ')} |`);
    }
    lines.push('');
  };
  if (rows.length) {
    render(rows, 0);
  } else {
    lines.push('本轮没有匹配记录。');
  }
  return lines.join('\n') + '\n';
}

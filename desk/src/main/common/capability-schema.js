import { fail } from '../../shared/contracts.js';

const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description', 'title',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'anyOf', 'oneOf', 'default']);
const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
export function checkSchema(schema, depth = 0) {
  if (typeof schema === 'boolean') {
    return;
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 16
    || Object.keys(schema).some(key => !keywords.has(key))) {
    throw fail('INVALID_CAPABILITY', '能力 Schema 包含不支持的关键字或层级');
  }
  const declared = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (declared.some(type => !types.includes(type)) || (schema.required && (!Array.isArray(schema.required)
    || schema.required.some(key => typeof key !== 'string')))) {
    throw fail('INVALID_CAPABILITY', '能力 Schema 类型无效');
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && !Number.isFinite(schema[key])) {
      throw fail('INVALID_CAPABILITY', '能力 Schema 边界无效');
    }
  }
  if (schema.properties && (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
    throw fail('INVALID_CAPABILITY', '能力 Schema properties 无效');
  }
  for (const child of Object.values(schema.properties || {})) {
    checkSchema(child, depth + 1);
  }
  for (const key of ['items', 'additionalProperties']) {
    if (schema[key] !== undefined) {
      checkSchema(schema[key], depth + 1);
    }
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key]) || !schema[key].length) {
        throw fail('INVALID_CAPABILITY', '能力 Schema 分支无效');
      }
      schema[key].forEach(child => checkSchema(child, depth + 1));
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) {
    throw fail('INVALID_CAPABILITY', '能力 Schema enum 无效');
  }
}

function matchesType(value, type) {
  const checks = { object: value !== null && typeof value === 'object' && !Array.isArray(value), array: Array.isArray(value),
    integer: Number.isInteger(value), number: typeof value === 'number' && Number.isFinite(value), null: value === null,
    string: typeof value === 'string', boolean: typeof value === 'boolean' };
  return checks[type];
}
export function matchesSchema(value, schema) {
  if (typeof schema === 'boolean') {
    return schema;
  }
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => matchesType(value, type))) {
    return false;
  }
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
    return false;
  }
  if (schema.anyOf && !schema.anyOf.some(child => matchesSchema(value, child))) {
    return false;
  }
  if (schema.oneOf && schema.oneOf.filter(child => matchesSchema(value, child)).length !== 1) {
    return false;
  }
  if (typeof value === 'string' && ((schema.minLength !== undefined && value.length < schema.minLength)
    || (schema.maxLength !== undefined && value.length > schema.maxLength))) {
    return false;
  }
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum))) {
    return false;
  }
  if (Array.isArray(value)) {
    return !(schema.minItems !== undefined && value.length < schema.minItems)
      && !(schema.maxItems !== undefined && value.length > schema.maxItems)
      && (schema.items === undefined || value.every(item => matchesSchema(item, schema.items)));
  }
  if (value !== null && typeof value === 'object') {
    return (schema.required || []).every(key => Object.hasOwn(value, key)) && Object.entries(value).every(([key, child]) =>
      Object.hasOwn(schema.properties || {}, key) ? matchesSchema(child, schema.properties[key])
        : schema.additionalProperties === undefined || matchesSchema(child, schema.additionalProperties));
  }
  return true;
}

export function jsonValue(value, code) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw fail(code, '能力数据必须可序列化为 JSON');
  }
  if (text === undefined || Buffer.byteLength(text) > 1024 * 1024) {
    throw fail(code === 'OUTPUT_INVALID' ? 'RESULT_TOO_LARGE' : code, '能力数据超过 1 MiB 或不是 JSON');
  }
  return JSON.parse(text);
}

export function validateDescriptor(value) {
  const descriptor = jsonValue(value, 'INVALID_CAPABILITY');
  if (!/^[a-z][a-zA-Z0-9_.-]{1,120}$/.test(descriptor.id) || !Number.isInteger(descriptor.version) || descriptor.version < 1
    || typeof descriptor.title !== 'string' || !descriptor.title || descriptor.title.length > 160
    || typeof descriptor.description !== 'string' || !descriptor.description || descriptor.description.length > 4000
    || !Array.isArray(descriptor.effects) || descriptor.effects.some(effect => typeof effect !== 'string' || effect.length > 100)
    || !['policy', 'always'].includes(descriptor.confirmation)
    || !Number.isFinite(descriptor.execution?.timeoutMs) || descriptor.execution.timeoutMs < 1
    || descriptor.execution.timeoutMs > 600000 || typeof descriptor.execution.cancellable !== 'boolean'
    || descriptor.execution.retry !== 'never' || !['ready', 'unavailable'].includes(descriptor.state || 'ready')) {
    throw fail('INVALID_CAPABILITY', '能力描述或执行规则无效');
  }
  checkSchema(descriptor.inputSchema);
  checkSchema(descriptor.outputSchema);
  return { ...descriptor, protocol: 'desk.capabilities.v1' };
}

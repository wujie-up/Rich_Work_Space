// MCP enum labels are presentation only; replies always carry the server's original values.
export function elicitationOptions(schema) {
  return schema.oneOf?.map(option => [option.const, option.title])
    || schema.anyOf?.map(option => [option.const, option.title])
    || schema.enum?.map((value, index) => [value, schema.enumNames?.[index] || value]);
}

export function authorizationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('授权链接无效');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw Error('授权链接必须为 HTTP 或 HTTPS 地址，且不能包含账户密码');
  }
  return url.href;
}

function matchesFormat(value, format) {
  if (format === 'email') { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
  if (format === 'date') {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
      && new Date(value).toISOString().slice(0, 10) === value;
  }
  if (format === 'date-time') {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      && matchesFormat(value.slice(0, 10), 'date') && Number.isFinite(Date.parse(value));
  }
  if (format === 'uri') {
    try {
      return !!new URL(value).protocol;
    } catch {
      return false;
    }
  }
  return true;
}

function validateField(value, schema, name) {
  const options = elicitationOptions(schema);
  const valid = {
    string: () => typeof value === 'string' && (schema.minLength === undefined || [...value].length >= schema.minLength)
      && (schema.maxLength === undefined || [...value].length <= schema.maxLength) && matchesFormat(value, schema.format),
    boolean: () => typeof value === 'boolean',
    number: () => typeof value === 'number' && Number.isFinite(value)
      && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum),
    integer: () => Number.isInteger(value) && (schema.minimum === undefined || value >= schema.minimum)
      && (schema.maximum === undefined || value <= schema.maximum),
    array: () => Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems)
      && (schema.maxItems === undefined || value.length <= schema.maxItems)
      && value.every(item => elicitationOptions(schema.items)?.some(([choice]) => choice === item))
  }[schema.type];
  if (!valid?.() || options && !options.some(([choice]) => choice === value)) {
    throw Error(`${schema.title || name}：格式、范围或选项不符合要求`);
  }
}

// Validate the standard MCP form subset without coercing false/zero or inventing answers for omitted fields.
export function elicitationResult(params, action, content) {
  if (!['accept', 'decline', 'cancel'].includes(action)) { throw Error('无效回答结果'); }
  if (action !== 'accept' || params.mode === 'url') { return { action }; }
  if (['openai/form', 'openaiForm'].includes(params.mode)) {
    if (content === undefined) { throw Error('请输入 JSON 回答'); }
    return { action, content };
  }
  const schema = params.requestedSchema;
  if (!content || typeof content !== 'object' || Array.isArray(content)) { throw Error('表单回答必须为对象'); }
  for (const name of schema.required || []) {
    if (!Object.hasOwn(content, name)) { throw Error(`${schema.properties[name]?.title || name}：必填`); }
  }
  for (const [name, value] of Object.entries(content)) {
    if (!Object.hasOwn(schema.properties, name)) { throw Error(`未知表单字段：${name}`); }
    validateField(value, schema.properties[name], name);
  }
  return { action, content };
}

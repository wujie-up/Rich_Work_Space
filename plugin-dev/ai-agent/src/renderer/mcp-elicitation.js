import { setButtonIcon, el } from './ui.js';
import { authorizationUrl, elicitationOptions, elicitationResult } from '../shared/mcp-elicitation.js';

function fieldControl(schema) {
  const options = elicitationOptions(schema.type === 'array' ? schema.items : schema);
  if (schema.type === 'boolean' || options) {
    const select = el('select', { multiple: schema.type === 'array' });
    if (schema.type !== 'array') { select.add(new Option('请选择', '')); }
    for (const [value, label] of schema.type === 'boolean' ? [['true', '是'], ['false', '否']] : options) {
      const option = new Option(label, value);
      option.selected = schema.type === 'array' ? schema.default?.includes(value) || false : String(schema.default) === value;
      select.add(option);
    }
    return select;
  }
  const input = el('input', { type: ['number', 'integer'].includes(schema.type) ? 'number'
    : ({ email: 'email', date: 'date' })[schema.format] || 'text' });
  for (const [attribute, value] of Object.entries({ min: schema.minimum, max: schema.maximum,
    minlength: schema.minLength, maxlength: schema.maxLength, step: schema.type === 'integer' ? 1 : 'any' })) {
    if (value !== undefined) { input.setAttribute(attribute, value); }
  }
  input.value = schema.default ?? '';
  if (schema.format === 'date-time') { input.placeholder = '2026-11-03T10:00:00+08:00'; }
  return input;
}

function fieldValue(control, schema, required) {
  if (schema.type === 'array') {
    const values = [...control.selectedOptions].map(option => option.value);
    return values.length || required ? values : undefined;
  }
  if (control.value === '' && (!required || schema.type !== 'string')) { return undefined; }
  if (schema.type === 'boolean') { return control.value === 'true'; }
  return ['integer', 'number'].includes(schema.type) ? control.valueAsNumber : control.value;
}

// Keep the form mounted while tokens stream; user input never becomes an automatic authorization.
export function mountElicitation(content, event, { respond, openUrl }) {
  const params = event.params;
  const form = el('form', { class: 'mcp-elicitation' });
  const fields = el('fieldset');
  const status = el('div', { role: 'alert', class: 'mcp-elicitation-error' });
  const actions = el('div', { class: 'mcp-elicitation-actions' });
  const controls = new Map();
  let json;
  let url;
  let busy = false;
  fields.append(el('p', { text: params.message }), el('p', { text: `MCP · ${params.serverName || '服务'}` }));
  if (params.mode === 'url') {
    fields.append(el('p', { class: 'mcp-elicitation-url', text: params.url }));
    try {
      url = authorizationUrl(params.url);
    } catch (error) {
      status.textContent = error.message;
    }
  } else if (['openai/form', 'openaiForm'].includes(params.mode)) {
    // Extended forms carry arbitrary JSON Schema; expose the original schema rather than silently dropping fields.
    const details = el('details', {}, el('summary', { text: '表单格式' }), el('pre', { text: JSON.stringify(params.requestedSchema, null, 2) }));
    json = el('textarea', { 'aria-label': 'JSON 回答', rows: 6 });
    json.value = JSON.stringify(params.requestedSchema?.default ?? {}, null, 2);
    fields.append(details, el('label', { text: 'JSON 回答' }, json));
  } else {
    for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
      const control = fieldControl(schema);
      const label = el('label', { text: `${schema.title || name}${params.requestedSchema.required?.includes(name) ? '（必填）' : ''}` });
      if (schema.description) { control.title = schema.description; }
      control.name = name;
      label.append(control);
      fields.append(label);
      controls.set(name, { control, schema });
    }
  }
  const read = () => json ? JSON.parse(json.value) : Object.fromEntries([...controls].map(([name, { control, schema }]) =>
    [name, fieldValue(control, schema, params.requestedSchema.required?.includes(name))]).filter(([, value]) => value !== undefined));
  const submit = async decision => {
    if (busy) { return; }
    status.textContent = '';
    try {
      const answer = decision === 'accept' && params.mode !== 'url' ? read() : undefined;
      if (decision === 'accept' && params.mode === 'url' && !url) { throw Error('授权链接无效'); }
      elicitationResult(params, decision, answer);
      if (decision === 'accept' && !form.reportValidity()) { return; }
      busy = true;
      fields.disabled = true;
      if (decision === 'accept' && params.mode === 'url') { await openUrl(url); }
      await respond(decision, answer);
    } catch (error) {
      status.textContent = error.message;
      console.error('[ai:mcp-elicitation-response-failed]', { requestId: event.id, serverName: params.serverName, error });
    } finally {
      busy = false;
      fields.disabled = false;
    }
  };
  for (const [decision, title, icon] of [
    ['accept', params.mode === 'url' ? '打开授权页面并继续' : '提交回答', params.mode === 'url' ? 'next' : 'send'],
    ['decline', '拒绝', 'close'], ['cancel', '取消本次请求', 'interrupt']
  ]) {
    const button = el('button', { type: 'button', disabled: decision === 'accept' && params.mode === 'url' && !url });
    setButtonIcon(button, title, icon);
    button.onclick = () => submit(decision);
    actions.append(button);
  }
  form.onsubmit = event => { event.preventDefault(); submit('accept'); };
  fields.append(status, actions);
  form.append(fields);
  content.append(form);
}

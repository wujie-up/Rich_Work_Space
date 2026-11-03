import { randomUUID } from 'node:crypto';
import { fail } from '../../shared/contracts.js';

function validSections(sections) {
  return Array.isArray(sections) && sections.length <= 12 && JSON.stringify(sections).length <= 300000
    && sections.every(section => section && typeof section.title === 'string' && section.title.length <= 200
      && (section.collapsed === undefined || typeof section.collapsed === 'boolean')
      && Array.isArray(section.items) && section.items.length <= 100
      && section.items.every(item => item && typeof item.title === 'string' && item.title.length <= 500
        && typeof item.detail === 'string' && item.detail.length <= 90000
        && (item.priority === undefined || (typeof item.priority === 'string' && item.priority.length <= 40))));
}

// Requests belong to a live instance; only the trusted desktop may answer them.
export class PluginMessages {
  constructor(emit = () => {}) {
    this.emit = emit;
    this.records = new Map();
  }

  request(owner, input, answered) {
    if ((input.required !== undefined && typeof input.required !== 'boolean')
      || (input.placement !== undefined && !['anchor', 'center'].includes(input.placement))
      || (input.sections !== undefined && !validSections(input.sections))
      || typeof input.title !== 'string' || typeof input.question !== 'string'
      || input.title.length > 200 || input.question.length > 90000
      || (input.options && (!Array.isArray(input.options) || input.options.length > 30
        || input.options.some(option => typeof option !== 'string' || option.length > 2000)))) {
      throw fail('INPUT_INVALID', '消息内容无效');
    }
    const existing = input.key && [...this.records.values()].find(item => item.owner === owner && item.key === input.key);
    if (existing) {
      return this.get(owner, existing.id);
    }
    if ([...this.records.values()].filter(item => item.state === 'pending').length >= 128) {
      throw fail('RESOURCE_BUSY', '待处理消息过多');
    }
    const record = { id: randomUUID(), key: input.key, owner, title: input.title, question: input.question,
      required: input.required === true, placement: input.placement, sections: input.sections,
      options: input.options || [], optionsOnly: input.optionsOnly === true, state: 'pending', createdAt: Date.now(), answered };
    this.records.set(record.id, record);
    this.changed();
    return this.get(owner, record.id);
  }

  public(record) {
    const { owner, answered, submitting, ...value } = record;
    return { ...value, pluginId: owner.id };
  }

  get(owner, id) {
    const record = this.records.get(id);
    if (!record || record.owner !== owner) {
      throw fail('MESSAGE_FORBIDDEN', '只能访问所属实例的消息');
    }
    return this.public(record);
  }

  list() {
    return [...this.records.values()].filter(item => item.state === 'pending').map(item => this.public(item));
  }

  async respond(id, answer) {
    const record = this.records.get(id);
    if (!record || record.state !== 'pending' || record.submitting) {
      throw fail('MESSAGE_STALE', '消息已失效');
    }
    if (typeof answer?.text !== 'string' || !answer.text.trim() || answer.text.length > 90000
      || (record.optionsOnly && !record.options.includes(answer.text))) {
      throw fail('INPUT_INVALID', '回复无效');
    }
    record.submitting = true;
    try {
      await record.answered?.({ text: answer.text });
      if (record.state === 'pending') {
        record.state = 'answered';
        record.answer = { text: answer.text };
      }
    } catch (error) {
      console.error('[plugin:message-answer-failed]', { pluginId: record.owner.id, requestId: id }, error);
      throw error;
    } finally {
      delete record.submitting;
      this.changed();
    }
    console.info('[plugin:message-delivered]', { pluginId: record.owner.id, requestId: id, state: record.state });
    return this.public(record);
  }

  // Closing a desktop prompt is an explicit disposition that its owning plugin can observe.
  defer(id) {
    const record = this.records.get(id);
    if (!record) { throw fail('MESSAGE_STALE', '消息已失效'); }
    if (record.state === 'pending' && record.required) {
      throw fail('MESSAGE_REQUIRED', '必须回答此消息，或停止所属任务');
    }
    if (record.state === 'pending') {
      record.state = 'deferred';
      this.changed();
      console.info('[plugin:message-deferred]', { pluginId: record.owner.id, requestId: id });
    }
    return this.public(record);
  }

  cancel(owner, id) {
    this.get(owner, id);
    const record = this.records.get(id);
    if ((record.state === 'pending' || record.submitting)) {
      record.state = 'cancelled';
      this.changed();
    }
    return this.public(record);
  }

  revoke(owner) {
    for (const record of this.records.values()) {
      if (record.owner === owner && (record.state === 'pending' || record.submitting)) {
        record.state = 'cancelled';
      }
    }
    this.changed();
  }

  changed() {
    this.emit('messages.changed', this.list());
  }
}

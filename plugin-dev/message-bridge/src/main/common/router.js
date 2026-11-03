import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const messageKey = source => hash([source.channelId, source.chatType, source.chatId, source.messageId]);
export const bindingKey = (route, source) => hash([route.id, source.channelId, source.chatType, source.chatId,
  route.scope === 'chat' ? null : source.senderId]);

function trigger(route, message) {
  const value = route.trigger.value;
  if (route.trigger.type === 'mention') { return message.mentioned ? message.text.trim() : null; }
  if (route.trigger.type === 'keyword') { return message.text.includes(value) ? message.text.trim() : null; }
  if (!message.text.startsWith(value)
    || !/^[@＠]/.test(value) && message.text.length > value.length && !/\s/.test(message.text[value.length])) { return null; }
  return message.text.slice(value.length).trim();
}

export function matchRoute(routes, message) {
  if (message.self || message.system || typeof message.text !== 'string' || !message.text.trim()) { return null; }
  const matches = routes.filter(route => route.enabled && route.channelId === message.channelId
    && (route.sourceMode === 'channel' || route.chatIds?.includes(message.chatId) && route.senderIds?.includes(message.senderId)))
    .map(route => ({ route, text: trigger(route, message) })).filter(match => match.text)
    .sort((a, b) => b.route.priority - a.route.priority);
  if (matches.length > 1 && matches[0].route.priority === matches[1].route.priority) { throw Error('匹配到多个相同优先级规则，请修改触发内容或停用重复规则'); }
  return matches[0] || null;
}

// Iterate Unicode code points so multibyte characters and surrogate pairs survive deterministic byte-limited chunks.
export function splitText(text, limit = 3000) {
  const chunks = [];
  let chunk = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += character;
    bytes += size;
  }
  if (chunk) { chunks.push(chunk); }
  return chunks;
}

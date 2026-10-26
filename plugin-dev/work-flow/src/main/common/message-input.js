import { fail } from './errors.js';

export const isMessageType = type => ['message.wechat', 'message.feishu'].includes(type);
const ids = value => String(value || '').split(/[,，\n]/).map(id => id.trim()).filter(Boolean);

export function matchesMessage(params, message) {
  const chats = ids(params.chatIds);
  const senders = ids(params.senderIds);
  return params.connectionId === message.connectionId
    && (!params.chatType || params.chatType === 'both' || params.chatType === message.chat.type)
    && (!chats.length || chats.includes(message.chat.id))
    && (!senders.length || senders.includes(message.sender.id))
    && message.text.includes(String(params.keyword || ''))
    && (message.channel !== 'feishu' || params.mentionOnly === false || params.mentionOnly === 'false' || message.mentioned === true);
}

// Drafts may keep an unconfigured entry, but a listener must have one unambiguous event source.
export function validateMessageWorkflow(workflow) {
  const entries = workflow.nodes.filter(node => isMessageType(node.type));
  const mode = workflow.trigger?.mode || 'manual';
  if (entries.length > 1 || (entries.length && workflow.nodes.some(node => node.type === 'flow.start'))) {
    throw fail('INVALID_WORKFLOW', '消息工作流只允许一个消息入口，不能混用普通开始节点');
  }
  if (entries.length && ['once', 'interval'].includes(mode)) {
    throw fail('INVALID_WORKFLOW', '消息入口不能使用定时运行方式');
  }
  if (mode === 'message' && (entries.length !== 1 || (workflow.trigger.enabled && !entries[0].params?.connectionId))) {
    throw fail('INVALID_WORKFLOW', '消息监听需要一个已选择连接的消息入口');
  }
  return entries[0] || null;
}

// Validate the saved identity before writing; drafts may retain an incomplete connection selection.
export function validateMessageConnection(workflow, connections) {
  if (workflow?.trigger?.mode !== 'message' || workflow.trigger.enabled !== true) {
    return;
  }
  const entry = validateMessageWorkflow(workflow);
  const connection = connections.find(item => item.id === entry.params.connectionId);
  if (!connection || entry.type !== `message.${connection.channel}`) {
    throw fail('INVALID_WORKFLOW', '消息连接不存在或渠道不匹配，请重新选择连接');
  }
}

export function messageTypes() {
  return ['wechat', 'feishu'].map(channel => ({ type: `message.${channel}`, label: channel === 'wechat' ? '微信消息' : '飞书群消息',
    summary: '接收文本事件作为入口，支持会话/发送人 ID 白名单与关键词；需选择消息监听运行方式。',
    io: 'source', kind: 'input', role: 'start', timeoutMs: 2000,
    params: [
      { name: 'connectionId', label: '消息连接', kind: 'connection', channel, default: '' },
      { name: 'chatType', label: '会话类型', kind: 'select', default: channel === 'wechat' ? 'both' : 'group',
        options: channel === 'wechat' ? [{ value: 'both', label: '私聊和群聊' }, { value: 'private', label: '私聊' },
          { value: 'group', label: '群聊' }] : [{ value: 'group', label: '群聊' }] },
      { name: 'chatIds', label: '会话 ID（逗号或换行分隔，留空不限）', kind: 'textarea', rows: 2, default: '' },
      { name: 'senderIds', label: '发送人 ID（留空不限）', kind: 'textarea', rows: 2, default: '' },
      { name: 'keyword', label: '文本包含（普通子串，留空不限）', kind: 'text', default: '' },
      ...(channel === 'feishu' ? [{ name: 'mentionOnly', label: '仅提及机器人', kind: 'select', default: true,
        options: [{ value: 'true', label: '是' }, { value: 'false', label: '否（需要平台权限）' }] }] : [])
    ],
    async resolve({ message }) {
      if (!message || message.channel !== channel) {
        throw fail('MESSAGE_EVENT_REQUIRED', '消息入口只能由收到的消息触发，请开启消息监听');
      }
      const { mentioned, ...output } = message;
      return output;
    }
  }));
}

// SDK payloads are untrusted. Keep only stable IDs, bounded text and display metadata.
export function normalizedMessage(message) {
  const stableId = value => typeof value === 'string' && value.trim().length > 0;
  if (![message.connectionId, message.messageId, message.chat?.id, message.sender?.id].every(stableId)
    || !['wechat', 'feishu'].includes(message.channel) || !['private', 'group'].includes(message.chat?.type)
    || typeof message.text !== 'string'
    || Buffer.byteLength(message.text, 'utf8') > 65536) {
    return null;
  }
  return { ...message, sentAt: Number.isFinite(message.sentAt) ? message.sentAt : Date.now(), receivedAt: Date.now() };
}

export function receiverEvents({ connection, onMessage, onStatus, onActivity = () => {}, logger = () => {} }) {
  let active = true;
  const pending = new Set();
  const status = value => {
    if (active) {
      onStatus(value);
    }
  };
  const error = () => {
    status({ state: 'error', error: '渠道连接或消息处理失败，请检查配置和服务状态' });
    logger('error', 'message-receiver', { connectionId: connection.id, channel: connection.channel });
  };
  const activity = (kind, reason) => {
    if (active) {
      onActivity({ kind, reason });
    }
  };
  return {
    status, error,
    ignore: reason => activity('ignored', reason),
    message(handler) {
      return this.guard(handler, () => { activity('rejected', 'processing-failed'); error(); });
    },
    guard(handler, onFailure = error) {
      return (...args) => {
        if (!active) {
          return Promise.resolve();
        }
        const task = Promise.resolve().then(() => handler(...args)).catch(onFailure).finally(() => pending.delete(task));
        pending.add(task);
        return task;
      };
    },
    async deliver(message) {
      const normalized = normalizedMessage(message);
      if (active && normalized) {
        await onMessage(normalized);
      } else if (active) {
        activity('rejected', 'invalid-or-oversize');
        logger('info', 'message-rejected', { connectionId: connection.id, reason: 'invalid-or-oversize' });
      }
    },
    async stop() {
      active = false;
      await Promise.allSettled([...pending]);
    }
  };
}

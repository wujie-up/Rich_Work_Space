import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validFeishuWebhook } from './feishu-robot-settings.js';

export const FEISHU_TEST_TEXT = '【测试】放款未回调订单巡检 · 飞书机器人通知测试\n此消息仅验证机器人地址及签名配置，不代表执行了新的财务查询。';

// Same algorithm as sl-platform FeiShuRobotNotifyUtil.genSin: timestamp + LF + secret is the HMAC key, input is empty.
export function feishuSign(key, timestamp) {
  return createHmac('sha256', `${timestamp}\n${key}`).digest('base64');
}

export function splitFeishuText(text) {
  const chunks = [];
  let content = '';
  let bytes = 0;
  const append = unit => {
    const cost = Buffer.byteLength(JSON.stringify(unit)) - 2;
    if (bytes + cost > 12000) {
      chunks.push(content);
      content = '';
      bytes = 0;
    }
    content += unit;
    bytes += cost;
  };
  for (const line of text.split(/(?<=\n)/u)) {
    if (Buffer.byteLength(JSON.stringify(line)) - 2 <= 12000) {
      append(line);
    } else {
      // Long individual lines still split on Unicode code points, never through a UTF-8 sequence.
      for (const char of line) {
        append(char);
      }
    }
  }
  if (content) {
    chunks.push(content);
  }
  return chunks;
}

function deliveryError(sentParts, totalParts, deliveryUnknown) {
  return Object.assign(Error(`飞书通知未完成：已确认成功 ${sentParts}/${totalParts} 段。`
    + (deliveryUnknown ? '当前段送达状态未知，请核对群消息后再重试。' : '请检查机器人配置及飞书返回状态后手动处理。')),
  { code: 'FEISHU_SEND_FAILED', sentParts, totalParts, deliveryUnknown });
}

async function sendFeishuMessages(config, messages, { signal, fetchImpl = fetch, now = () => Date.now(), pauseMs = 1000,
  beforeSend = () => {}, onPart = () => {} } = {}) {
  const webhook = validFeishuWebhook(config.webhook);
  if (typeof config.key !== 'string' || !config.key ) {
    throw Error('飞书通知需要签名密钥和非空正文');
  }
  if (!messages.length || messages.length > 60) {
    throw Error('报告超过60段，未发送；请缩小报告范围后重试');
  }
  if (messages.some(message => Buffer.byteLength(JSON.stringify({ ...message, timestamp: '99999999999', sign: 'x'.repeat(44) })) > 20000)) {
    throw Error('飞书消息超过20KB，未发送任何消息');
  }
  let sentParts = 0;
  for (const message of messages) {
    signal?.throwIfAborted();
    if (sentParts && pauseMs) {
      await delay(pauseMs, undefined, { signal });
    }
    beforeSend();
    signal?.throwIfAborted();
    const timestamp = String(Math.floor(now() / 1000));
    const body = JSON.stringify({ ...message, timestamp, sign: feishuSign(config.key, timestamp) });
    let response;
    let data;
    try {
      response = await fetchImpl(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
      data = await response.json();
    } catch {
      // Fetch errors can contain the webhook or proxy credentials; surface delivery uncertainty without its raw cause.
      throw deliveryError(sentParts, messages.length, true);
    }
    if (!response.ok || data?.code !== 0) {
      throw deliveryError(sentParts, messages.length, false);
    }
    sentParts++;
    onPart({ sentParts, totalParts: messages.length });
  }
  return { sentParts, totalParts: messages.length };
}

export function sendFeishuText(config, text, options) {
  if (typeof text !== 'string' || !text.trim()) {
    throw Error('飞书通知需要非空正文');
  }
  const chunks = splitFeishuText(text);
  return sendFeishuMessages(config, chunks.map((content, index) => ({ msg_type: 'text',
    content: { text: `[${index + 1}/${chunks.length}]\n${content}` } })), options);
}

export function sendFeishuCards(config, cards, options) {
  return sendFeishuMessages(config, cards.map(card => ({ msg_type: 'interactive', card })), options);
}

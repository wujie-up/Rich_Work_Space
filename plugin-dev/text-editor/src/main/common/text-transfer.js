import { randomUUID } from 'node:crypto';

const limit = 16 * 1024 * 1024;

// Stage text only in memory; reuse the original save/draft handlers after every field is complete.
export function registerTextTransfers(context, specs) {
  const transfers = new Map();
  const discard = id => {
    clearTimeout(transfers.get(id)?.timer);
    transfers.delete(id);
  };
  const get = id => {
    const transfer = transfers.get(id);
    if (!transfer) {
      throw Error('文本传输已过期或不存在，请重试');
    }
    return transfer;
  };
  const register = (name, work) => context.methods.register(`editor.transfer.${name}`, async (...args) => {
    try {
      return await work(...args);
    } catch (error) {
      if (name !== 'start') {
        discard(args[0]);
      }
      console.error('[text-editor] text transfer failed', { pluginId: context.pluginId, operation: name, transferId: args[0], error });
      throw error;
    }
  });
  register('start', async (method, args, lengths) => {
    const spec = specs.get(method);
    if (!spec || !Array.isArray(args) || !lengths) {
      throw Error('文本传输参数无效');
    }
    const payload = args[spec.index];
    const fields = new Map();
    for (const field of spec.fields) {
      if (payload?.[field] !== '' || !Number.isInteger(lengths[field]) || lengths[field] < 0 || lengths[field] > limit) {
        throw Error('文本传输字段无效或超过 16 MiB');
      }
      fields.set(field, { length: lengths[field], received: 0, bytes: 0, chunks: [] });
    }
    const handler = spec.prepare ? await spec.prepare(args) : spec.handler;
    if (transfers.size >= 8) {
      throw Error('文本传输并发过多，请稍后重试');
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      discard(id);
      console.info('[text-editor] text transfer expired', { pluginId: context.pluginId, method, transferId: id });
    }, 120000);
    timer.unref();
    transfers.set(id, { spec, handler, args, fields, timer });
    console.info('[text-editor] text transfer started', { pluginId: context.pluginId, method, transferId: id });
    return id;
  });
  register('append', (id, field, text) => {
    const target = get(id).fields.get(field);
    if (!target || typeof text !== 'string' || text.length > 64 * 1024 || target.received + text.length > target.length) {
      throw Error('文本传输分片无效');
    }
    const bytes = target.bytes + Buffer.byteLength(text);
    if (bytes > limit) {
      throw Error('文件超过 16 MiB');
    }
    target.bytes = bytes;
    target.received += text.length;
    target.chunks.push(text);
  });
  register('finish', id => {
    const { spec, handler, args, fields } = get(id);
    discard(id);
    const payload = { ...args[spec.index] };
    for (const [field, value] of fields) {
      if (value.received !== value.length) {
        throw Error('文本传输不完整，请重试');
      }
      payload[field] = value.chunks.join('');
    }
    args[spec.index] = payload;
    console.info('[text-editor] text transfer received', { pluginId: context.pluginId, transferId: id });
    return handler(...args);
  });
  register('abort', discard);
  return () => {
    for (const id of transfers.keys()) {
      discard(id);
    }
  };
}

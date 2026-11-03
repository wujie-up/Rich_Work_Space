export const ALPN = 'work-desk/web-access/1';
export const denied = () => Error('连接请求无效或未授权');

export function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => ![...required, ...optional].includes(key))) { throw denied(); }
  return value;
}

export function validateHello(value) {
  exact(value, ['type', 'version']);
  if (value.type !== 'hello' || value.version !== 1) { throw denied(); }
}

export function validateService(value, services) {
  exact(value, ['type', 'serviceId']);
  if (value.type !== 'stream' || !services.includes(value.serviceId)) { throw denied(); }
  return value.serviceId;
}

export async function readFrame(recv) {
  const header = Buffer.from(await recv.readExact(4));
  const length = header.readUInt32BE();
  if (!length || length > 16384) { throw denied(); }
  return JSON.parse(Buffer.from(await recv.readExact(length)).toString('utf8'));
}

export async function writeFrame(send, value) {
  const data = Buffer.from(JSON.stringify(value));
  if (!data.length || data.length > 16384) { throw denied(); }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  await send.writeAll([...header, ...data]);
}

export async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('连接等待超时')), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export class StreamBudget {
  constructor({ perDevice = 32, total = 128 } = {}) {
    Object.assign(this, { perDevice, total });
    this.devices = new Map();
    this.count = 0;
  }

  acquire(id) {
    const used = this.devices.get(id) || 0;
    if (used >= this.perDevice || this.count >= this.total) { throw Error('连接流数量超过限制'); }
    this.devices.set(id, used + 1);
    this.count++;
    let released = false;
    return () => {
      if (released) { return; }
      released = true;
      const remaining = this.devices.get(id) - 1;
      if (remaining) { this.devices.set(id, remaining); } else { this.devices.delete(id); }
      this.count--;
    };
  }
}

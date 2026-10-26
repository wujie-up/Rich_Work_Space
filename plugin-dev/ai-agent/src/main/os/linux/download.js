import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export async function downloadEngine(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) {
    throw Error(`引擎下载失败 (${response.status})`);
  }
  await pipeline(response.body, createWriteStream(destination, { mode: 0o600 }));
}

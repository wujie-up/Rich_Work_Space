import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../../resource/computer.js', import.meta.url));

async function run(command, args, signal) {
  try {
    return await exec(command, args, { signal, timeout: 20000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (signal?.aborted) { signal.throwIfAborted(); }
    // execFile errors include arguments; typed text and document URLs must never enter error logs.
    throw Error(`macOS 电脑操作失败（${error.code || 'SYSTEM_ERROR'}），请检查系统授权、目标 App 及当前屏幕状态`);
  }
}

async function native(input, signal) {
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', script, JSON.stringify(input)], signal);
  return JSON.parse(stdout);
}

export default {
  supported: true,
  permissions: signal => native({ action: 'permissions' }, signal),
  authorize: signal => native({ action: 'authorize' }, signal),
  async execute(input, signal) {
    if (input.action === 'open') {
      const url = new URL(input.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) { throw Error('只能打开 HTTP(S) 网页链接'); }
      await run('/usr/bin/open', [...(input.bundleId ? ['-b', input.bundleId] : []), url.href], signal);
      return { content: [{ type: 'text', text: input.bundleId ? '已在指定 App 打开网页，请截图确认页面。' : '已在默认浏览器打开网页，请截图确认页面。' }] };
    }
    if (input.action !== 'screenshot') {
      await native(input, signal);
      return { content: [{ type: 'text', text: '操作已执行，请截图确认结果。' }] };
    }
    const screen = await native({ action: 'dimensions', bundleId: input.bundleId }, signal);
    const directory = await mkdtemp(join(tmpdir(), 'deckpg-screen-'));
    try {
      const path = join(directory, 'screen.jpg');
      await run('/usr/sbin/screencapture', ['-x', '-D', '1', '-t', 'jpg', path], signal);
      await run('/usr/bin/sips', ['-z', String(screen.imageHeight), String(screen.imageWidth), '-s', 'formatOptions', '65', path], signal);
      const bytes = await readFile(path);
      if (bytes.length > 700 * 1024) { throw Error('截图过大，请降低屏幕分辨率后重试'); }
      return { content: [{ type: 'text', text: `主屏幕截图 ${screen.imageWidth} × ${screen.imageHeight}；click 使用此图片中的像素坐标。` },
        { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' }] };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
};

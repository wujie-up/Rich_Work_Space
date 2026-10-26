import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

const execute = promisify(execFile);

// Keychain access is performed only after an explicit local-authorization import request.
export async function readLocalCredential(engineId, directory) {
  const digest = createHash('sha256').update(directory).digest('hex');
  const args = engineId === 'codex'
    ? ['-s', 'Codex Auth', '-a', `cli|${digest.slice(0, 16)}`]
    : ['-s', 'Claude Code-credentials', '-a', userInfo().username];
  try {
    const { stdout } = await execute('/usr/bin/security', ['find-generic-password', ...args, '-w'], {
      timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin' }
    });
    return stdout.trim();
  } catch (error) {
    if (error.code === 44) { return null; }
    throw Error('读取本机钥匙串授权失败或被拒绝');
  }
}

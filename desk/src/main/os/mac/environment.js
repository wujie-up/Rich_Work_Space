import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Finder has a reduced PATH; read a fixed command from the user's login shell, never CLI input.
export async function loadLoginPath() {
  try {
    const { stdout } = await promisify(execFile)(process.env.SHELL || '/bin/zsh',
      ['-ilc', 'printf "\\nWORK_DESK_PATH=%s\\n" "$PATH"'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const path = stdout.match(/^WORK_DESK_PATH=(.+)$/m)?.[1];
    if (!path) {
      throw Error('登录 shell 未返回 PATH');
    }
    process.env.PATH = path;
    return null;
  } catch (error) {
    console.error('[platform:path]', { message: error.message });
    return '无法读取登录环境 PATH，请在 CLI 配置中填写可执行文件的绝对路径。';
  }
}

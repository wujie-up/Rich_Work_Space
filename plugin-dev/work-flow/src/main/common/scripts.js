import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scriptPlatform } from '../os/index.js';
import { fail } from './errors.js';

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const LOG_LIMIT = 65536;

export function scriptTimeout(value = 30) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    throw fail('INVALID_ARGUMENT', '脚本超时必须为1–300秒的整数');
  }
  return seconds;
}

function scriptEnvironment() {
  const names = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT'];
  return { ...Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
    ELECTRON_RUN_AS_NODE: '1', PYTHONDONTWRITEBYTECODE: '1' };
}

function requireSafeNumbers(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw fail('SCRIPT_NUMBER_PRECISION', '脚本结果数字超过安全精度；大整数ID请返回字符串');
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(requireSafeNumbers);
  }
}

export function createScriptRunner({ ownProcesses = () => {} } = {}) {
  const active = new Map();
  let stopping = false;
  const report = () => ownProcesses([...active.keys()].map(child => child.pid).filter(Boolean));
  return {
    async run({ language, code, input = null, params = {}, pythonExecutable, timeoutSeconds = 30, shouldStop = () => false }) {
      const seconds = scriptTimeout(timeoutSeconds);
      if (stopping || shouldStop()) {
        throw fail('SCRIPT_CANCELED', '脚本已取消');
      }
      if (!['javascript', 'python'].includes(language) || typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 131072) {
        throw fail('INVALID_ARGUMENT', '请选择JavaScript/Python，并填写不超过128KiB的脚本');
      }
      const body = JSON.stringify({ code, input, params });
      if (Buffer.byteLength(body) > 1048576) {
        throw fail('SCRIPT_INPUT_LIMIT', '脚本输入和代码合计不能超过1MiB');
      }
      const platform = await scriptPlatform();
      const executable = language === 'javascript' ? process.execPath : pythonExecutable || platform.pythonCommand;
      if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')) {
        throw fail('INVALID_ARGUMENT', 'Python解释器需要可执行文件路径或命令名，不包含启动参数');
      }
      const resource = fileURLToPath(new URL(`../../resource/scripts/${language === 'javascript' ? 'javascript.cjs' : 'python.py'}`, import.meta.url));
      const args = language === 'javascript' ? ['--max-old-space-size=128', resource] : ['-I', '-X', 'utf8', resource];
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--max-old-space-size=64', platform.supervisorPath], { ...platform.spawnOptions, env: scriptEnvironment(), stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
        const buffers = { stdout: [], stderr: [], result: [] };
        const lengths = { stdout: 0, stderr: 0, result: 0 };
        let failure;
        let resultReady = false;
        let terminated = false;
        const terminate = error => {
          failure ||= error;
          if (terminated) {
            return;
          }
          terminated = true;
          try {
            platform.terminateScript(child);
          } catch (cause) {
            failure = fail('SCRIPT_TERMINATE_FAILED', `脚本进程终止失败：${cause.code || 'UNKNOWN'}`);
            child.kill('SIGKILL');
          }
        };
        active.set(child, terminate);
        child.once('spawn', () => {
          try {
            report();
            if (stopping || shouldStop()) {
              terminate(fail('SCRIPT_CANCELED', '脚本已取消'));
            }
          } catch (error) {
            terminate(error);
          }
        });
        for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr'], [child.stdio[3], 'result']]) {
          stream.on('data', chunk => {
            lengths[name] += chunk.length;
            if (lengths[name] > (name === 'result' ? OUTPUT_LIMIT : LOG_LIMIT)) {
              terminate(fail('SCRIPT_OUTPUT_LIMIT', '脚本结果超过4MiB或单路日志超过64KiB，执行已终止'));
              return;
            }
            buffers[name].push(chunk);
          });
          stream.on('error', error => terminate(error));
        }
        child.stdio[3].once('end', () => {
          resultReady = true;
          if (!terminated) {
            terminated = true;
            try {
              platform.terminateScript(child);
            } catch (error) {
              failure ||= error;
            }
          }
        });
        const deadline = setTimeout(() => terminate(fail('SCRIPT_TIMEOUT', `脚本超过${seconds}秒，进程已终止`)), seconds * 1000);
        const cancellation = setInterval(() => {
          if (stopping || shouldStop()) {
            terminate(fail('SCRIPT_CANCELED', '脚本已取消，进程已终止'));
          }
        }, 50);
        child.once('error', error => {
          failure = fail(error.code === 'ENOENT' ? 'SCRIPT_RUNTIME_MISSING' : 'SCRIPT_START_FAILED',
            error.code === 'ENOENT' ? '脚本解释器不存在，请配置已安装的Python解释器路径' : `脚本启动失败：${error.code || 'UNKNOWN'}`);
        });
        child.once('close', code => {
          clearTimeout(deadline);
          clearInterval(cancellation);
          try {
            if (!terminated) {
              platform.terminateScript(child);
            }
          } catch (error) {
            failure ||= error;
          }
          active.delete(child);
          try {
            report();
            if (failure) {
              throw failure;
            }
            if (code !== 0 && !resultReady) {
              throw fail('SCRIPT_FAILED', `脚本进程退出码${code}：${Buffer.concat(buffers.stderr).toString('utf8').slice(-4096)}`);
            }
            let result;
            try {
              result = JSON.parse(Buffer.concat(buffers.result).toString('utf8'));
            } catch {
              throw fail('SCRIPT_PROTOCOL', '脚本未返回有效JSON结果');
            }
            if (result.ok !== true || !Object.hasOwn(result, 'value')) {
              throw fail(['SCRIPT_RUNTIME_MISSING', 'SCRIPT_OUTPUT_LIMIT', 'SCRIPT_START_FAILED'].includes(result.code) ? result.code : 'SCRIPT_FAILED',
                String(result.error || '脚本执行失败').slice(-8192));
            }
            requireSafeNumbers(result.value);
            resolve({ value: result.value, stdout: Buffer.concat(buffers.stdout).toString('utf8'),
              stderr: Buffer.concat(buffers.stderr).toString('utf8') });
          } catch (error) {
            reject(error);
          }
        });
        child.stdin.on('error', error => {
          if (error.code !== 'EPIPE') {
            terminate(error);
          }
        });
        // Keep stdin open as a parent-liveness pipe; the supervisor kills its group when this process exits.
        child.stdin.write(JSON.stringify({ executable, args, body: JSON.parse(body) }) + '\n');
      });
    },
    stop() {
      stopping = true;
      for (const terminate of active.values()) {
        terminate(fail('SCRIPT_CANCELED', '插件停止，脚本已终止'));
      }
    }
  };
}

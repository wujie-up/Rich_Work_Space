import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AppServer } from './app-server.js';
import { restoreCodexSession } from './adapters/codex-session.js';
import { fail } from '../../shared/contracts.js';

const execute = promisify(execFile);

// Use the pinned isolated profile; deletion must never fall back to the OS CLI or account.
export async function deleteNativeContext(runtime, session, options = {}) {
  if (!session.runtimeId || session.protocol !== 'managed-terminal') {
    throw fail('DELETE_UNSUPPORTED', '只有独立安装的受管引擎支持彻底删除');
  }
  const launch = await runtime.runtime(session.adapterId).launch(session.profileId, session.runtimeId);
  if (session.adapterId === 'claude') {
    const helper = fileURLToPath(new URL('../../../dist/main/claude-session-delete.mjs', import.meta.url));
    try {
      await (options.execute || execute)(process.execPath, [helper, session.contextId, session.cwd], {
        cwd: session.cwd, env: { ...launch.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000, maxBuffer: 16384
      });
    } catch (error) {
      throw fail('NATIVE_DELETE_FAILED', 'Claude SDK 删除失败；会话记录已保留，可重试或归档');
    }
    return;
  }
  if (session.adapterId !== 'codex') {
    throw fail('DELETE_UNSUPPORTED', '此引擎没有提供删除接口');
  }
  const server = options.server || new AppServer();
  try {
    await server.start({ ...launch, cwd: session.cwd });
    await server.request('thread/delete', { threadId: session.contextId }).catch(async error => {
      // An unsubmitted TUI context has no rollout after exit; unknown or submitted history must still fail safely.
      if (error.code === -32600 && error.message === `no rollout found for thread id ${session.contextId}`
        && await restoreCodexSession(session, launch.env.CODEX_HOME, join(runtime.root, 'logs')) === undefined) {
        console.info('[session:delete-empty]', { sessionId: session.id, contextId: session.contextId });
        return;
      }
      throw error;
    });
  } catch (error) {
    console.error('[session:native-delete]', { sessionId: session.id, contextId: session.contextId, code: error.code, stack: error.stack });
    throw fail(error.code === -32601 ? 'DELETE_UNSUPPORTED' : 'NATIVE_DELETE_FAILED',
      error.code === -32601 ? '此版本 Codex 不支持彻底删除，请更新引擎或归档' : 'Codex 删除失败；会话记录已保留，可重试或归档');
  } finally {
    await server.closeTask();
  }
}

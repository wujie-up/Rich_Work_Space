// Creation is rejected before launch when another window holds the host lock; retrying cannot duplicate a process.
export async function restoreWhenReady(sessions, pluginId, sessionId, windowId, waiting = () => {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const restored = await sessions.restore(pluginId, sessionId, windowId);
      return await waitForEngine(sessions, pluginId, restored);
    } catch (error) {
      const busy = ['插件正在创建任务', '插件正在创建会话'].includes(error.message);
      if (!busy || attempt >= 240) {
        throw error;
      }
      waiting();
      if (attempt % 10 === 0) {
        console.info('[session:restore-wait]', { pluginId, sessionId, windowId, attempt: attempt + 1 });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// A spawned PTY is not a ready engine. Only native activity from this launch can finish managed recovery.
async function waitForEngine(sessions, pluginId, restored) {
  let current = restored;
  const started = Date.now();
  const deadline = started + 120000;
  for (;;) {
    if (current.exited || ['error', 'offline'].includes(current.activity)) {
      throw Error(current.error?.message || '引擎启动失败，请在历史中重试');
    }
    if (current.protocol !== 'managed-terminal' || current.blocked || ['idle', 'done', 'working'].includes(current.activity)) {
      return current;
    }
    if (Date.now() >= deadline) {
      throw Error('等待引擎就绪超时，窗口已保留，请检查后重试');
    }
    const interval = Math.min(Date.now() - started < 5000 ? 100 : 500, deadline - Date.now());
    await new Promise(resolve => setTimeout(resolve, interval));
    current = (await readRecoveryStatus(sessions, pluginId, deadline)).sessions.find(session => session.id === restored.id);
    if (!current) {
      throw Error('恢复的窗口已关闭，请在历史中重试');
    }
  }
}

// Bound read-only polling as well as delays; an unresponsive status request must not hold the recovery UI forever.
async function readRecoveryStatus(sessions, pluginId, deadline) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => sessions.list(pluginId)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('等待引擎就绪超时，窗口已保留，请检查后重试')), Math.max(0, deadline - Date.now()));
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Both entry points use this queue, and only successfully ready windows advance the ring.
export async function restoreSessionBatch(sessions, context, records, onProgress = () => {}) {
  const result = { sessions: [], errors: [] };
  const progress = (current, restored = null) => {
    try {
      onProgress({ ...result, completed: result.sessions.length, total: records.length, current, restored });
    } catch (error) {
      console.error('[session:recovery-progress-failed]', { ...context, sessionId: current?.id }, error);
    }
  };
  progress(null);
  for (const record of records) {
    progress(record);
    let restored = null;
    const started = performance.now();
    try {
      restored = await restoreWhenReady(sessions, context.pluginId, record.id, context.windowId);
      result.sessions.push(restored);
    } catch (error) {
      console.error('[session:auto-restore]', { ...context, sessionId: record.id }, error);
      result.errors.push({ sessionId: record.id, name: record.name, message: error.message });
    }
    console.info('[session:restore-duration]', { ...context, sessionId: record.id, ready: Boolean(restored),
      elapsedMs: Math.round(performance.now() - started) });
    progress(record, restored);
  }
  return result;
}

export async function recoverSessions(sessions, pluginId, windowId, hostWindows, onProgress = () => {}) {
  const recovery = await sessions.recover(pluginId, windowId, hostWindows);
  const records = recovery.windowId === windowId ? recovery.archives : [];
  const result = await restoreSessionBatch(sessions, { pluginId, windowId }, records, progress => {
    onProgress({ ...progress, sessions: [...recovery.sessions, ...progress.sessions] });
  });
  result.sessions.unshift(...recovery.sessions);
  console.info('[session:auto-restore]', { pluginId, windowId, restored: result.sessions.length, failed: result.errors.length });
  return result;
}

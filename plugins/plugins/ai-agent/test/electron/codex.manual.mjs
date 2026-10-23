// Explicit smoke command only: uses the installed, authenticated CLI for a new temporary conversation.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { launch, owner, alive } from '../../../../../desk/test/electron/helpers.js';
import { readCodexSession } from '../../src/main/common/adapters/codex-session.js';

const cleanup = [];
// Match a standalone Finder launch rather than inheriting the coding agent's internal session routing.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') {
    delete process.env[key];
  }
}
const packaged = process.env.WORK_DESK_PACKAGED === '1';
const { page, data } = await launch({ after: (fn) => cleanup.push(fn) }, packaged
  ? { executablePath: resolve('desk/dist/releases/mac-arm64/Work Desk.app/Contents/MacOS/Work Desk'), reducedPath: true } : {});
const cwd = join(data, 'Agent 工作目录');
const result = { cwd, packaged, cases: [] };
await mkdir(cwd);
const baseArgs = ['--no-daemon', '--no-alt-screen', '-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`];
async function config(prompt) {
  await page.evaluate(({ owner, args }) => agentDesk.storage.saveAdapterConfig(owner, { codex: { command: 'codex', args } }),
    { owner, args: [...baseArgs, ...(prompt ? [prompt] : [])] });
}
async function observe(session, label, expected, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let text = '';
  let latest;
  let readyAt;
  const states = new Set();
  const matches = () => expected.test(stripVTControlCharacters(text)) && ['idle', 'done'].includes(latest?.activity)
    && (!['new', 'native-ready', 'native-new'].includes(label) || states.has('working'));
  while (Date.now() < deadline) {
    const state = await page.evaluate((owner) => agentDesk.sessions.list(owner), owner);
    latest = state.sessions.find((s) => s.id === session.id);
    if (latest) {
      states.add(latest.blocked || latest.activity);
    }
    if (!latest) {
      const archive = await page.evaluate(({ owner, id }) => agentDesk.sessions.readArchive(owner, id), { owner, id: session.id });
      text = archive.output;
      break;
    }
    text = (await page.evaluate(({ owner, id }) => agentDesk.sessions.attach(owner, id), { owner, id: session.id })).data;
    if (matches()) {
      readyAt ||= Date.now();
      if (Date.now() - readyAt >= 1500) {
        break;
      }
    } else {
      readyAt = null;
    }
    await delay(250);
  }
  await writeFile(resolve(`.test-results/codex-${label}.txt`), text);
  const observed = matches() && !!readyAt && Date.now() - readyAt >= 1500;
  result.cases.push({ label, id: session.id, pid: session.pid, states: [...states], activity: latest?.activity, blocked: latest?.blocked, observed });
  return { observed, text, latest };
}
async function archive(session) {
  const log = await readFile(join(data, 'plugin-data', owner, 'logs', session.id, 'codex-tui.log'), 'utf8').catch(() => '');
  await writeFile(resolve(`.test-results/codex-${session.id}-context.txt`), log.split('\n')
    .filter((line) => /session_loop|rollout|thread_id|persist|ephemeral|session.configured|codex_tui::app/i.test(line)).join('\n'));
  const record = await page.evaluate(({ owner, id }) => agentDesk.sessions.archive(owner, id), { owner, id: session.id });
  assert.equal(alive(session.pid), false);
  return record;
}
async function submit(session, text) {
  await page.evaluate(({ owner, id, text }) => agentDesk.sessions.write(owner, id, text), { owner, id: session.id, text });
  // Separate typing from Enter so Codex does not classify a single PTY burst as pasted multiline input.
  await delay(250);
  await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, '\r'), { owner, id: session.id });
}
try {
  await config('Reply exactly WORK_DESK_SMOKE_OK. Do not call tools.');
  const first = await page.evaluate(({ owner, cwd }) => agentDesk.sessions.create(owner,
    { adapterId: 'codex', name: '真实 Codex 新会话', cwd, permission: 'request-approval' }), { owner, cwd });
  const observed = await observe(first, 'new', /•\s+WORK_DESK_SMOKE_OK/);
  result.initialResponseObserved = observed.observed;
  const record = await archive(first);
  result.contextId = record.contextId || null;
  result.archiveActivity = record.activity;
  assert.equal(observed.observed, true, 'No completed Codex reply observed within 60 seconds');
  assert.ok(record.contextId, 'New conversation context ID was not captured');
  await config();
  if (record.contextId) {
    const resumed = await page.evaluate(({ owner, id }) => agentDesk.sessions.restore(owner, id), { owner, id: record.id });
    const resume = await observe(resumed, 'resume', /WORK_DESK_SMOKE_OK/, 15000);
    assert.equal(resume.observed, true, 'Resume did not display this new conversation');
    const forked = await page.evaluate(({ owner, id }) => agentDesk.sessions.fork(owner, id, '真实 Codex 分叉验证'),
      { owner, id: resumed.id });
    const fork = await observe(forked, 'fork', /WORK_DESK_SMOKE_OK/, 15000);
    await archive(resumed);
    result.forkContextId = await readCodexSession(join(data, 'plugin-data', owner, 'logs', forked.id, 'codex-tui.log')) || null;
    assert.equal(fork.observed, true, 'Fork did not display this new conversation');
    assert.ok(result.forkContextId, 'Fork context ID was not captured');
    assert.notEqual(result.forkContextId, result.contextId);
    await submit(forked, '/new');
    const ready = await observe(forked, 'native-ready', /OpenAI Codex/);
    assert.equal(ready.observed, true, 'Native /new startup did not reach idle');
    await submit(forked, 'Reply exactly WORK_DESK_NATIVE_NEW_OK. Do not call tools.');
    const native = await observe(forked, 'native-new', /•\s+WORK_DESK_NATIVE_NEW_OK/);
    const nativeRecord = await archive(forked);
    result.nativeContextId = nativeRecord.contextId || null;
    assert.equal(native.observed, true, 'Native /new did not complete a fresh reply');
    assert.ok(result.nativeContextId, 'Native /new context ID was not captured');
    assert.notEqual(result.nativeContextId, result.forkContextId, 'Native /new retained the previous context ID');
    const nativeResumed = await page.evaluate(({ owner, id }) => agentDesk.sessions.restore(owner, id), { owner, id: nativeRecord.id });
    const nativeResume = await observe(nativeResumed, 'native-resume', /WORK_DESK_NATIVE_NEW_OK/, 15000);
    assert.equal(nativeResume.observed, true, 'Resume after native /new did not display the new conversation');
    assert.equal((await archive(nativeResumed)).contextId, result.nativeContextId);
  }
} catch (error) {
  result.error = { message: error.message, code: error.code };
} finally {
  await writeFile(resolve(`docs/superpowers/execution/codex-${packaged ? 'packaged' : 'smoke'}.json`), JSON.stringify(result, null, 2));
  for (const fn of cleanup.reverse()) {
    await fn();
  }
}
console.log(JSON.stringify(result, null, 2));
if (result.error) {
  process.exitCode = 1;
}

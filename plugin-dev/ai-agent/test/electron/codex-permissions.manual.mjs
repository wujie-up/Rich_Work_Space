// Explicit local CLI verification: only new temporary sessions receive /status, with no agent task or tool execution.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { launch, owner, alive } from '../../../../desk/test/electron/helpers.js';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') {
    delete process.env[key];
  }
}
const cleanup = [];
const packaged = process.env.WORK_DESK_PACKAGED === '1';
const { page, data } = await launch({ after: (fn) => cleanup.push(fn) }, packaged
  ? { executablePath: resolve('desk/dist/releases/mac-arm64/DeckPg.app/Contents/MacOS/DeckPg'), reducedPath: true } : {});
const cwd = join(data, '权限验证 工作目录');
await mkdir(cwd);
await mkdir(resolve('.test-results'), { recursive: true });
const result = { packaged, cases: [] };
async function waitFor(session, pattern) {
  const deadline = Date.now() + 30000;
  let text = '';
  while (Date.now() < deadline) {
    text = stripVTControlCharacters((await page.evaluate(({ owner, id }) => agentDesk.sessions.attach(owner, id),
      { owner, id: session.id })).data);
    if (pattern.test(text)) {
      return text;
    }
    await delay(250);
  }
  throw Error(`CLI output missing ${pattern}: ${text}`);
}
try {
  await page.evaluate(({ owner, args }) => agentDesk.storage.saveAdapterConfig(owner, { codex: { command: 'codex', args } }),
    { owner, args: ['--no-daemon', '--no-alt-screen', '-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`] });
  const permissions = {
    'request-approval': 'Workspace (Ask for approval)',
    'approve-for-me': 'Workspace (Approve for me)',
    unrestricted: 'Full Access'
  };
  for (const [permission, expected] of Object.entries(permissions)) {
    const session = await page.evaluate(({ owner, cwd, permission }) => agentDesk.sessions.create(owner,
      { adapterId: 'codex', name: `真实权限 ${permission}`, cwd, permission }), { owner, cwd, permission });
    await waitFor(session, /OpenAI Codex/);
    await delay(2000);
    await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, '/status'), { owner, id: session.id });
    await delay(250);
    await page.evaluate(({ owner, id }) => agentDesk.sessions.write(owner, id, '\r'), { owner, id: session.id });
    const text = await waitFor(session, /Permissions:|Sandbox:|Approval/);
    const effective = text.match(/Permissions:\s+([^\r\n]+)/)?.[1].trim();
    const outputPath = resolve(`.test-results/permissions-${packaged ? 'packaged' : 'dev'}-${permission}.txt`);
    await writeFile(outputPath, `Permissions: ${effective}\n`);
    assert.equal(effective, expected, `${permission} did not select the expected native mode`);
    const archived = await page.evaluate(({ owner, id }) => agentDesk.sessions.archive(owner, id), { owner, id: session.id });
    assert.equal(archived.permission, permission);
    assert.equal(alive(session.pid), false);
    result.cases.push({ permission, effective, pid: session.pid, outputPath, stopped: true });
  }
} catch (error) {
  result.error = { message: error.message };
} finally {
  await writeFile(resolve(`docs/superpowers/execution/permissions-${packaged ? 'packaged' : 'dev'}.json`), JSON.stringify(result, null, 2));
  for (const fn of cleanup.reverse()) {
    await fn();
  }
}
console.log(JSON.stringify(result, null, 2));
if (result.error) {
  process.exitCode = 1;
}

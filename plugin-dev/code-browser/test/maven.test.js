import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Workspace } from '../src/main/common/workspace.js';

async function fixture(t, script = 'printf "BUILD SUCCESS\\n"', options) {
  const module = await import('../src/main/common/maven.js').catch(() => ({}));
  assert.equal(typeof module.MavenBuild, 'function', 'Maven build support must exist');
  const root = await mkdtemp(join(tmpdir(), 'coding Maven 中文 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pom.xml'), '<project/>');
  await writeFile(join(root, 'mvnw'), `#!/bin/sh\n${script}\n`, { mode: 0o644 });
  const reports = [];
  const build = new module.MavenBuild(pids => reports.push(pids), options);
  t.after(() => build.stop());
  return { root, workspace: await Workspace.open(root), build, reports };
}

async function finished(build) {
  const deadline = Date.now() + 6000;
  while (build.snapshot()?.state === 'running' && Date.now() < deadline) {
    await delay(25);
  }
  assert.notEqual(build.snapshot()?.state, 'running', JSON.stringify(build.snapshot()));
  return build.snapshot();
}

test('Maven wrapper runs fixed compile args in selected module with stdout/stderr and ownership', async t => {
  const { root, workspace, build, reports } = await fixture(t, 'printf "cwd:%s\\n" "$PWD"; printf "arg:%s\\n" "$@"; printf "中文错误\\n" >&2');
  await mkdir(join(root, 'module'));
  await writeFile(join(root, 'module/pom.xml'), '<project/>');
  const started = await build.start(workspace, { path: 'module' });
  assert.equal(started.state, 'running');
  const result = await finished(build);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.path, 'module');
  assert.match(result.log, /module\n/);
  assert.match(result.log, /arg:compile/);
  assert.match(result.log, /arg:--batch-mode/);
  assert.match(result.log, /中文错误/);
  assert.ok(reports.some(pids => pids.length === 1));
  assert.deepEqual(reports.at(-1), []);
});

test('Maven reports nonzero exit as failed and preserves compiler error output', async t => {
  const { workspace, build } = await fixture(t, 'echo "Main.java:[3,4] cannot find symbol" >&2; exit 7');
  await build.start(workspace);
  const result = await finished(build);
  assert.equal(result.state, 'failed');
  assert.equal(result.exitCode, 7);
  assert.match(result.log, /cannot find symbol/);
});

test('Maven validates project boundary and pom before starting commands', async t => {
  const { root, workspace, build, reports } = await fixture(t);
  await assert.rejects(build.start(workspace, { path: '../outside' }), /路径/);
  await mkdir(join(root, 'empty'));
  await assert.rejects(build.start(workspace, { path: 'empty' }), /pom.xml/);
  await symlink(tmpdir(), join(root, 'outside'));
  await assert.rejects(build.start(workspace, { path: 'outside' }), /之外/);
  assert.equal(build.snapshot(), null);
  assert.equal(reports.length, 0);
});

test('Maven prevents simultaneous builds and bounds long logs', async t => {
  const { workspace, build } = await fixture(t, 'sleep 0.2; head -c 200000 /dev/zero | tr "\\000" x; echo END');
  await build.start(workspace);
  await assert.rejects(build.start(workspace), /正在编译/);
  const result = await finished(build);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.log) <= 128 * 1024);
  assert.match(result.log, /END/);
});

test('Maven cancel terminates its descendant process group and leaves unrelated processes alive', async t => {
  const { workspace, build } = await fixture(t, 'trap "" TERM; sleep 60 & echo CHILD:$!; wait');
  const unrelated = spawn('/bin/sleep', ['60']);
  t.after(() => unrelated.kill('SIGKILL'));
  const task = await build.start(workspace);
  while (!build.snapshot().log.includes('CHILD:')) {
    await delay(25);
  }
  const pid = Number(build.snapshot().log.match(/CHILD:(\d+)/)[1]);
  await assert.rejects(build.cancel('another-task'), /任务/);
  await build.cancel(task.id);
  assert.equal((await finished(build)).state, 'cancelled');
  assert.throws(() => process.kill(pid, 0));
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test('Maven timeout is failed and shutdown prevents new builds', async t => {
  const { workspace, build } = await fixture(t, 'sleep 60', { timeoutMs: 100 });
  await build.start(workspace);
  const result = await finished(build);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /超时/);
  await build.stop();
  await assert.rejects(build.start(workspace), /停止/);
});

test('Maven cancellation kills descendants even when the wrapper exits before them', async t => {
  const { workspace, build } = await fixture(t,
    '/bin/sh -c \'trap "" TERM; exec sleep 60\' >/dev/null 2>&1 & echo CHILD:$!; trap "exit 0" TERM; wait');
  const task = await build.start(workspace);
  while (!build.snapshot().log.includes('CHILD:')) {
    await delay(25);
  }
  const pid = Number(build.snapshot().log.match(/CHILD:(\d+)/)[1]);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  await build.cancel(task.id);
  // SIGKILL is asynchronous; allow launchd to reap the orphaned process.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { break; }
    await delay(10);
  }
  assert.throws(() => process.kill(pid, 0));
});

test('Maven uses PATH mvn without a wrapper and reports a missing executable', async t => {
  const { root, workspace, build } = await fixture(t);
  await rm(join(root, 'mvnw'));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin/mvn'), '#!/bin/sh\nprintf "fallback:%s\\n" "$@"\n', { mode: 0o755 });
  const original = process.env.PATH;
  try {
    process.env.PATH = join(root, 'bin');
    await build.start(workspace);
    const result = await finished(build);
    assert.equal(result.state, 'succeeded');
    assert.match(result.log, /fallback:compile/);
    process.env.PATH = join(root, 'empty-path');
    await build.start(workspace);
    const missing = await finished(build);
    assert.equal(missing.state, 'failed');
    assert.match(missing.error, /未找到 mvn/);
  } finally {
    process.env.PATH = original;
  }
});

test('Maven releases ownership only after cleaning descendants of a successful wrapper', async t => {
  const { workspace, build, reports } = await fixture(t, 'sleep 60 >/dev/null 2>&1 & echo CHILD:$!; exit 0');
  await build.start(workspace);
  const task = await finished(build);
  const pid = Number(task.log.match(/CHILD:(\d+)/)[1]);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.equal(task.state, 'succeeded');
  await build.stop();
  assert.deepEqual(reports.at(-1), []);
  await delay(50);
  assert.throws(() => process.kill(pid, 0));
});


test('Maven lifecycle selection builds a module with root reactor and explicit options', async t => {
  const { root, workspace, build } = await fixture(t, 'printf "arg:%s\\n" "$@"');
  await mkdir(join(root, 'module 中文'));
  await writeFile(join(root, 'module 中文/pom.xml'), '<project/>');
  await build.start(workspace, { path: 'module 中文', phase: 'package', clean: true, skipTests: true, alsoMake: true });
  const result = await finished(build);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.phase, 'package');
  assert.match(result.log, /arg:-DskipTests/);
  assert.ok(result.log.includes(`arg:-f\narg:${workspace.root}/pom.xml\narg:-pl\narg:./module 中文\narg:-am`));
  assert.match(result.log, /arg:clean\narg:package/);
});

test('Maven rejects arbitrary goals and malformed options before launching', async t => {
  const { workspace, build, reports } = await fixture(t);
  for (const input of [{ phase: 'exec:exec' }, { phase: 'compile;touch x' }, { skipTests: 'true' }, { alsoMake: 1 }]) {
    await assert.rejects(build.start(workspace, input), /生命周期/);
  }
  assert.equal(build.snapshot(), null);
  assert.deepEqual(reports, []);
  await build.start(workspace, { phase: 'site', clean: true });
  assert.equal((await finished(build)).state, 'succeeded');
});


test('Agent compile schema exposes all default, clean and site lifecycle phases', async () => {
  const { tools } = await import('../src/main/common/capabilities.js');
  const phases = tools.find(tool => tool.name === 'compile').properties.phase.enum;
  assert.deepEqual(phases, ('validate initialize generate-sources process-sources generate-resources process-resources '
    + 'compile process-classes generate-test-sources process-test-sources generate-test-resources process-test-resources '
    + 'test-compile process-test-classes test prepare-package package pre-integration-test integration-test post-integration-test '
    + 'verify install deploy pre-clean clean post-clean pre-site site post-site site-deploy').split(' '));
});

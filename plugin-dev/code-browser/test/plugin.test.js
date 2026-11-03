import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activate, deactivate } from '../src/main/common/index.js';

test('same tools serve UI and capabilities, persist selection and stop cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'code-browser-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'Main.java'), 'class Main {}\n');
  const methods = new Map();
  const capabilities = new Map();
  let settings;
  let lifecycle;
  let persist = async () => {};
  const reports = [];
  const context = {
    pluginId: 'code-browser',
    storage: { readJson: async () => settings, writeJson: async (path, value) => { await persist(); settings = value; } },
    methods: { register: (name, handler) => methods.set(name, handler) },
    capabilities: { register: async (descriptor, handler) => capabilities.set(descriptor.id, { descriptor, handler }) },
    lifecycle: { register: handler => { lifecycle = handler; } },
    ownProcesses: pids => reports.push(pids)
  };
  await activate(context);
  t.after(deactivate);
  assert.equal(capabilities.size, 22);
  assert.equal(capabilities.get('code.compile').descriptor.confirmation, 'always');
  assert.ok(capabilities.get('code.compile').descriptor.effects.includes('process.execute'));
  assert.deepEqual(await methods.get('code.build')(), { task: null });
  assert.equal((await methods.get('code.workspace')()).root, null);
  await assert.rejects(capabilities.get('code.read').handler({ path: 'Main.java' }), /选择/);
  await methods.get('code.select')({ root });
  assert.equal(settings.root, await realpath(root));
  assert.deepEqual(settings.history, [await realpath(root)]);
  const draft = await methods.get('code.edit')({ path: 'Main.java' });
  await methods.get('code.save')({ ...draft, text: draft.text });
  await writeFile(join(root, 'pom.xml'), '<project/>');
  await writeFile(join(root, 'mvnw'), '#!/bin/sh\necho BUILD; sleep 60\n');
  let release;
  let entered;
  const writing = new Promise(done => { entered = done; });
  persist = () => new Promise(done => { release = done; entered(); });
  const selecting = methods.get('code.select')({ root });
  await writing;
  try {
    await assert.rejects(capabilities.get('code.compile').handler({}), /切换项目/);
  } finally {
    release();
    await selecting;
    persist = async () => {};
  }
  for (const { descriptor } of [...capabilities.values()].filter(({ descriptor }) =>
    !['code.compile', 'code.cancelBuild', 'code.gitOperation', 'code.cancelGit', 'code.save', 'code.startSpring', 'code.stopSpring'].includes(descriptor.id))) {
    assert.deepEqual(descriptor.effects, ['filesystem.read']);
    assert.equal(descriptor.execution.cancellable, true);
    assert.equal(descriptor.inputSchema.additionalProperties, false);
  }
  assert.equal((await capabilities.get('code.read').handler({ path: 'Main.java' })).text, 'class Main {}');
  assert.deepEqual(await methods.get('code.read')({ path: 'Main.java' }),
    await capabilities.get('code.read').handler({ path: 'Main.java' }));
  assert.equal((await capabilities.get('code.definitions').handler({ name: 'Main' })).candidates[0].line, 1);
  assert.deepEqual(await methods.get('code.definitions')({ name: 'Main' }),
    await capabilities.get('code.definitions').handler({ name: 'Main' }));
  assert.equal(capabilities.has('code.select'), false);
  const started = await capabilities.get('code.compile').handler({});
  assert.ok((await lifecycle.snapshot()).some(task => task.id === started.task.id));
  await assert.rejects(methods.get('code.select')({ root }), /Git 或 Maven/);
  assert.ok(reports.at(-1).length > 0);
  await lifecycle.stop('disable');
  assert.equal((await capabilities.get('code.build').handler().catch(() => ({ stopped: true }))).stopped, true);
  assert.deepEqual(reports.at(-1), []);
  await assert.rejects(methods.get('code.read')({ path: 'Main.java' }), /停止/);
  assert.deepEqual(await lifecycle.snapshot(), []);
  await deactivate();
  await activate(context);
  assert.equal((await methods.get('code.workspace')()).root, await realpath(root));
});

test('Git management exposes the same structured operations to UI and agent', async t => {
  const methods = new Map();
  const capabilities = new Map();
  await activate({ pluginId: 'code-browser', storage: { readJson: async () => ({}) },
    methods: { register: (name, handler) => methods.set(name, handler) },
    capabilities: { register: async (descriptor, handler) => capabilities.set(descriptor.id, { descriptor, handler }) },
    resources: { acquire: async () => ({ release: async () => {} }) },
    lifecycle: { register() {} }, ownProcesses() {} });
  t.after(deactivate);
  for (const name of ['gitStatus', 'gitOperation', 'gitTask', 'cancelGit']) {
    assert.equal(typeof methods.get(`code.${name}`), 'function');
    assert.ok(capabilities.has(`code.${name}`));
  }
  assert.equal(capabilities.get('code.gitOperation').descriptor.confirmation, 'always');
  assert.equal(capabilities.get('code.gitOperation').descriptor.execution.retry, 'never');
  await assert.rejects(methods.get('code.gitOperation')({ action: 'push' }), /选择/);
});

test('repository lease survives RPC and Git task blocks Maven/project changes', async t => {
  const { execFileSync } = await import('node:child_process');
  const { mkdir } = await import('node:fs/promises');
  const { setTimeout: delay } = await import('node:timers/promises');
  const root = await mkdtemp(join(tmpdir(), 'coding-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'file'), 'test');
  git('add', '.');
  await mkdir(join(root, '.git/hooks'), { recursive: true });
  await writeFile(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  const methods = new Map();
  let held = false;
  let acquired;
  await activate({ pluginId: 'code-browser',
    storage: { readJson: async () => ({ root }) },
    methods: { register: (name, handler) => methods.set(name, handler) },
    capabilities: { register: async () => {} }, lifecycle: { register: () => {} }, ownProcesses: () => {},
    resources: { acquire: async key => {
      acquired = key;
      held = true;
      return { release: async () => { held = false; } };
    } }
  });
  t.after(deactivate);
  const { task } = await methods.get('code.gitOperation')({ action: 'commit', message: 'held' });
  assert.equal(task.state, 'running');
  assert.equal(acquired, `git:${await realpath(root)}`);
  assert.equal(held, true);
  await assert.rejects(methods.get('code.compile')({}), /Git/);
  await assert.rejects(methods.get('code.select')({ root }), /Git/);
  await methods.get('code.cancelGit')({ id: task.id });
  for (let attempt = 0; held && attempt < 100; attempt++) {
    await delay(20);
  }
  assert.equal(held, false);
  assert.equal((await methods.get('code.gitTask')()).task.state, 'cancelled');
});

test('branch view state persists per project without overwriting workspace settings', async t => {
  const methods = new Map();
  const files = new Map();
  const context = {
    pluginId: 'code-browser',
    storage: {
      readJson: async (path, fallback) => structuredClone(files.get(path) ?? fallback),
      writeJson: async (path, value) => { files.set(path, structuredClone(value)); }
    },
    methods: { register: (name, handler) => methods.set(name, handler) },
    capabilities: { register: async () => {} },
    lifecycle: { register() {} }, ownProcesses() {}
  };
  await activate(context);
  t.after(deactivate);
  const first = { favorites: ['refs/heads/main'], expanded: { '收藏': true, '本地': true } };
  const second = { favorites: [], expanded: { '本地': false } };
  await Promise.all([
    methods.get('code.viewState')({ key: '/project-a', value: first }),
    methods.get('code.viewState')({ key: '/project-b', value: second })
  ]);
  await deactivate();
  await activate(context);
  assert.deepEqual(await methods.get('code.viewState')(), { '/project-a': first, '/project-b': second });
  assert.equal((await methods.get('code.workspace')()).root, null);
});

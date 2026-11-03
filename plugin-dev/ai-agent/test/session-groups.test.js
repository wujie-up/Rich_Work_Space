import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';
import { Sessions } from '../src/main/common/sessions.js';
import { SessionGroups } from '../src/main/common/session-groups.js';
import { SessionCoordination } from '../src/main/common/session-coordination.js';

async function setup(t) {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const sessions = new Sessions({ storage, spawn: pty.spawn, adapter: () => ({ capabilities: { restore: true }, buildLaunch: () => ({ command: 'test', args: [], env: {} }) }),
    guard: (_id, work) => work(), processControl: async session => session.terminal.kill() });
  const groups = new SessionGroups({ pluginId: 'test', storage, sessions });
  sessions.groups = groups;
  await groups.load();
  t.after(() => sessions.stopAndArchive('test', 'test'));
  const input = { collaboration: true, name: '短剧开发', cwd: storage.root, members: [{ name: '后端', adapterId: 'test' }, { name: '前端', adapterId: 'test' }] };
  return { storage, sessions, groups, input };
}

test('group creation persists identity and membership through archive and repeated restore', async t => {
  const { storage, sessions, groups, input } = await setup(t);
  const result = await groups.create(input);
  assert.equal(result.sessions.length, 3);
  assert.equal(result.errors.length, 0);
  assert.ok(result.sessions.every(session => session.groupId === result.group.id));
  const [member] = result.sessions;
  await sessions.archive('test', member.id);
  const restored = await sessions.restore('test', member.id);
  assert.equal(restored.groupId, result.group.id);
  const restarted = new SessionGroups({ pluginId: 'test', storage, sessions });
  await restarted.load();
  assert.deepEqual(restarted.list(), groups.list());
  assert.equal(sessions.list('test').groups[0].name, input.name);
});

test('group members retain independent role snapshots when restored', async t => {
  const { groups, sessions, input } = await setup(t);
  const role = { id: 'backend', name: '后端开发', instructions: '负责后端接口与验证。' };
  input.members[0].agentRole = role;
  input.members[1].agentRole = { id: 'frontend', name: '前端开发', instructions: '负责前端交互与验证。' };
  const result = await groups.create(input);
  assert.deepEqual(result.sessions[0].agentRole, role);
  assert.deepEqual(result.sessions[1].agentRole, input.members[1].agentRole);
  role.instructions = '后续模板修改';
  await sessions.archive('test', result.sessions[0].id);
  const restored = await sessions.restore('test', result.sessions[0].id);
  assert.equal(restored.agentRole.instructions, '负责后端接口与验证。');
});

test('new group members and coordinator default to full access and retain it after restoration', async t => {
  const { groups, sessions, input } = await setup(t);
  for (const collaboration of [false, true]) {
    const result = await groups.create({ ...input, collaboration });
    assert.ok(result.sessions.every(session => session.permission === 'unrestricted'));
    if (collaboration) { assert.equal(result.group.coordinator.permission, 'unrestricted'); }
    await groups.archive(result.group.id);
    for (const session of result.sessions) {
      const restored = await sessions.restore('test', session.restoredFrom || session.id);
      assert.equal(restored.permission, 'unrestricted');
    }
  }
});

test('explicit group permissions remain independent from the full access defaults', async t => {
  const { groups, input } = await setup(t);
  const result = await groups.create({ ...input,
    members: [{ ...input.members[0], permission: 'request-approval' }, input.members[1]] });
  assert.deepEqual(result.sessions.map(session => session.permission), ['request-approval', 'unrestricted', 'unrestricted']);
  const explicit = await groups.create({ ...input, coordinator: { permission: 'plan' } });
  assert.equal(explicit.group.coordinator.permission, 'plan');
});

test('invalid members fail before creating groups or terminals', async t => {
  const { groups, sessions, input } = await setup(t);
  for (const members of [[], Array(13).fill(input.members[0]), [{ name: '', adapterId: 'test' }], [input.members[0], input.members[0]], [{ ...input.members[0], agentRole: { id: 'invalid' } }]]) {
    await assert.rejects(groups.create({ ...input, members }));
  }
  assert.deepEqual(groups.list(), []);
  assert.equal(sessions.active.size, 0);
});

test('partial engine failure preserves successful members and reports the failed member', async t => {
  const { groups, sessions, input } = await setup(t);
  const create = sessions.create.bind(sessions);
  sessions.create = (id, member) => member.name === '前端' ? Promise.reject(Error('engine unavailable')) : create(id, member);
  const result = await groups.create(input);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.errors[0].name, '前端');
  assert.equal(groups.list().length, 1);
  assert.equal(sessions.list('test').sessions[0].groupId, result.group.id);
});

test('moving an existing idle session persists membership and rejects busy or failed writes', async t => {
  const { storage, groups, sessions, input } = await setup(t);
  const { group } = await groups.create(input);
  const created = await sessions.create('test', { name: '原有会话', adapterId: 'test', cwd: storage.root });
  const session = sessions.get('test', created.id);
  session.activity = 'idle';
  await groups.assign(session.id, group.id);
  assert.equal((await storage.readJson(sessions.key(session))).groupId, group.id);
  session.activity = 'working';
  await assert.rejects(groups.assign(session.id, ''), { code: 'SESSION_BUSY' });
  assert.equal(session.groupId, group.id);
  session.activity = 'idle';
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw Error('disk unavailable'); };
  await assert.rejects(groups.assign(session.id, ''), /disk unavailable/);
  assert.equal(session.groupId, group.id);
  storage.writeJson = write;
  await groups.assign(session.id, '');
  assert.equal((await storage.readJson(sessions.key(session))).groupId, undefined);
});

test('historical membership persists without launching and survives reload and context restoration', async t => {
  const { storage, groups, sessions, input } = await setup(t);
  const { group } = await groups.create(input);
  const created = await sessions.create('test', { name: '历史后端', adapterId: 'test', cwd: storage.root });
  const original = sessions.get('test', created.id);
  original.contextId = 'native-context';
  original.terminal.write('previous output');
  await sessions.archive('test', created.id);
  const before = await sessions.readArchive('test', created.id);
  const saved = await storage.readJson(sessions.key(before));
  const count = sessions.active.size;
  const assigned = await groups.assign(created.id, group.id);
  assert.equal(assigned.groupId, group.id);
  assert.equal(sessions.active.size, count, 'saving historical membership must not launch the engine');
  assert.deepEqual(await sessions.readArchive('test', created.id), { ...before, groupId: group.id });
  assert.deepEqual(await storage.readJson(sessions.key(before)), { ...saved, groupId: group.id });
  assert.equal(sessions.list('test').archives.find(session => session.id === created.id).groupId, group.id);
  sessions.archives.clear();
  await sessions.loadPlugin('test');
  assert.equal(sessions.archives.get(created.id).groupId, group.id);
  const restored = await sessions.restore('test', created.id, 'current-window');
  assert.equal(restored.groupId, group.id);
  assert.equal(restored.contextId, 'native-context');
  assert.equal(restored.windowId, 'current-window');
  assert.match(sessions.get('test', restored.id).output, /previous output/);
  assert.equal(sessions.list('test').archives.some(session => session.id === created.id), false);
  sessions.get('test', restored.id).activity = 'working';
  await assert.rejects(groups.assign(created.id, ''), { code: 'SESSION_BUSY' });
  sessions.get('test', restored.id).activity = 'idle';
  await groups.assign(created.id, '');
  assert.equal(sessions.get('test', restored.id).groupId, undefined);
});

test('historical assignment validates ownership and preserves membership on storage failure', async t => {
  const { storage, groups, sessions, input } = await setup(t);
  const { group, sessions: members } = await groups.create(input);
  await sessions.archive('test', members[0].id);
  const before = await sessions.readArchive('test', members[0].id);
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw Error('disk unavailable'); };
  await assert.rejects(groups.assign(members[0].id, ''), /disk unavailable/);
  assert.equal(sessions.archives.get(members[0].id).groupId, group.id);
  assert.deepEqual(await sessions.readArchive('test', members[0].id), before);
  storage.writeJson = write;
  await assert.rejects(Promise.resolve().then(() => groups.assign(members[0].id, 'missing')), { code: 'GROUP_NOT_FOUND' });
  const foreign = new SessionGroups({ pluginId: 'foreign', storage, sessions });
  await assert.rejects(Promise.resolve().then(() => foreign.assign(members[0].id, '')), { code: 'SESSION_NOT_FOUND' });
  await groups.assign(members[0].id, '');
  assert.equal((await sessions.readArchive('test', members[0].id)).groupId, undefined);
});

test('renaming and deleting a group preserves live and historical contexts after reload', async t => {
  const { storage, groups, sessions, input } = await setup(t);
  const { group, sessions: members } = await groups.create(input);
  const original = sessions.get('test', members[0].id);
  original.contextId = 'keep-context';
  await sessions.archive('test', original.id);
  const restored = await sessions.restore('test', original.id);
  for (const session of sessions.active.values()) { session.activity = 'idle'; }
  const archived = await sessions.create('test', { name: '历史成员', adapterId: 'test', cwd: storage.root, groupId: group.id });
  await sessions.archive('test', archived.id);
  await groups.rename(group.id, '联合开发');
  assert.equal(sessions.list('test').groups[0].name, '联合开发');
  await groups.delete(group.id);
  assert.deepEqual(groups.list(), []);
  assert.equal(sessions.active.size, 3);
  assert.equal(sessions.get('test', restored.id).contextId, 'keep-context');
  for (const session of [...sessions.active.values(), ...sessions.archives.values()]) {
    assert.equal(session.groupId, undefined);
    assert.equal((await storage.readJson(sessions.key(session))).groupId, undefined);
  }
  const reloaded = new SessionGroups({ pluginId: 'test', storage, sessions });
  await reloaded.load();
  assert.deepEqual(reloaded.list(), []);
});

test('group edits reject invalid or busy changes and roll back failed deletion writes', async t => {
  const { storage, groups, sessions, input } = await setup(t);
  const { group, sessions: members } = await groups.create(input);
  await assert.rejects(groups.rename(group.id, ''), { code: 'INVALID_ARGUMENT' });
  for (const session of sessions.active.values()) { session.activity = 'idle'; }
  sessions.get('test', members[0].id).activity = 'working';
  await assert.rejects(groups.delete(group.id), { code: 'SESSION_BUSY' });
  sessions.get('test', members[0].id).activity = 'idle';
  const write = storage.writeJson.bind(storage);
  let writes = 0;
  storage.writeJson = async (...args) => {
    if (++writes === 2) { throw Error('disk unavailable'); }
    return write(...args);
  };
  await assert.rejects(groups.delete(group.id), /disk unavailable/);
  storage.writeJson = write;
  assert.equal(groups.list()[0].name, input.name);
  for (const session of sessions.active.values()) {
    assert.equal(session.groupId, group.id);
    assert.equal((await storage.readJson(sessions.key(session))).groupId, group.id);
  }
  storage.writeJson = async () => { throw Error('disk unavailable'); };
  await assert.rejects(groups.rename(group.id, '新组名'), /disk unavailable/);
  storage.writeJson = write;
  assert.equal(groups.list()[0].name, input.name);
});

test('each group has a separate persistent coordinator protected against removal and deletion', async t => {
  const { storage, sessions, groups, input } = await setup(t);
  const { group, sessions: members } = await groups.create(input);
  const coordinator = members.find(session => groups.isCoordinator(session));
  assert.ok(coordinator);
  assert.equal(coordinator.name, '组管理员');
  assert.equal(coordinator.agentRole.id, 'group-manager');
  assert.match(coordinator.agentRole.instructions, /终止条件/);
  assert.equal(coordinator.restoredFrom, group.coordinatorId);
  assert.equal(sessions.list('test').sessions.find(session => session.id === coordinator.id).coordinator, true);
  await assert.rejects(Promise.resolve().then(() => sessions.archive('test', coordinator.id)), { code: 'COORDINATOR_REQUIRED' });
  await assert.rejects(sessions.delete('test', coordinator.id), { code: 'COORDINATOR_REQUIRED' });
  await assert.rejects(Promise.resolve().then(() => groups.assign(coordinator.id, '')), { code: 'COORDINATOR_REQUIRED' });
  await sessions.archive('test', coordinator.id, 'upgrade');
  await assert.rejects(sessions.deleteArchive('test', group.coordinatorId), { code: 'COORDINATOR_REQUIRED' });
  const restored = await sessions.restore('test', group.coordinatorId);
  assert.ok(groups.isCoordinator(restored));
  const reloaded = new SessionGroups({ pluginId: 'test', storage, sessions });
  await reloaded.load();
  assert.equal(reloaded.get(group.id).coordinatorId, group.coordinatorId);
});

test('legacy groups acquire one stable coordinator and concurrent watchdogs never create duplicates', async t => {
  const { storage, sessions, groups } = await setup(t);
  await storage.writeJson('plugin-data/test/groups.json', [{ id: 'legacy', name: '原有组' }]);
  await groups.load();
  const id = groups.get('legacy').coordinatorId;
  assert.ok(id);
  assert.equal((await storage.readJson('plugin-data/test/groups.json'))[0].coordinatorId, id);
  const member = await sessions.create('test', { name: '后端', adapterId: 'test', cwd: storage.root, groupId: 'legacy' });
  const create = sessions.create.bind(sessions);
  let proceed;
  let launches = 0;
  const gate = new Promise(resolve => { proceed = resolve; });
  sessions.create = async (...args) => { launches++; await gate; return create(...args); };
  const first = groups.ensureCoordinator('legacy', member);
  const second = groups.ensureCoordinator('legacy', member);
  await assert.rejects(groups.delete('legacy'), { code: 'SESSION_BUSY' });
  proceed();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
  assert.equal(launches, 1);
  assert.equal(a.restoredFrom, id);
  sessions.get('test', a.id).exited = true;
  assert.equal((await groups.ensureCoordinator('legacy', member)).id, a.id, 'an exited coordinator awaits retry, without spawning a loop');
  assert.equal(launches, 1);
});

test('ordinary groups default to no collaboration and never launch a leader after reload', async t => {
  const { storage, sessions, groups, input } = await setup(t);
  const { collaboration, ...ordinary } = input;
  const result = await groups.create(ordinary);
  assert.equal(result.group.collaboration, false);
  assert.equal(result.group.coordinatorId, undefined);
  assert.equal(result.sessions.length, 2);
  await groups.load();
  assert.equal(groups.isCollaborative(result.group.id), false);
  assert.equal(await groups.ensureCoordinator(result.group.id, result.sessions[0]), null);
  assert.equal(sessions.active.size, 2);
  await assert.rejects(groups.create({ ...input, collaboration: 'false' }), { code: 'INVALID_ARGUMENT' });
});

test('legacy coordination windows regain the leader role and retain their context across reloads', async t => {
  const { storage, sessions, groups } = await setup(t);
  for (const coordinatorId of [undefined, 'unused-upgrade-endpoint']) {
    const group = { id: `legacy-${coordinatorId || 'original'}`, name: '短剧开发', coordinatorId };
    groups.records = [group];
    const created = await sessions.create('test', { name: '协调', adapterId: 'test', cwd: storage.root, groupId: group.id });
    const original = sessions.get('test', created.id);
    original.contextId = 'existing-native-context';
    original.terminal.write('previous team work');
    await sessions.archive('test', created.id);
    await storage.writeJson('plugin-data/test/groups.json', [group]);
    sessions.archives.clear();
    await sessions.loadPlugin('test');
    await groups.load();
    assert.equal(groups.get(group.id).coordinatorId, created.id);
    assert.equal(sessions.list('test').archives.find(session => session.id === created.id).coordinator, true);
    const restored = await sessions.restore('test', created.id);
    assert.equal(restored.name, '组管理员');
    assert.equal((await storage.readJson(sessions.key(restored))).name, '组管理员');
    assert.equal(restored.contextId, 'existing-native-context');
    assert.equal(groups.isCoordinator(restored), true);
    assert.match(sessions.get('test', restored.id).output, /previous team work/);
    await sessions.write('test', restored.id, '继续任务');
    assert.match(sessions.get('test', restored.id).output, /继续任务/);
    const count = sessions.active.size;
    assert.equal((await groups.ensureCoordinator(group.id, restored)).id, restored.id);
    assert.equal(sessions.active.size, count, 'reuse the original leader instead of creating a replacement');
    await groups.load();
    assert.equal(groups.get(group.id).coordinatorId, created.id);
    assert.equal((await storage.readJson('plugin-data/test/groups.json'))[0].coordinatorId, created.id);
  }
});

test('legacy role compatibility never replaces an established leader or guesses between candidates', async t => {
  const { storage, sessions, groups } = await setup(t);
  const legacy = { id: 'legacy', name: '原有组', collaboration: true, coordinatorId: 'reserved' };
  const coordinator = { id: 'reserved', pluginId: 'test', name: '组管理员', groupId: legacy.id };
  const member = { id: 'old', pluginId: 'test', name: '协调', groupId: legacy.id };
  sessions.archives.set(member.id, member);
  for (const group of [{ ...legacy, coordinator: { adapterId: 'test' } }, { ...legacy, collaboration: false }]) {
    await storage.writeJson('plugin-data/test/groups.json', [group]);
    await groups.load();
    assert.equal(groups.get(group.id).coordinatorId, 'reserved');
    assert.equal(groups.isCoordinator(member), false);
  }
  sessions.archives.set(coordinator.id, coordinator);
  await storage.writeJson('plugin-data/test/groups.json', [legacy]);
  await groups.load();
  assert.equal(groups.get(legacy.id).coordinatorId, 'reserved');
  sessions.archives.delete(coordinator.id);
  sessions.archives.set('other', { ...member, id: 'other', name: '协调者' });
  await groups.load();
  assert.equal(groups.get(legacy.id).coordinatorId, 'reserved');
});

test('group archive stops busy and blocked members without closing unrelated sessions', async t => {
  const { groups, sessions, storage, input } = await setup(t);
  const { group } = await groups.create(input);
  const members = [...sessions.active.values()];
  members[0].activity = 'working';
  members[1].activity = 'idle';
  members[1].blocked = 'permission';
  const unrelated = await sessions.create('test', { name: '其他会话', adapterId: 'test', cwd: storage.root });
  await Promise.all([groups.archive(group.id), groups.archive(group.id)]);
  assert.ok(members.every(session => session.exited));
  assert.deepEqual([...sessions.active.keys()], [unrelated.id]);
  assert.equal(sessions.get('test', unrelated.id).exited, false);
  assert.equal(sessions.list('test').archives.length, 3);
  assert.ok(groups.get(group.id).archivedAt);
});

test('group archive clears stale supervision even when every member is idle and keeps it stopped after restore', async t => {
  const { groups, sessions, storage, input } = await setup(t);
  const { group } = await groups.create(input);
  sessions.coordination = new SessionCoordination({ pluginId: 'test', sessions, storage });
  await sessions.coordination.load();
  const coordinator = [...sessions.active.values()].find(session => groups.isCoordinator(session));
  const member = [...sessions.active.values()].find(session => !groups.isCoordinator(session));
  await sessions.coordination.task(coordinator, { action: 'start', terminationCondition: '用户验收' });
  await sessions.coordination.submitted(member);
  sessions.active.forEach(session => { session.activity = 'idle'; });
  await groups.archive(group.id);
  assert.equal(sessions.active.size, 0);
  const reloaded = new SessionCoordination({ pluginId: 'test', sessions, storage });
  await reloaded.load();
  assert.equal(reloaded.snapshot(group.id).active, false);
  assert.deepEqual(reloaded.snapshot(group.id).outstanding, []);
  assert.equal(reloaded.snapshot(group.id).terminationCondition, undefined);
  await sessions.restore('test', member.id);
  assert.equal(reloaded.isActive(group.id), false);
});

test('group archive waits for an already starting coordinator and closes it too', async t => {
  const { groups, sessions, input } = await setup(t);
  const { group } = await groups.create(input);
  const coordinator = [...sessions.active.values()].find(session => groups.isCoordinator(session));
  const member = [...sessions.active.values()].find(session => !groups.isCoordinator(session));
  await sessions.archive('test', coordinator.id, 'group-archived');
  let release;
  let started;
  const starting = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  sessions.adapter = () => ({ capabilities: { restore: true }, buildLaunch: async () => {
    started();
    await gate;
    return { command: 'test', args: [], env: {} };
  } });
  const pending = groups.ensureCoordinator(group.id, member);
  await starting;
  const archiving = groups.archive(group.id).then(() => null, error => error);
  assert.equal(await groups.ensureCoordinator(group.id, member), null);
  release();
  await pending;
  assert.equal(await archiving, null);
  assert.equal(sessions.active.size, 0);
  assert.equal(sessions.list('test').archives.length, 3);
  assert.ok(groups.get(group.id).archivedAt);
});

test('group archive tolerates a member finishing its own archive during group persistence', async t => {
  const { groups, sessions, storage, input } = await setup(t);
  const { group } = await groups.create(input);
  const member = [...sessions.active.values()].find(session => !groups.isCoordinator(session));
  const closing = sessions.archive('test', member.id);
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async (key, value) => {
    if (key === 'plugin-data/test/groups.json') { await closing; }
    return write(key, value);
  };
  await groups.archive(group.id);
  assert.equal(sessions.active.size, 0);
  assert.equal(sessions.archives.size, 3);
});

for (const collaboration of [false, true]) {
  test(`group archive during member creation leaves no running members (collaboration=${collaboration})`, async t => {
    const { groups, sessions, input } = await setup(t);
    let release;
    let started;
    const starting = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    sessions.adapter = () => ({ capabilities: { restore: true }, buildLaunch: async () => {
      started();
      await gate;
      return { command: 'test', args: [], env: {} };
    } });
    const creating = groups.create({ ...input, collaboration });
    await starting;
    const [group] = groups.list();
    const archiving = groups.archive(group.id);
    await new Promise(resolve => setImmediate(resolve));
    release();
    await Promise.all([creating, archiving]);
    assert.equal(sessions.active.size, 0);
    assert.ok(sessions.archives.size >= 1);
    assert.ok(groups.get(group.id).archivedAt);
  });
}

test('group archive retains history and suspends coordination until an explicit restore', async t => {
  const { groups, sessions, storage, input } = await setup(t);
  const { group } = await groups.create(input);
  sessions.active.forEach(session => { session.activity = 'idle'; session.contextId = 'saved-context'; });
  await groups.archive(group.id);
  assert.equal(sessions.active.size, 0);
  assert.ok(groups.get(group.id).archivedAt);
  assert.equal(groups.isCollaborative(group.id), false);
  assert.equal(sessions.list('test').archives.length, 3);
  assert.ok(sessions.list('test').archives.every(session => session.groupId === group.id && session.contextId === 'saved-context'));
  const reloaded = new SessionGroups({ pluginId: 'test', storage, sessions });
  await reloaded.load();
  assert.equal(await reloaded.ensureCoordinator(group.id, {}), null);
  assert.deepEqual((await sessions.recover('test', 'window')).archives, []);
  const member = sessions.list('test').archives.find(session => !session.coordinator);
  const restored = await sessions.restore('test', member.id, 'window');
  assert.equal(restored.groupId, group.id);
  assert.equal(groups.get(group.id).archivedAt, undefined);
  assert.equal(groups.isCollaborative(group.id), true);
});

test('failed archive persistence leaves all windows intact', async t => {
  const { groups, sessions, storage, input } = await setup(t);
  const { group } = await groups.create(input);
  sessions.active.forEach(session => { session.activity = 'idle'; });
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw Error('disk unavailable'); };
  await assert.rejects(groups.archive(group.id), /disk unavailable/);
  assert.equal(sessions.active.size, 3);
  assert.equal(groups.get(group.id).archivedAt, undefined);
  storage.writeJson = write;
});

test('failed supervision cancellation reports failure and allows archive retry without losing members', async t => {
  const { groups, sessions, storage, input } = await setup(t);
  const { group } = await groups.create(input);
  sessions.coordination = new SessionCoordination({ pluginId: 'test', sessions, storage });
  await sessions.coordination.load();
  await sessions.coordination.start([...sessions.active.values()][0]);
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async (key, value) => {
    if (key === 'plugin-data/test/coordination.json') { throw Error('coordination disk unavailable'); }
    return write(key, value);
  };
  await assert.rejects(groups.archive(group.id), /coordination disk unavailable/);
  assert.equal(sessions.active.size, 3);
  assert.equal(sessions.archives.size, 0);
  assert.equal(sessions.coordination.snapshot(group.id).active, true);
  assert.ok(groups.get(group.id).archivedAt);
  storage.writeJson = write;
  await groups.archive(group.id);
  assert.equal(sessions.active.size, 0);
  assert.equal(sessions.archives.size, 3);
  assert.equal(sessions.coordination.snapshot(group.id).active, false);
});

test('partial group archive remains suspended and can be retried without losing archived members', async t => {
  const { groups, sessions, input } = await setup(t);
  const { group } = await groups.create(input);
  sessions.active.forEach(session => { session.activity = 'idle'; });
  const archive = sessions.archive.bind(sessions);
  let calls = 0;
  sessions.archive = async (...args) => {
    calls += 1;
    if (calls === 2) { throw Error('terminal stop failed'); }
    return archive(...args);
  };
  await assert.rejects(groups.archive(group.id), /terminal stop failed/);
  assert.equal(sessions.active.size, 2);
  assert.equal(sessions.list('test').archives.length, 1);
  assert.equal(groups.isCollaborative(group.id), false);
  assert.equal(await groups.ensureCoordinator(group.id, {}), null);
  sessions.archive = archive;
  await groups.archive(group.id);
  assert.equal(sessions.active.size, 0);
  assert.equal(sessions.list('test').archives.length, 3);
});

test('failed explicit restore leaves the archived group suspended', async t => {
  const { groups, sessions, input } = await setup(t);
  const { group } = await groups.create(input);
  sessions.active.forEach(session => { session.activity = 'idle'; });
  await groups.archive(group.id);
  const member = sessions.list('test').archives.find(session => !session.coordinator);
  const launch = sessions.launch.bind(sessions);
  sessions.launch = async () => { throw Error('engine unavailable'); };
  await assert.rejects(sessions.restore('test', member.id), /engine unavailable/);
  assert.ok(groups.get(group.id).archivedAt);
  assert.equal(groups.isCollaborative(group.id), false);
  assert.equal(sessions.list('test').archives.length, 3);
  sessions.launch = launch;
});


test('members and administrator keep independent directories through restore', async t => {
  const { storage, groups, sessions, input } = await setup(t);
  const root = await realpath(storage.root);
  const backend = `${root}/backend`;
  const manager = `${root}/manager`;
  await mkdir(backend);
  await mkdir(manager);
  input.members[0].cwd = backend;
  input.coordinator = { cwd: manager };
  const result = await groups.create(input);
  assert.deepEqual(result.sessions.map(session => session.cwd), [backend, root, manager]);
  assert.equal(result.group.coordinator.cwd, manager);
  await sessions.archive('test', result.sessions[0].id);
  const restored = await sessions.restore('test', result.sessions[0].id);
  assert.equal(restored.cwd, backend);
  const target = await groups.create({ ...input, collaboration: false, name: '另一个组' });
  sessions.get('test', restored.id).activity = 'idle';
  await groups.assign(restored.id, target.group.id);
  assert.equal(sessions.get('test', restored.id).cwd, backend);
});

test('invalid member and administrator directories fail before any group or process is created', async t => {
  const { storage, groups, sessions, input } = await setup(t);
  await assert.rejects(groups.create({ ...input, members: [{ ...input.members[0], cwd: `${storage.root}/missing` }] }),
    { code: 'INVALID_ARGUMENT' });
  await assert.rejects(groups.create({ ...input, coordinator: { cwd: 'relative/path' } }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(groups.list(), []);
  assert.equal(sessions.active.size, 0);
});

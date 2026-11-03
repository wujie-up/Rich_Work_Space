import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRole, groupManagerRole, roleCatalog, rolePrompt } from '../src/shared/agent-roles.js';
import { Sessions } from '../src/main/common/sessions.js';
import { temporaryStore, fakePty } from '../../../desk/test/helpers.js';

test('role catalog defaults, protected built-in role and invalid entries', () => {
  assert.equal(roleCatalog({}).items.length, 5);
  assert.deepEqual(roleCatalog({ items: [] }), { items: [groupManagerRole] });
  assert.equal(roleCatalog({ items: [{ id: 'custom', name: '自定义', instructions: 'work' }] }).items[0].id, groupManagerRole.id);
  assert.throws(() => agentRole({ id: 'a', name: ' ', instructions: 'work' }));
  assert.throws(() => roleCatalog({ items: [{ id: 'a', name: 'a', instructions: 'work' }, { id: 'a', name: 'b', instructions: 'work' }] }));
  assert.equal(rolePrompt(undefined, 'coordination'), 'coordination');
});

test('session role snapshot reaches engine and survives archive, restore and template edits', async t => {
  const storage = await temporaryStore(t);
  const pty = fakePty();
  const launches = [];
  const adapter = { capabilities: {}, buildLaunch: input => {
    launches.push(input);
    return { command: 'test', args: [], env: {} };
  } };
  const sessions = new Sessions({ storage, spawn: pty.spawn, adapter: () => adapter, readGit: async () => null,
    guard: (_id, work) => work(), processControl: async session => session.terminal.kill(),
    coordination: { instructions: () => 'existing coordination rules' } });
  const role = { id: 'backend', name: '后端开发', instructions: '检查接口边界' };
  const created = await sessions.create('one', { adapterId: 'test', cwd: storage.root, agentRole: role });
  role.instructions = 'changed template';
  assert.equal(created.agentRole.instructions, '检查接口边界');
  assert.match(launches[0].roleInstructions, /existing coordination rules/);
  assert.match(launches[0].roleInstructions, /检查接口边界/);
  await sessions.archive('one', created.id);
  const restored = await sessions.restore('one', created.id);
  assert.deepEqual(restored.agentRole, created.agentRole);
  assert.equal(launches[1].roleInstructions, launches[0].roleInstructions);
  await sessions.archive('one', restored.id);
});

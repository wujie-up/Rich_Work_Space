import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from '../../../desk/test/helpers.js';
import { EngineManager } from '../src/main/common/engines.js';

test('engine choices are isolated, opt in imports do not touch original data, legacy default remains Codex', async t => {
  const storage = await temporaryStore(t);
  const root = join(storage.root, 'managed');
  const localHome = join(storage.root, 'local');
  await mkdir(join(localHome, '.codex', 'skills', 'example'), { recursive: true });
  await writeFile(join(localHome, '.codex', 'auth.json'), '{"tokens":{"access_token":"private"}}');
  await writeFile(join(localHome, '.codex', 'skills', 'example', 'SKILL.md'), 'example');
  await writeFile(join(localHome, '.codex', 'AGENTS.md'), 'local rules');
  const manager = new EngineManager({ root, localHome, tar: {} });
  assert.equal((await manager.config()).defaultEngine, 'codex');
  await manager.configure({ defaultEngine: 'claude', engines: { codex: { reuseSkills: true, reuseRules: true } } });
  assert.equal((await manager.config()).defaultEngine, 'claude');
  await manager.importAuth('codex');
  const profile = join(root, 'profiles', 'default');
  assert.equal((await stat(join(profile, 'codex', 'auth.json'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(localHome, '.codex', 'auth.json'), 'utf8'), '{"tokens":{"access_token":"private"}}');
  await manager.prepareSources('codex', profile);
  assert.equal(await readFile(join(profile, 'codex', 'skills', 'local-0-example', 'SKILL.md'), 'utf8'), 'example');
  assert.equal(await readFile(join(profile, 'codex', 'AGENTS.md'), 'utf8'), 'local rules');
  assert.notEqual(manager.runtime('codex').root, manager.runtime('claude').root);
  await assert.rejects(manager.configure({ defaultEngine: 'unknown' }), /引擎/);
  await assert.rejects(manager.importAuth('../escape'), /引擎/);
});

test('removing runtime keeps profiles and old config files intact', async t => {
  const storage = await temporaryStore(t);
  const manager = new EngineManager({ root: storage.root, localHome: storage.root, tar: {} });
  await mkdir(join(storage.root, 'profiles', 'default'), { recursive: true });
  await writeFile(join(storage.root, 'profiles', 'default', 'history.json'), 'keep');
  await mkdir(join(storage.root, 'runtimes'), { recursive: true });
  await writeFile(join(storage.root, 'runtimes', 'index.json'), '{}');
  await manager.remove('codex');
  assert.equal(await readFile(join(storage.root, 'profiles', 'default', 'history.json'), 'utf8'), 'keep');
});

test('a failed local skill copy can be retried after repairing the source', async t => {
  const { symlink, rm } = await import('node:fs/promises');
  const storage = await temporaryStore(t);
  const source = join(storage.root, 'local/.codex/skills/example');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), 'keep');
  await symlink(join(source, 'missing'), join(source, 'broken'));
  const manager = new EngineManager({ root: join(storage.root, 'managed'), localHome: join(storage.root, 'local'), tar: {} });
  await manager.configure({ defaultEngine: 'codex', engines: { codex: { reuseSkills: true } } });
  const profile = join(manager.root, 'profiles/default');
  await assert.rejects(manager.prepareSources('codex', profile), { code: 'ENOENT' });
  await rm(join(source, 'broken'));
  await manager.prepareSources('codex', profile);
  assert.equal(await readFile(join(profile, 'codex/skills/local-0-example/SKILL.md'), 'utf8'), 'keep');
});

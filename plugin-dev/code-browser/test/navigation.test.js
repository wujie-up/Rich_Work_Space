import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/main/common/workspace.js';
import { definitions } from '../src/main/common/java.js';
import { tokenize } from '../src/main/common/syntax.js';

test('lexical styles preserve source and keep comments/strings opaque', () => {
  for (const source of ['public class Main { String s = "<img>"; // class Fake {}\nint n = 12; }',
    '<template><!-- comment --><div>{{ value }}</div></template>\n<script>const x = `hello`;</script>']) {
    const tokens = tokenize(source);
    assert.equal(tokens.map(token => token.text).join(''), source);
    assert.ok(tokens.some(token => token.kind === 'comment'));
    assert.ok(tokens.some(token => token.kind === 'keyword' || token.kind === 'tag'));
  }
  assert.equal(tokenize('"class Fake {}"')[0].kind, 'string');
});

test('Java definitions return project declarations, overloads and exact lines, never calls or comments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coding-java-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  const source = ['package demo;', 'public class Main {', '  // void run() {}', '  String s = "void run() {}";',
    '  public void run() { other.run(); run(); }', '  public <T> T run(', '      T value) throws Exception { return value; }',
    '  Runnable task = () -> { run(); };', '  class Nested { void run() {} }', '}',
    'interface Worker { void run(); }', 'record Item(String value) { public String run() { return value; } }'].join('\n');
  await writeFile(join(root, 'src/Main.java'), source);
  await mkdir(join(root, 'target'));
  await writeFile(join(root, 'target/Fake.java'), 'class Main {}');
  await symlink(join(root, 'src/Main.java'), join(root, 'Linked.java'));
  const workspace = await Workspace.open(root);
  assert.deepEqual((await definitions(workspace, { name: 'Main' })).candidates.map(({ kind, path, line }) =>
    ({ kind, path, line })), [{ kind: 'class', path: 'src/Main.java', line: 2 }]);
  const methods = await definitions(workspace, { name: 'run' });
  assert.deepEqual(methods.candidates.map(candidate => candidate.line), [5, 6, 9, 11, 12]);
  assert.ok(methods.candidates.every(candidate => candidate.kind === 'method'));
  assert.equal(methods.truncated, false);
  assert.equal((await definitions(workspace, { name: 'Nested' })).candidates[0].line, 9);
  assert.equal((await definitions(workspace, { name: 'missing' })).candidates.length, 0);
  await assert.rejects(definitions(workspace, { name: '../oops' }), /标识符/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(definitions(workspace, { name: 'Main' }, controller.signal), { name: 'AbortError' });
  await writeFile(join(root, 'src/Many.java'), `class Many { ${'void run() {} '.repeat(101)} }`);
  assert.equal((await definitions(workspace, { name: 'run' })).truncated, true);
});

test('Java method annotations with values do not hide definitions; enum constructor calls are not methods', async () => {
  const source = ['class Service {', '  @Route(value="/run", methods={"GET", "POST"})',
    '  public void run() {}', '  @Route(value="/other") public void run(int n) {}', '}', 'enum Choice { FIRST(), run(); Choice() {} }'].join('\n');
  const workspace = { list: async () => ({ entries: [{ name: 'Service.java', path: 'Service.java' }] }), text: async () => source };
  assert.deepEqual((await definitions(workspace, { name: 'run' })).candidates.map(candidate => candidate.line), [3, 4]);
});

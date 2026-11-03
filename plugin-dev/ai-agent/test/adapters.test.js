import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createCodexAdapter } from '../src/main/common/adapters/codex.js';
import { createClaudeAdapter } from '../src/main/common/adapters/claude.js';
import { createCustomCliAdapter } from '../src/main/common/adapters/custom-cli.js';
import { temporaryStore } from '../../../desk/test/helpers.js';

test('Codex restoration explicitly selects the saved working directory after a project move', () => {
  const cwd = '/new workspace/project';
  for (const mode of ['resume', 'fork']) {
    const { args } = createCodexAdapter().buildLaunch({ mode, cwd, contextId: 'original-thread', sessionDataDir: '/tmp/session' });
    assert.ok(args.includes('--cd'));
    assert.equal(args[args.indexOf('--cd') + 1], cwd);
    assert.deepEqual(args.slice(-2), [mode, 'original-thread']);
  }
  const fresh = createCodexAdapter().buildLaunch({ mode: 'new', cwd, sessionDataDir: '/tmp/session' });
  assert.equal(fresh.args.includes('--cd'), false);
});

test('native launches preserve group role instructions in fresh and restored contexts', () => {
  const roleInstructions = '工作台会话组："开发组"\n普通进度只保存在本地';
  for (const mode of ['new', 'resume', 'fork']) {
    const launch = createCodexAdapter().buildLaunch({ mode, contextId: 'thread', sessionDataDir: '/tmp/session', roleInstructions });
    assert.ok(launch.args.includes(`developer_instructions=${JSON.stringify(roleInstructions)}`));
    if (mode !== 'new') { assert.deepEqual(launch.args.slice(-2), [mode, 'thread']); }
  }
  for (const mode of ['new', 'resume']) {
    const launch = createClaudeAdapter().buildLaunch({ mode, contextId: 'thread', sessionDataDir: '/tmp/session', roleInstructions });
    assert.equal(launch.args[launch.args.indexOf('--append-system-prompt') + 1], roleInstructions);
    assert.deepEqual(launch.args.slice(-2), mode === 'resume' ? ['--resume', 'thread'] : ['--session-id', 'session']);
  }
});

test('Codex offers the three native approval modes with explicit reviewer and sandbox settings', () => {
  const adapter = createCodexAdapter();
  assert.deepEqual(adapter.permissionModes, [
    { id: 'request-approval', label: '请求批准', description: '编辑外部文件和使用互联网时始终询问' },
    { id: 'approve-for-me', label: '帮我批准', description: '仅对检测到的风险操作请求批准' },
    { id: 'unrestricted', label: '完全访问权限', description: '可不受限制地访问互联网和你电脑上的任何文件' }
  ]);
  const expected = {
    'request-approval': ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '-c', 'approvals_reviewer="user"',
      '-c', 'sandbox_workspace_write.network_access=false'],
    'approve-for-me': ['--approve-for-me', '-c', 'sandbox_workspace_write.network_access=false'],
    unrestricted: ['--dangerously-bypass-approvals-and-sandbox']
  };
  for (const [permission, args] of Object.entries(expected)) {
    for (const mode of ['new', 'resume', 'fork']) {
      const launch = adapter.buildLaunch({ permission, mode, contextId: 'thread-id', sessionDataDir: '/tmp/session' });
      assert.deepEqual(launch.args, [...args, '-c', 'log_dir="/tmp/session"', ...(mode === 'new' ? [] : [mode, 'thread-id'])]);
    }
  }
  assert.deepEqual(adapter.buildLaunch({ sessionDataDir: '/tmp/session' }).args,
    [...expected['request-approval'], '-c', 'log_dir="/tmp/session"']);
  assert.throws(() => adapter.buildLaunch({ permission: 'unknown' }), /不支持此权限模式/);
  assert.throws(() => adapter.buildLaunch({ mode: 'resume', sessionDataDir: '/tmp/session' }), /上下文/);
});

test('Codex permissions, exact restore/fork context, chunked states and root conversation', async (t) => {
  const store = await temporaryStore(t);
  const adapter = createCodexAdapter({});
  const permissions = {
    default: [],
    'read-only': ['--sandbox', 'read-only', '--ask-for-approval', 'never'],
    'workspace-write': ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
    'full-access': ['--sandbox', 'danger-full-access', '--ask-for-approval', 'on-request']
  };
  for (const [permission, args] of Object.entries(permissions)) {
    const launch = adapter.buildLaunch({ permission, sessionDataDir: store.root, mode: 'resume', contextId: 'thread-id' });
    assert.deepEqual(launch.args, [...args, '-c', `log_dir=${JSON.stringify(store.root)}`, 'resume', 'thread-id']);
    assert.equal(launch.command, 'codex');
  }
  assert.deepEqual(adapter.buildLaunch({ sessionDataDir: store.root, mode: 'fork', contextId: 'x' }).args.slice(-2), ['fork', 'x']);
  const state = {};
  Object.assign(state, adapter.parseActivity(state, '\x1b]7501;app=codex:state=blo'));
  assert.equal(state.activity, 'unknown');
  Object.assign(state, adapter.parseActivity(state, 'cked:kind=permission\x07'));
  assert.equal(state.blocked, 'permission');
  Object.assign(state, adapter.parseActivity(state, '\r\nordinary redraw'));
  assert.equal(state.blocked, 'permission');
  Object.assign(state, adapter.parseActivity(state, '\x1b]7501;app=codex:state=working\x07'));
  assert.equal(state.activity, 'working');
  assert.equal(state.blocked, null);
  const thread = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const root = (id) => `INFO session_loop{thread_id=${id}}: codex_core::session: new\n`;
  const persistence = (ephemeral) => 'INFO thread_spawn{otel.name="thread_spawn"}:session_init:'
    + `session_init.thread_persistence{otel.name="session_init.thread_persistence" session_init.ephemeral=${ephemeral}}: `
    + 'codex_core::session::session: new\n';
  const background = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const next = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let log = persistence(false) + root(thread)
    + `INFO tool_call{}:session_loop{thread_id=${background}}: codex_core::session: new\n`
    + persistence(true) + root(background);
  await writeFile(`${store.root}/codex-tui.log`, log);
  assert.equal(await adapter.resolveContext({ sessionDataDir: store.root }), thread);
  log += persistence(false) + root(next) + persistence(true) + root(background);
  await writeFile(`${store.root}/codex-tui.log`, log);
  assert.equal(await adapter.resolveContext({ sessionDataDir: store.root }), next, 'native /new selects the latest persisted root');
  await writeFile(`${store.root}/codex-tui.log`, log + root(thread));
  assert.equal(await adapter.resolveContext({ sessionDataDir: store.root }), undefined, 'unclassified later roots are ambiguous');
  await writeFile(`${store.root}/codex-tui.log`, persistence(false) + persistence(true) + root(thread) + root(background));
  assert.equal(await adapter.resolveContext({ sessionDataDir: store.root }), undefined, 'interleaved initializations cannot be paired safely');
  await writeFile(`${store.root}/codex-tui.log`, root(thread));
  assert.equal(await adapter.resolveContext({ sessionDataDir: store.root }), thread, 'a single legacy root is supported');
});

test('persisted Codex subagents do not clear or replace the foreground context', async t => {
  const store = await temporaryStore(t);
  const thread = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const child = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const initialization = 'thread_spawn{otel.name="thread_spawn"}:session_init:'
    + 'session_init.thread_persistence{otel.name="session_init.thread_persistence" session_init.ephemeral=false}: '
    + 'codex_core::session::session: new\n';
  const root = id => `INFO session_loop{thread_id=${id}}: codex_core::session: new\n`;
  await writeFile(`${store.root}/codex-tui.log`, `INFO ${initialization}${root(thread)}`
    + `INFO session_loop{thread_id=${thread}}:submission_dispatch{codex.op="turn_input"}:${initialization}${root(child)}`);
  assert.equal(await createCodexAdapter().resolveContext({ sessionDataDir: store.root }), thread);
});

test('custom CLI preserves argv and advertises no invented advanced capability', () => {
  const adapter = createCustomCliAdapter({ command: '/tmp/a b', args: ['hello world', '$(never)'] });
  assert.deepEqual(adapter.buildLaunch({}).args, ['hello world', '$(never)']);
  assert.equal(adapter.capabilities.fork, false);
  assert.equal(adapter.capabilities.restore, false);
  assert.throws(() => adapter.buildLaunch({ mode: 'fork' }), /支持/);
});

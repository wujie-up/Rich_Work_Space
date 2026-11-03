const test = require('node:test');
const assert = require('node:assert/strict');
const { configuration, start } = require('./server.cjs');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const env = { APP_ID: 'app-id', APP_SECRET: ' app-secret ',
  FEISHU_DOC_ENGINE_DIR: '/owned/runtime/node_modules/@larksuiteoapi/lark-mcp', FEISHU_DOC_DATA_DIR: '/owned/feishu-doc' };

test('OAuth user mode exposes exactly document read and wiki resolution without copying global configuration', () => {
  const config = configuration({ ...env, NODE_OPTIONS: '--require=/other/global-hook.cjs', LARK_TOOLS: 'preset.default' });
  assert.deepEqual(config.options.tools, ['docx.v1.document.rawContent', 'wiki.v2.space.getNode']);
  assert.equal(config.options.oauth, true);
  assert.equal(config.options.tokenMode, 'user_access_token');
  assert.equal(config.options.mode, 'stdio');
  assert.equal(config.options.domain, 'https://open.feishu.cn');
  assert.equal(config.options.appSecret, ' app-secret ');
  assert.equal(config.options.language, 'zh');
  assert.equal(config.options.host, 'localhost');
  assert.equal(config.options.port, '3000');
  assert.equal(config.options.NODE_OPTIONS, undefined);
  assert.equal(config.engine, env.FEISHU_DOC_ENGINE_DIR);
  assert.equal(config.data, env.FEISHU_DOC_DATA_DIR);
});

test('explicit user token disables OAuth flow without falling back to tenant credentials', () => {
  const { options } = configuration({ ...env, USER_ACCESS_TOKEN: 'user-token' });
  assert.equal(options.userAccessToken, 'user-token');
  assert.equal(options.oauth, false);
  assert.equal(options.tokenMode, 'user_access_token');
});

test('missing credentials and nonabsolute or overlapping runtime/data paths are rejected', () => {
  for (const patch of [{ APP_ID: '' }, { APP_SECRET: '' }, { FEISHU_DOC_ENGINE_DIR: '' },
    { FEISHU_DOC_ENGINE_DIR: './runtime' }, { FEISHU_DOC_DATA_DIR: './auth' },
    { FEISHU_DOC_DATA_DIR: env.FEISHU_DOC_ENGINE_DIR },
    { FEISHU_DOC_DATA_DIR: env.FEISHU_DOC_ENGINE_DIR + '/auth' }]) {
    assert.throws(() => configuration({ ...env, ...patch }), /配置/);
  }
});

test('start relocates official auth and logger state before their modules initialize', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = join(root, 'engine');
  const data = join(root, 'private');
  const capture = join(root, 'capture.json');
  for (const directory of ['dist/utils', 'dist/auth', 'dist/mcp-server']) {
    await mkdir(join(engine, directory), { recursive: true });
  }
  await writeFile(join(engine, 'package.json'), JSON.stringify({ name: '@larksuiteoapi/lark-mcp', version: '0.5.1' }));
  await writeFile(join(engine, 'dist/utils/constants.js'), 'exports.ENV_PATHS = { data: "/original-data", log: "/original-log" };');
  await writeFile(join(engine, 'dist/auth/config.js'), `
    const assert = require('node:assert/strict');
    const paths = require('../utils/constants.js').ENV_PATHS;
    assert.equal(paths.data, ${JSON.stringify(join(data, 'data'))});
    assert.equal(paths.log, ${JSON.stringify(join(data, 'log'))});
    exports.AUTH_CONFIG = { SERVER_NAME: 'lark-mcp', STORAGE_DIR: paths.data };
  `);
  await writeFile(join(engine, 'dist/mcp-server/index.js'), `
    const assert = require('node:assert/strict');
    const auth = require('../auth/config.js').AUTH_CONFIG;
    assert.equal(auth.SERVER_NAME, 'work-desk.feishu-doc');
    assert.equal(auth.STORAGE_DIR, ${JSON.stringify(join(data, 'data'))});
    exports.initMcpServerWithTransport = async (type, options) => {
      require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({type, tools: options.tools,
        oauth: options.oauth, mode: options.mode, tokenMode: options.tokenMode}));
    };
  `);
  await start({ ...env, FEISHU_DOC_ENGINE_DIR: engine, FEISHU_DOC_DATA_DIR: data });
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), { type: 'oapi',
    tools: ['docx.v1.document.rawContent', 'wiki.v2.space.getNode'], oauth: true,
    mode: 'stdio', tokenMode: 'user_access_token' });
});

test('an unverified official version is rejected before loading its runtime modules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = join(root, 'engine');
  await mkdir(engine);
  await writeFile(join(engine, 'package.json'), JSON.stringify({ name: '@larksuiteoapi/lark-mcp', version: '0.6.0' }));
  await assert.rejects(start({ ...env, FEISHU_DOC_ENGINE_DIR: engine, FEISHU_DOC_DATA_DIR: join(root, 'private') }), /0\.5\.1/);
});

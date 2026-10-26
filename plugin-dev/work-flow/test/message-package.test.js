import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withPackageSource, inspectPackage } from '../../../desk/src/main/common/plugin-package.js';

test('分发包离开仓库仍可加载真实 SDK 和 gRPC 资源，不包含开发资料', async t => {
  const manifest = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url)));
  const archive = resolve(`plugin-dev/dist/work-flow-${manifest.version}.plg`);
  const temp = await mkdtemp(join(tmpdir(), 'workflow-package-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await withPackageSource(archive, async source => {
    const { cp } = await import('node:fs/promises');
    await cp(source, join(temp, 'plugin'), { recursive: true });
  });
  const root = join(temp, 'plugin');
  assert.equal((await inspectPackage(root)).version, manifest.version);
  const names = await readdir(root);
  assert.ok(!names.some(name => ['test', 'build', 'plugin-data', 'session-test'].includes(name)));
  await access(join(root, 'node_modules/google-protobuf/LICENSE.md'));
  const packaged = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(packaged.version, manifest.version);
  assert.match(await readFile(join(root, 'plugin.json'), 'utf8'), /停止消息监听/);
  const files = await readdir(join(root, 'src'), { recursive: true });
  for (const file of files.filter(name => name.endsWith('.js'))) {
    assert.doesNotMatch(await readFile(join(root, 'src', file), 'utf8'), /fixture-secret-token|secret-token/);
  }
  await writeFile(join(root, 'probe.mjs'), `
    import { createRequire } from 'node:module';
    import { access } from 'node:fs/promises';
    import { dirname, join } from 'node:path';
    import assert from 'node:assert/strict';
    const require = createRequire(import.meta.url);
    const wechaty = await import('wechaty');
    const service = await import('wechaty-puppet-service');
    const feishu = await import('@larksuiteoapi/node-sdk');
    const grpc = await import('wechaty-grpc');
    assert.equal(typeof wechaty.WechatyBuilder.build, 'function');
    assert.equal(typeof service.PuppetService, 'function');
    assert.equal(typeof feishu.WSClient, 'function');
    assert.ok(grpc);
    assert.equal(typeof (await import('./src/main/common/message-wechat.js')).createWechatReceiver, 'function');
    assert.equal(typeof (await import('./src/main/common/message-feishu.js')).createFeishuReceiver, 'function');
    const { createWechatSdk } = await import('./src/main/common/message-wechat.js');
    const sdk = await createWechatSdk({ connection: { token: 'test-token' }, dataDirectory: './session-test' });
    assert.equal(sdk.textType, 7);
    const { activate, deactivate } = await import('./src/main/common/index.js');
    const values = new Map();
    const methods = new Map();
    let lifecycle;
    await activate({pluginId:'work-flow',capabilities:{},emit(){},
      storage:{readJson:async (key,fallback)=>values.get(key) ?? fallback,writeJson:async (key,value)=>values.set(key,value)},
      methods:{register:(name,handler)=>methods.set(name,handler)},services:{register(){}},views:{register(){}},
      lifecycle:{register:value=>{lifecycle=value;}}});
    assert.deepEqual(await methods.get('messages.connections.list')(),[]);
    await lifecycle.stop('package-test');
    await deactivate();
    console.log('runtime-closure-ok');
  `);
  const result = execFileSync(process.execPath, ['probe.mjs'], { cwd: root, env: { ...process.env, NODE_PATH: '' }, timeout: 30000 });
  assert.match(String(result), /runtime-closure-ok/);
});

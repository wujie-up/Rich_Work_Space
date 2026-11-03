const fs = require('node:fs');
const path = require('node:path');

function configuration(env = process.env) {
  const engine = env.FEISHU_DOC_ENGINE_DIR;
  const data = env.FEISHU_DOC_DATA_DIR;
  if (!env.APP_ID?.trim() || !env.APP_SECRET || !engine || !data || !path.isAbsolute(engine) || !path.isAbsolute(data)
    || engine.includes('\0') || data.includes('\0')) {
    throw Error('配置 App ID、App Secret、官方运行库与独立数据目录的绝对路径');
  }
  const relative = path.relative(path.resolve(engine), path.resolve(data));
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw Error('配置的数据目录必须独立于官方运行库，避免升级覆盖授权');
  }
  const userAccessToken = env.USER_ACCESS_TOKEN?.trim();
  return { engine: path.resolve(engine), data: path.resolve(data), options: {
    appId: env.APP_ID.trim(), appSecret: env.APP_SECRET,
    ...(userAccessToken ? { userAccessToken } : {}),
    domain: 'https://open.feishu.cn', mode: 'stdio', language: 'zh', toolNameCase: 'snake',
    tokenMode: 'user_access_token', oauth: !userAccessToken, host: 'localhost', port: '3000',
    tools: ['docx.v1.document.rawContent', 'wiki.v2.space.getNode']
  } };
}

async function start(env = process.env) {
  const config = configuration(env);
  const manifest = JSON.parse(fs.readFileSync(path.join(config.engine, 'package.json'), 'utf8'));
  if (manifest.name !== '@larksuiteoapi/lark-mcp' || manifest.version !== '0.5.1') {
    throw Error('运行库必须为已验证的 @larksuiteoapi/lark-mcp 0.5.1');
  }
  const constants = require(path.join(config.engine, 'dist/utils/constants.js'));
  // Set official paths before loading auth/logger singletons; never read the original global OAuth store.
  for (const key of ['data', 'config', 'cache', 'log', 'temp']) {
    const directory = path.join(config.data, key);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    constants.ENV_PATHS[key] = directory;
  }
  const { AUTH_CONFIG } = require(path.join(config.engine, 'dist/auth/config.js'));
  AUTH_CONFIG.SERVER_NAME = 'work-desk.feishu-doc';
  AUTH_CONFIG.STORAGE_DIR = constants.ENV_PATHS.data;
  const { initMcpServerWithTransport } = require(path.join(config.engine, 'dist/mcp-server/index.js'));
  process.stderr.write('[info] service=feishu-doc action=start backend=0.5.1 tools=document-read,wiki-resolve\n');
  await initMcpServerWithTransport('oapi', config.options);
}

module.exports = { configuration, start };

if (require.main === module) {
  start().catch(() => {
    process.stderr.write('[error] service=feishu-doc code=START_FAILED 请检查应用配置、独立数据目录及官方运行库0.5.1\n');
    process.exitCode = 1;
  });
}

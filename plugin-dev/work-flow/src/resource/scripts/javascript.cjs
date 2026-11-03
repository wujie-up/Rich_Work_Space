const { createWriteStream } = require('node:fs');

async function main() {
  let body = '';
  for await (const chunk of process.stdin) {
    body += chunk;
  }
  let result;
  try {
    const { code, input, params } = JSON.parse(body);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const value = await new AsyncFunction('input', 'params', `"use strict";\n${code}`)(input, params);
    if (value === undefined) {
      throw Error('脚本必须return一个JSON值；无结果时请return null');
    }
    result = JSON.stringify({ ok: true, value }, (_key, entry) => {
      if (typeof entry === 'number' && !Number.isFinite(entry)) {
        throw Error('脚本结果包含非有限数值');
      }
      return entry;
    });
  } catch (error) {
    result = JSON.stringify({ ok: false, error: String(error.stack || error).slice(0, 8192) });
  }
  await new Promise(resolve => process.stdout.write('', resolve));
  await new Promise(resolve => process.stderr.write('', resolve));
  // A dedicated pipe separates the result protocol from console output.
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(null, { fd: 3 });
    stream.on('error', reject);
    stream.end(result + '\n', resolve);
  });
  process.exit(0);
}
main().catch(() => process.exit(1));

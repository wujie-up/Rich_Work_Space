import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Share only the system network route, never shell settings or provider credentials.
export async function engineNetworkEnvironment() {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
  const { stdout } = await execute('/usr/sbin/scutil', ['--proxy'], { env });
  const value = name => stdout.match(new RegExp(`\\b${name}\\s*:\\s*(\\S+)`))?.[1];
  const address = value('HTTPSEnable') === '1' && value('HTTPSProxy') && value('HTTPSPort')
    ? `http://${value('HTTPSProxy')}:${value('HTTPSPort')}` : null;
  return address ? { HTTPS_PROXY: address, HTTP_PROXY: address, NO_PROXY: '127.0.0.1,localhost,::1' } : {};
}

export async function downloadEngine(url, destination) {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', ...await engineNetworkEnvironment() };
  const proxy = env.HTTPS_PROXY ? ['--proxy', env.HTTPS_PROXY] : [];
  await execute('/usr/bin/curl', ['--disable', '--fail', '--location', '--silent', '--show-error',
    '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '30', '--max-time', '300',
    ...proxy, '--output', destination, url], { env, timeout: 310000, maxBuffer: 65536 });
}

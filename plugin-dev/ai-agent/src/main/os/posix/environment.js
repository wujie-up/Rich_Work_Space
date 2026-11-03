// GUI launches may omit package managers from PATH; keep local helpers reachable without loading shell profiles.
export function executablePath(platformPaths = []) {
  return [...new Set([...(process.env.PATH || '').split(':'), ...platformPaths,
    '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(path => path.startsWith('/')))].join(':');
}

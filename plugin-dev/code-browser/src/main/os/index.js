const implementation = { darwin: './mac/index.js', linux: './linux/index.js' }[process.platform];
const platform = implementation ? await import(implementation) : null;

export function launch(command, args, cwd, env) {
  if (!platform) {
    throw Error('进程任务目前仅提供 macOS/Linux 实现');
  }
  return platform.launch(command, args, cwd, env);
}

export function terminate(child, signal) {
  platform.terminate(child, signal);
}

const implementations = { darwin: () => import('./mac/scripts.js'), linux: () => import('./linux/scripts.js') };

export async function scriptPlatform() {
  const load = implementations[process.platform];
  if (!load) {
    throw Error('当前系统尚未实现脚本进程管理');
  }
  return load();
}

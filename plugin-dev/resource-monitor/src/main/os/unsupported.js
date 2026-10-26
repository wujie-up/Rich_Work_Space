export function createPlatform() {
  return { async sample() {
    return { time: Date.now(), cores: 1, processes: null, network: null,
      processError: '当前平台尚未支持资源采集', networkError: '当前平台尚未支持网络采集' };
  }, async close() {} };
}

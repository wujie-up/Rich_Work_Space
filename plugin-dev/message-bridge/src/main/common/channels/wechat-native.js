import { connect } from 'node:net';

export function nativeGatewayOptions(channel) {
  const endpoint = channel.endpoint?.trim() || '127.0.0.1:18401';
  const address = /^(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/.exec(endpoint);
  if (!address || Number(address[2]) < 1 || Number(address[2]) > 65535) {
    throw Error('本机网关地址仅支持 127.0.0.1、localhost 或 [::1] 的 host:port');
  }
  // Plain gRPC is restricted to loopback; remote Puppet Service keeps its existing TLS configuration.
  return { endpoint, token: channel.token?.trim(), tls: { disable: true, serverName: address[1].replace(/^\[|\]$/g, '') } };
}

export async function checkNativeGateway(channel, signal) {
  const options = nativeGatewayOptions(channel);
  const port = Number(options.endpoint.slice(options.endpoint.lastIndexOf(':') + 1));
  await new Promise((resolve, reject) => {
    const socket = connect({ host: options.tls.serverName, port, signal });
    socket.setTimeout(3000, () => socket.destroy(Error('Local gateway connection timed out')));
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}

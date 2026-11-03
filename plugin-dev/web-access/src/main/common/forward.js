import net from 'node:net';
import { once } from 'node:events';
import { within } from './protocol.js';

// The only socket destination is a Web-owned local broker, never a remote-supplied address.
export async function forward(stream, grant, serviceId, consume, sockets) {
  const socket = net.connect(grant.path);
  sockets.add(socket);
  socket.on('error', () => socket.destroy());
  try {
    await within(once(socket, 'connect'), 3000);
    socket.write(JSON.stringify({ capability: grant.capability, serviceId }) + '\n');
    const [ack] = await within(once(socket, 'data'), 3000);
    if (ack.toString() !== 'OK\n') { throw Error('工作台服务传输握手失败'); }
    await Promise.all([
      (async () => {
        for await (const chunk of socket) {
          consume(chunk.length);
          await stream.send.writeAll([...chunk]);
        }
        await stream.send.finish();
      })(),
      (async () => {
        while (true) {
          const chunk = Buffer.from(await stream.recv.read(65536));
          if (!chunk.length) { break; }
          consume(chunk.length);
          if (!socket.write(chunk)) { await once(socket, 'drain'); }
        }
        socket.end();
      })()
    ]);
  } finally {
    sockets.delete(socket);
    socket.destroy();
    await Promise.allSettled([stream.send.reset(0n), stream.recv.stop(0n)]);
  }
}

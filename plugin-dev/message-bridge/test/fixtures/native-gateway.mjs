import { createServer } from 'node:net';
import { Puppet, types } from 'wechaty-puppet';
import { PuppetServer } from 'wechaty-puppet-service';

// This fixture speaks real gRPC but supplies synthetic client data; it never opens the user's WeChat account.
class GatewayPuppet extends Puppet {
  messages = new Map();
  sent = [];
  async onStart() { await this.login('fixture-self'); }
  async onStop() {}
  async contactList() { return ['fixture-self', 'alice']; }
  async contactRawPayload(id) { return { id, name: id, type: types.Contact.Individual, gender: types.ContactGender.Unknown }; }
  async contactRawPayloadParser(payload) { return payload; }
  async roomList() { return ['group']; }
  async roomRawPayload(id) { return { id, topic: 'Fixture group', memberIdList: ['fixture-self', 'alice'], adminIdList: [] }; }
  async roomRawPayloadParser(payload) { return payload; }
  async roomMemberList() { return ['fixture-self', 'alice']; }
  async roomMemberRawPayload(_roomId, id) { return { id, name: id }; }
  async roomMemberRawPayloadParser(payload) { return payload; }
  async messageRawPayload(id) { return this.messages.get(id); }
  async messageRawPayloadParser(payload) { return payload; }
  async messageSendText(chatId, text) { this.sent.push({ chatId, text }); return undefined; }
  receive(source) {
    this.messages.set(source.messageId, { id: source.messageId, talkerId: source.senderId, listenerId: 'fixture-self',
      ...(source.chatType === 'group' ? { roomId: source.chatId } : {}), text: source.text, timestamp: source.sentAt,
      type: types.Message.Text, mentionIdList: [] });
    this.emit('message', { messageId: source.messageId });
  }
}

export async function nativeGateway(t) {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const endpoint = `127.0.0.1:${socket.address().port}`;
  await new Promise(resolve => socket.close(resolve));
  const puppet = new GatewayPuppet();
  const token = 'fixture-native-token';
  const server = new PuppetServer({ endpoint, puppet, token, tls: { disable: true } });
  await server.start();
  t.after(async () => { await server.stop(); await puppet.stop(); });
  return { puppet, channel: { puppet: 'native', endpoint, token } };
}

export async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) { throw Error('Fixture condition timed out'); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

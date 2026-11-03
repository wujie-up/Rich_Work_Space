import { randomUUID } from 'node:crypto';
import { BridgeStore } from './store.js';
import { bindingKey, matchRoute, messageKey, splitText } from './router.js';
import { wechatPuppetProvider } from './channels/wechat.js';
import { nativeGatewayOptions } from './channels/wechat-native.js';

const terminal = exchange => ['completed', 'failed', 'cancelled', 'interrupted'].includes(exchange.state);
const privateFields = ['appSecret', 'token', 'botToken', 'contextToken', 'cursor'];
const cleanChannel = channel => Object.fromEntries(Object.entries(channel).filter(([key]) => !privateFields.includes(key)));
const shape = route => JSON.stringify({ ...route, enabled: undefined, name: undefined, version: undefined });

export class MessageBridge {
  constructor(options) {
    Object.assign(this, options);
    this.now ||= Date.now;
    this.config = new BridgeStore(this.storage, this.pluginId, 'config', { channels: [], routes: [] });
    this.store = new BridgeStore(this.storage, this.pluginId, 'bridge-state', { exchanges: {}, bindings: {}, deliveries: {}, replies: {}, sources: {} });
    this.channels = new Map();
    this.statuses = new Map();
    this.connections = new Map();
    this.channelEpochs = new Map();
    this.activeBindings = new Set();
    this.admissionVersion = 0;
  }

  async load() {
    await this.config.load();
    await this.store.load();
    await this.store.edit(state => {
      Object.values(state.deliveries).filter(delivery => delivery.state === 'sending').forEach(delivery => { delivery.state = 'uncertain'; });
      Object.values(state.replies).filter(reply => reply.state === 'sending').forEach(reply => { reply.state = 'uncertain'; });
    });
  }

  snapshot() {
    const { exchanges, deliveries, bindings } = this.store.value;
    return { channels: this.config.value.channels.map(channel => ({ ...cleanChannel(channel), configured: Boolean(channel.appSecret || channel.token || channel.botToken),
      status: this.statuses.get(channel.id) || { state: channel.enabled ? 'stopped' : 'disabled' } })),
    sources: structuredClone(Object.values(this.store.value.sources || {})),
    routes: structuredClone(this.config.value.routes), bindings: structuredClone(Object.values(bindings)),
    exchanges: Object.values(exchanges).map(({ text, source, ...exchange }) => ({ ...exchange,
      source: { channelId: source.channelId, chatId: source.chatId, senderId: source.senderId, messageId: source.messageId, chatType: source.chatType } }))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
    deliveries: Object.values(deliveries).map(({ text, ...delivery }) => delivery).slice(-200) };
  }

  publish() { this.emit('bridge.changed', { at: this.now() }); }

  status(channelId, status) {
    this.statuses.set(channelId, status);
    this.publish();
  }

  async saveChannel(input) {
    if (!['feishu', 'weixin-bot', 'wechat'].includes(input.type)) { throw Error('不支持的渠道类型'); }
    if (input.id && !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) { throw Error('渠道 ID 格式不正确'); }
    const previous = this.config.value.channels.find(channel => channel.id === input.id);
    const channel = { ...previous, ...input, id: previous?.id || input.id || randomUUID() };
    for (const field of privateFields) {
      if (previous && input[field] === '') { channel[field] = previous[field]; }
    }
    if (channel.type === 'wechat') {
      channel.puppet = wechatPuppetProvider(channel);
      if (channel.puppet === 'native') { channel.endpoint = nativeGatewayOptions(channel).endpoint; }
    }
    // An account replacement permanently closes exchanges whose response context belonged to the old account.
    if (previous && JSON.stringify(previous) !== JSON.stringify(channel)) { await this.closeSource(item => item.source.channelId === channel.id, 'channel_changed'); }
    await this.stopChannel(channel.id);
    await this.config.edit(config => { config.channels = config.channels.filter(item => item.id !== channel.id).concat(channel); });
    if (this.started && channel.enabled) { await this.connectChannel(channel); }
    this.publish();
    return cleanChannel(channel);
  }

  async removeChannel(id) {
    await this.closeSource(item => item.source.channelId === id, 'channel_removed');
    await this.stopChannel(id);
    await this.config.edit(config => { config.channels = config.channels.filter(channel => channel.id !== id); });
    this.publish();
  }

  async saveRoute(input) {
    if (!this.config.value.channels.some(channel => channel.id === input.channelId)) {
      throw Error('请选择渠道');
    }
    // Legacy allowlists retain their meaning until the user explicitly saves the simplified channel rule.
    if (input.sourceMode !== 'channel' && (!input.chatIds?.length || !input.senderIds?.length)) {
      throw Error('旧规则需要允许的会话 ID 和发送者 ID');
    }
    if (!['prefix', 'keyword', 'mention'].includes(input.trigger?.type) || input.trigger.type !== 'mention' && !input.trigger.value?.trim()) {
      throw Error('请填写有效的触发规则');
    }
    if (!['existing', 'dedicated'].includes(input.target?.mode) || input.target.mode === 'existing' && !input.target.targetRef) { throw Error('请选择目标会话'); }
    if (input.target.mode === 'dedicated' && input.executionPolicy?.mode !== 'readOnly') { throw Error('专属会话默认只读'); }
    const previous = this.config.value.routes.find(route => route.id === input.id);
    const route = { ...input, id: previous?.id || input.id || randomUUID(), priority: Number(input.priority || 0), scope: input.scope || 'sender',
      version: (previous?.version || 0) + 1 };
    if (previous && shape(previous) !== shape(route)) { await this.unbindRoute(previous.id); }
    await this.config.edit(config => { config.routes = config.routes.filter(item => item.id !== route.id).concat(route); });
    this.publish();
    return route;
  }

  async unbindRoute(routeId) {
    await this.closeSource(item => item.routeId === routeId, 'unbound', true);
    await this.config.edit(config => { config.routes.filter(route => route.id === routeId).forEach(route => { route.enabled = false; }); });
    this.publish();
  }

  async closeSource(predicate, reason, release = false) {
    this.admissionVersion++;
    const affected = Object.values(this.store.value.exchanges).filter(predicate);
    const bindings = Object.values(this.store.value.bindings).filter(binding => affected.some(item => item.bindingKey === binding.key));
    await this.store.edit(state => {
      for (const exchange of Object.values(state.exchanges).filter(predicate)) {
        Object.assign(exchange, { closed: true, closedAt: this.now(), closeReason: reason });
        if (!terminal(exchange)) { exchange.state = 'cancelled'; }
      }
      for (const delivery of Object.values(state.deliveries)) {
        if (state.exchanges[delivery.exchangeId]?.closed && ['pending', 'uncertain'].includes(delivery.state)) { delivery.state = 'cancelled'; }
      }
      if (release) { bindings.forEach(binding => { delete state.bindings[binding.key]; }); }
    });
    for (const binding of bindings) {
      this.activeBindings.delete(binding.key);
      try { await this.agent.call(release ? 'unbind' : 'suspend', { bindingId: binding.bindingId }); }
      catch (error) { this.error('suspend', error, { bindingId: binding.bindingId }); }
    }
  }

  async receive(source) {
    const admissionVersion = this.admissionVersion;
    if (this.stopped || source.self || source.system || !source.messageId || !source.senderId || !source.chatId
      || typeof source.text !== 'string' || source.text.length > 60000) { return null; }
    if (!this.config.value.channels.some(channel => channel.id === source.channelId && channel.enabled)) { return null; }
    if (Object.values(this.store.value.deliveries).some(delivery => delivery.channelId === source.channelId && delivery.messageId === source.messageId)) { return null; }
    await this.observeSource(source);
    const key = messageKey(source);
    const duplicate = this.store.value.exchanges[key];
    if (duplicate) { return { exchangeId: duplicate.id }; }
    if (/^\/reply\s/.test(source.text)) { return this.receiveReply(source, key); }
    const match = matchRoute(this.config.value.routes, source);
    if (!match || this.now() - source.sentAt > 600000) { return null; }
    const exchange = { id: key, requestKey: key, routeId: match.route.id, routeVersion: match.route.version,
      bindingKey: bindingKey(match.route, source), source, text: match.text, state: 'received', createdAt: this.now() };
    const admitted = await this.store.edit(state => {
      if (this.stopped || admissionVersion !== this.admissionVersion
        || !this.config.value.channels.some(channel => channel.id === source.channelId && channel.enabled)
        || !this.config.value.routes.some(route => route.id === match.route.id && route.version === match.route.version && route.enabled)) { return false; }
      // SDK callbacks may overlap; the durable unique key arbitrates before either callback acknowledges.
      state.exchanges[key] ||= exchange;
      return true;
    });
    if (!admitted) { return null; }
    console.info('[message-bridge:received]', { pluginId: this.pluginId, channelId: source.channelId, routeId: match.route.id, taskKey: key });
    this.publish();
    return { exchangeId: key };
  }

  async observeSource(source) {
    const key = JSON.stringify([source.channelId, source.chatType, source.chatId, source.senderId]);
    if (this.store.value.sources?.[key]) { return; }
    await this.store.edit(state => {
      state.sources ||= {};
      state.sources[key] = { channelId: source.channelId, chatType: source.chatType, chatId: source.chatId,
        senderId: source.senderId, seenAt: this.now() };
      const entries = Object.entries(state.sources);
      if (entries.length > 200) { delete state.sources[entries[0][0]]; }
    });
    this.publish();
  }

  async receiveReply(source, key) {
    const match = source.text.match(/^\/reply\s+(\S+)\s+([\s\S]+)$/);
    const exchange = match && Object.values(this.store.value.exchanges).find(item => !item.closed && item.pendingQuestion?.token === match[1]
      && item.source.channelId === source.channelId && item.source.chatId === source.chatId && item.source.chatType === source.chatType
      && item.source.senderId === source.senderId && this.now() - item.pendingQuestion.createdAt <= 600000);
    if (!exchange) { return null; }
    const entries = match[2].split(/[\n;]/).map(value => value.trim()).filter(Boolean);
    let answers = Object.fromEntries(entries.filter(value => value.includes('=')).map(value => [value.slice(0, value.indexOf('=')).trim(), value.slice(value.indexOf('=') + 1).trim()]));
    if (exchange.pendingQuestion.questions.length === 1 && !entries.some(value => value.includes('='))) {
      answers = { [exchange.pendingQuestion.questions[0].id]: match[2].trim() };
    }
    if (exchange.pendingQuestion.questions.some(question => !answers[question.id])) { throw Error('请使用问题 ID=答案，回答所有问题'); }
    await this.store.edit(state => {
      state.replies[key] ||= { key, exchangeId: exchange.id, taskId: exchange.taskId, requestId: exchange.pendingQuestion.requestId, answers, state: 'pending' };
    });
    return { exchangeId: exchange.id };
  }

  tick() {
    if (this.ticking) { return this.ticking; }
    this.ticking = this.tickOnce().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  async tickOnce() {
    if (this.stopped) { return; }
    if (!await this.agent.ready()) {
      if (this.hadAuthority) { await this.closeSource(() => true, 'authorization_revoked'); }
      this.hadAuthority = false;
      return;
    }
    this.hadAuthority = true;
    for (const exchange of Object.values(this.store.value.exchanges).filter(item => !item.closed && !terminal(item))) {
      try { await this.advance(exchange); }
      catch (error) { this.error('advance', error, { channelId: exchange.source.channelId, taskKey: exchange.id }); }
    }
    for (const reply of Object.values(this.store.value.replies).filter(item => item.state === 'pending')) {
      if (this.store.value.exchanges[reply.exchangeId].closed) { continue; }
      await this.store.edit(state => { state.replies[reply.key].state = 'sending'; });
      try {
        await this.agent.call('respond', { taskId: reply.taskId, requestId: reply.requestId, answers: reply.answers });
        await this.store.edit(state => {
          state.replies[reply.key].state = 'sent';
          delete state.exchanges[reply.exchangeId].pendingQuestion;
        });
      } catch (error) {
        await this.store.edit(state => { state.replies[reply.key].state = 'uncertain'; });
        this.error('respond', error, { taskKey: reply.exchangeId });
      }
    }
    await this.flushDeliveries();
    this.publish();
  }

  async advance(snapshot) {
    let exchange = this.store.value.exchanges[snapshot.id];
    const route = this.config.value.routes.find(item => item.id === exchange.routeId);
    // Semantic route changes close old exchanges; pausing only stops admission of new source messages.
    if (!route) { return; }
    if (exchange.state === 'received') {
      if (this.now() - exchange.createdAt > 600000) {
        await this.store.edit(state => { Object.assign(state.exchanges[exchange.id], { state: 'failed', error: '消息等待授权超时' }); });
        return;
      }
      const binding = await this.ensureBinding(exchange, route, true);
      if (this.stopped || this.store.value.exchanges[exchange.id].closed) { return; }
      await this.store.edit(state => { Object.assign(state.exchanges[exchange.id], { state: 'submitting', bindingId: binding.bindingId }); });
      try {
        const result = await this.agent.call('submit', { bindingId: binding.bindingId, requestKey: exchange.requestKey,
          sourceMessageKey: exchange.id, text: exchange.text });
        await this.store.edit(state => {
          if (!state.exchanges[exchange.id].closed) { Object.assign(state.exchanges[exchange.id], { taskId: result.taskId, state: result.state }); }
        });
      } catch (error) {
        await this.store.edit(state => {
          if (!state.exchanges[exchange.id].closed) {
            Object.assign(state.exchanges[exchange.id], { state: 'uncertain', error: '提交回执不确定，正在核对原请求' });
          }
        });
        throw error;
      }
    }
    exchange = this.store.value.exchanges[exchange.id];
    if (!exchange.bindingId || exchange.closed || this.stopped) { return; }
    await this.ensureBinding(exchange, route);
    const task = await this.agent.call('read', exchange.taskId ? { taskId: exchange.taskId } : { bindingId: exchange.bindingId, requestKey: exchange.requestKey });
    await this.store.edit(state => {
      const current = state.exchanges[exchange.id];
      if (current.closed) { return; }
      Object.assign(current, { taskId: task.taskId, state: task.state, queueReason: task.queueReason, error: task.error });
      if (task.closed) { Object.assign(current, { closed: true, closedAt: this.now(), closeReason: 'agent_closed' }); return; }
      if (task.state === 'completed') { this.enqueue(state, current, 'final', task.output || 'Agent 已完成，本轮没有文本结果。'); }
      else if (['failed', 'interrupted', 'cancelled', 'uncertain'].includes(task.state)) { this.enqueue(state, current, task.state, `Agent ${task.state}：${task.error || '请在工作台检查，避免重复执行。'}`); }
      const question = task.questions?.[0];
      if (question && (!current.pendingQuestion || current.pendingQuestion.requestId !== question.requestId)) {
        current.pendingQuestion = { ...question, token: randomUUID().slice(0, 8), createdAt: this.now() };
        this.enqueue(state, current, `question:${question.requestId}`, `${question.questions.map(item => `${item.id}: ${item.question}`).join('\n')}\n回复：/reply ${current.pendingQuestion.token} 问题ID=答案`);
      }
      if (task.localApproval) { this.enqueue(state, current, 'local-approval', 'Agent 需要本地权限确认，请到工作台处理。聊天回复不会授予执行权限。'); }
    });
  }

  async ensureBinding(exchange, route, renew = false) {
    let binding = this.store.value.bindings[exchange.bindingKey];
    if (!binding || renew || !this.activeBindings.has(binding.key)) {
      const resolved = await this.agent.call('bind', { bindingKey: exchange.bindingKey,
        sourceScope: { channelId: exchange.source.channelId, chatId: exchange.source.chatId,
          senderIds: route.scope === 'chat' ? route.senderIds : [exchange.source.senderId] }, target: route.target, executionPolicy: route.executionPolicy });
      binding = { key: exchange.bindingKey, bindingId: resolved.bindingId, routeId: route.id, targetRef: resolved.targetRef };
      await this.store.edit(state => { state.bindings[binding.key] = binding; });
      this.activeBindings.add(binding.key);
    }
    return binding;
  }

  async revoke() {
    await this.closeSource(() => true, 'authorization_revoked');
    await this.agent.revoke();
    this.hadAuthority = false;
    this.publish();
  }

  enqueue(state, exchange, kind, text) {
    splitText(text).forEach((chunk, index) => {
      const id = `${exchange.id}:${kind}:${index}`;
      state.deliveries[id] ||= { id, exchangeId: exchange.id, channelId: exchange.source.channelId, text: chunk,
        clientId: randomUUID(), kind, index, state: 'pending', createdAt: this.now() };
    });
  }

  async transport(channelId) {
    const channel = this.config.value.channels.find(item => item.id === channelId && item.enabled);
    if (!channel) { throw Error('渠道已禁用'); }
    return this.channels.get(channelId) || this.connectChannel(channel);
  }

  async loginChannel(id) {
    const channel = this.config.value.channels.find(item => item.id === id && item.enabled);
    if (!channel) { throw Error('渠道已禁用'); }
    // A deliberate re-login may switch accounts; never reuse an earlier account's reply contexts.
    if (channel.type === 'weixin-bot' && channel.botToken) {
      await this.closeSource(item => item.source.channelId === id, 'account_relogin');
      await this.stopChannel(id);
      await this.config.edit(config => {
        const record = config.channels.find(item => item.id === id);
        for (const field of ['botToken', 'botId', 'cursor', 'baseUrl']) { delete record[field]; }
      });
    }
    const transport = await this.transport(id);
    if (transport.login) { await transport.login(); }
    else { await this.stopChannel(id); await this.transport(id); }
  }

  async flushDeliveries() {
    for (const delivery of Object.values(this.store.value.deliveries).filter(item => item.state === 'pending')) {
      const exchange = this.store.value.exchanges[delivery.exchangeId];
      if (exchange.closed || this.stopped) { continue; }
      // A failed earlier chunk blocks later chunks so partial delivery never silently changes ordering.
      if (Object.values(this.store.value.deliveries).some(item => item.exchangeId === delivery.exchangeId && item.kind === delivery.kind
        && item.index < delivery.index && item.state !== 'sent')) { continue; }
      let channel;
      try { channel = await this.transport(delivery.channelId); }
      catch (error) { this.error('channel-unavailable', error, { channelId: delivery.channelId, deliveryId: delivery.id }); continue; }
      if (!await this.agent.ready()) { return; }
      const sending = await this.store.edit(state => {
        const current = state.deliveries[delivery.id];
        if (this.stopped || state.exchanges[delivery.exchangeId].closed || current.state !== 'pending') { return false; }
        current.state = 'sending';
        return true;
      });
      // Closing may have queued behind the send-intent write; use the latest snapshot immediately before sending.
      if (!sending || this.stopped || this.store.value.exchanges[delivery.exchangeId].closed) { continue; }
      try {
        const result = await channel.send({ source: exchange.source, text: delivery.text, clientId: delivery.clientId });
        await this.store.edit(state => { Object.assign(state.deliveries[delivery.id], { state: 'sent', messageId: result?.messageId, sentAt: this.now() }); });
      } catch (error) {
        await this.store.edit(state => { Object.assign(state.deliveries[delivery.id], { state: 'uncertain', error: '发送回执不确定，请先检查原聊天再决定重发' }); });
        this.error('send', error, { channelId: delivery.channelId, deliveryId: delivery.id });
      }
    }
  }

  async retryDelivery(id, acceptedDuplicateRisk = false) {
    if (!acceptedDuplicateRisk) { throw Error('重发可能产生重复消息，请先确认原聊天'); }
    await this.store.edit(state => {
      const delivery = state.deliveries[id];
      if (!delivery || delivery.state !== 'uncertain' || state.exchanges[delivery.exchangeId].closed) { throw Error('该发送记录不能重试'); }
      delivery.state = 'pending';
    });
  }

  connectChannel(channel) {
    if (this.stopped) { return Promise.reject(Error('插件正在关闭')); }
    if (this.connections.has(channel.id)) { return this.connections.get(channel.id); }
    const epoch = Symbol(channel.id);
    this.channelEpochs.set(channel.id, epoch);
    const current = () => !this.stopped && this.channelEpochs.get(channel.id) === epoch;
    const work = (async () => {
      const transport = await this.channelFactory({ channel, storage: this.storage, pluginId: this.pluginId,
        receive: source => current() ? this.receive({ ...source, channelId: channel.id }) : null,
        status: value => { if (current()) { this.status(channel.id, value); } },
        report: (action, error) => this.error(action, error, { channelId: channel.id }),
        credentials: patch => this.config.edit(config => {
          const record = config.channels.find(item => item.id === channel.id);
          if (current() && record) { Object.assign(record, patch); }
        }) });
      try {
        if (!current()) { throw Error('渠道已停止'); }
        this.channels.set(channel.id, transport);
        await transport.start();
        if (!current()) { throw Error('渠道已停止'); }
        return transport;
      } catch (error) {
        if (this.channels.get(channel.id) === transport) { this.channels.delete(channel.id); }
        await transport.stop();
        if (current()) { this.status(channel.id, { state: 'error', error: '渠道启动失败，请检查配置或重新登录' }); }
        throw error;
      }
    })();
    this.connections.set(channel.id, work);
    work.finally(() => { if (this.connections.get(channel.id) === work) { this.connections.delete(channel.id); } }).catch(() => {});
    return work;
  }

  async stopChannel(id) {
    this.channelEpochs.delete(id);
    const transport = this.channels.get(id);
    this.channels.delete(id);
    await transport?.stop();
    try { await this.connections.get(id); }
    catch (error) { this.error('channel-stop-pending', error, { channelId: id }); }
    this.statuses.delete(id);
  }

  error(action, error, fields = {}) {
    // SDK errors may contain response bodies or credentials; log only our stable operational label and stack locations.
    const stack = error.stack?.split('\n').slice(1).filter(line => /^\s+at /.test(line)).join('\n');
    console.error(`[message-bridge:${action}]`, { pluginId: this.pluginId, ...fields, stack });
  }

  async start() {
    this.started = true;
    for (const channel of this.config.value.channels.filter(item => item.enabled)) {
      try { await this.connectChannel(channel); }
      catch (error) { this.error('channel-start', error, { channelId: channel.id }); }
    }
    this.timer = setInterval(() => this.tick().catch(error => this.error('tick', error)), 1000);
    this.timer.unref();
  }

  async stop() {
    if (this.stopped) { return; }
    this.stopped = true;
    clearInterval(this.timer);
    // Close external interactions before draining in-flight calls, so a late result cannot create new deliveries.
    await this.closeSource(() => true, 'plugin_stopped');
    await this.ticking;
    for (const id of new Set([...this.channels.keys(), ...this.connections.keys()])) { await this.stopChannel(id); }
    await this.config.writes;
    await this.store.writes;
  }
}

// One instance belongs to one session; message identity is scoped to its conversational round.
export class AgentTranscript {
  constructor() {
    this.sequence = 0;
    this.round = 0;
    this.nextId = 0;
    this.messages = new Map();
    this.streaming = null;
  }

  add(event) {
    if (event.sequence && event.sequence <= this.sequence) { return null; }
    this.sequence = event.sequence || this.sequence;
    const params = event.params || {};
    const item = params.item;
    const user = event.method === 'user/message';
    const agent = event.method.includes('agentMessage') || item?.type === 'agentMessage';
    const delta = event.method.endsWith('/delta') && agent;
    const itemId = params.itemId || item?.id;
    if (user) { this.round += 1; }
    const key = itemId ? `${this.round}:${itemId}` : null;
    let entry = agent ? (key ? this.messages.get(key) : this.streaming) : null;
    if (!entry) {
      entry = { id: ++this.nextId, round: this.round, role: user ? 'user' : agent ? 'agent' : 'event',
        method: event.method, at: event.at, text: '' };
      if (agent && key) { this.messages.set(key, entry); }
    }
    const text = params.text ?? params.delta ?? item?.text ?? JSON.stringify(params, null, 2);
    entry.text = delta ? entry.text + text : text;
    this.streaming = delta ? entry : null;
    return entry;
  }
}

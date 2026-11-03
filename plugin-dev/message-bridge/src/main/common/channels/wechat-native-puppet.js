import { PuppetService } from 'wechaty-puppet-service';
import { join } from 'node:path';

// Keep the locked SDK's text protocol, while bounding its otherwise unlimited unary RPCs.
export class NativeWechatPuppet extends PuppetService {
  constructor(options, signal, cacheDirectory) {
    super(options);
    this.signal = signal;
    // SDK 1.18.2 otherwise shares ~/.wechaty by token, outside the plugin and channel data boundary.
    if (cacheDirectory) { this._payloadStore.storeDir = join(cacheDirectory, 'payload-v1.18'); }
  }

  async onStart() {
    try { await super.onStart(); }
    catch (error) {
      // SDK 1.18.2 stops itself after startup failure, but waits on its own pending state unless it is settled first.
      if (this.state.active() === 'pending') { this.state.active(true); }
      throw error;
    }
  }

  bridgeGrpcEventStream(manager) {
    const initialize = manager.initClient.bind(manager);
    manager.initClient = async () => {
      this.signal?.throwIfAborted();
      await initialize();
      const client = manager.client;
      // Reuse its authenticated channel; the public gRPC transformer leaves the long-lived event stream unbounded.
      manager._client = new client.constructor(manager.endpoint, undefined, {
        channelOverride: client.getChannel(),
        callInvocationTransformer: properties => {
          if (!properties.methodDefinition.requestStream && !properties.methodDefinition.responseStream) {
            const deadline = Math.min(Number(properties.callOptions.deadline ?? Infinity), Date.now() + 5000);
            properties.callOptions = { ...properties.callOptions, deadline };
          }
          return properties;
        }
      });
      const abort = () => { manager.stopStream(); manager.destroyClient(); };
      this.signal?.addEventListener('abort', abort, { once: true });
      this._cleanupCallbackList.push(() => this.signal?.removeEventListener('abort', abort));
      if (this.signal?.aborted) { abort(); this.signal.throwIfAborted(); }
    };
    super.bridgeGrpcEventStream(manager);
  }
}

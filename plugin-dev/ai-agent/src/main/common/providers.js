import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const publicProfile = ({ apiKey, ...profile }) => ({ ...profile, hasSecret: Boolean(apiKey) });

// Provider credentials stay in the plugin's private directory, never in renderer responses or session snapshots.
export class Providers {
  constructor({ root }) {
    this.root = root;
    this.pending = Promise.resolve();
  }

  async read() {
    try {
      return JSON.parse(await readFile(join(this.root, 'providers.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') { throw error; }
      return [];
    }
  }

  async list() {
    return (await this.read()).map(publicProfile);
  }

  update(change) {
    const next = this.pending.catch(() => {}).then(async () => {
      const profiles = await this.read();
      const result = change(profiles);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, `.providers-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(profiles, null, 2), { mode: 0o600 });
        await rename(temporary, join(this.root, 'providers.json'));
      } finally {
        await rm(temporary, { force: true });
      }
      return result;
    });
    this.pending = next;
    return next;
  }

  save(input) {
    return this.update(profiles => {
      const url = new URL(input.baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw Error('供应商地址必须是无凭据的 HTTP(S) 地址');
      }
      if (!input.name?.trim() || !input.model?.trim() || !['codex', 'claude'].includes(input.engineId)
        || input.protocol !== (input.engineId === 'codex' ? 'responses' : 'anthropic')) {
        throw Error('供应商名称、模型或引擎协议无效');
      }
      const previous = profiles.find(profile => profile.id === input.id);
      if (input.id && !previous) { throw Error('供应商已不存在，请重新选择'); }
      const profile = { id: previous?.id || randomUUID(), name: input.name.trim(), engineId: input.engineId,
        protocol: input.protocol, baseUrl: url.href.replace(/\/$/, ''), model: input.model.trim(),
        apiKey: input.clearSecret ? '' : input.apiKey || previous?.apiKey || '' };
      if (previous) { profiles.splice(profiles.indexOf(previous), 1, profile); }
      else { profiles.push(profile); }
      console.info('[ai:provider-saved]', { providerId: profile.id, engineId: profile.engineId });
      return publicProfile(profile);
    });
  }

  remove(id) {
    return this.update(profiles => {
      const index = profiles.findIndex(profile => profile.id === id);
      if (index >= 0) { profiles.splice(index, 1); }
      console.info('[ai:provider-removed]', { providerId: id });
    });
  }

  async profile(engineId, id) {
    const profile = (await this.read()).find(profile => profile.id === id);
    if (!profile) { throw Error('所选供应商已不存在，请在配置中重新选择'); }
    if (profile.engineId !== engineId) { throw Error('供应商不适用于当前引擎'); }
    if (!profile.apiKey) { throw Error('请配置供应商密钥'); }
    return profile;
  }

  async resolve(engineId, id, snapshot) {
    if (!id) { return { args: [], env: {}, provider: null }; }
    const stored = await this.profile(engineId, id);
    const profile = snapshot ? { ...stored, ...snapshot, id, apiKey: stored.apiKey } : stored;
    const provider = publicProfile(profile);
    delete provider.hasSecret;
    if (engineId === 'claude') {
      return { args: [], env: { ANTHROPIC_BASE_URL: profile.baseUrl, ANTHROPIC_AUTH_TOKEN: profile.apiKey,
        ANTHROPIC_MODEL: profile.model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, provider };
    }
    return { args: ['-c', 'model_provider="work_desk"', '-c', `model=${JSON.stringify(profile.model)}`,
      '-c', 'model_providers.work_desk.name="Work Desk"', '-c', `model_providers.work_desk.base_url=${JSON.stringify(profile.baseUrl)}`,
      '-c', 'model_providers.work_desk.env_key="WORK_DESK_PROVIDER_KEY"', '-c', 'model_providers.work_desk.wire_api="responses"'],
    env: { WORK_DESK_PROVIDER_KEY: profile.apiKey }, provider };
  }

  // A connection probe sends a small real request; saving alone never claims protocol compatibility.
  async test(engineId, id) {
    const profile = await this.profile(engineId, id);
    const claude = engineId === 'claude';
    const endpoint = `${profile.baseUrl}${claude && !profile.baseUrl.endsWith('/v1') ? '/v1' : ''}/${claude ? 'messages' : 'responses'}`;
    let response;
    try {
      response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', ...(claude
          ? { 'x-api-key': profile.apiKey, 'anthropic-version': '2023-06-01' }
          : { Authorization: `Bearer ${profile.apiKey}` }) },
        body: JSON.stringify(claude ? { model: profile.model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply OK' }] }
          : { model: profile.model, input: 'Reply OK', max_output_tokens: 16 }) });
    } catch {
      throw Error('供应商连接失败，请检查地址和网络');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`供应商接口返回 HTTP ${response.status}，请检查协议、模型和密钥`);
    }
    const body = await response.json();
    if (claude ? !Array.isArray(body.content) : !Array.isArray(body.output)) {
      throw Error('接口响应不符合所选引擎协议');
    }
    return { connected: true, protocol: profile.protocol, engineVerified: false };
  }
}

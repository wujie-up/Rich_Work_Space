const authorization = message => Object.assign(Error(message), { code: 'FEISHU_AUTH_REQUIRED' });

// Credentials stay in the MCP plugin; pasted links never receive bearer tokens directly.
export class FeishuDocuments {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.tokens = new Map();
  }

  async json(base, path, options, signal) {
    const response = await this.fetch(`${base}/open-apis/${path}`, {
      ...options, redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)])
    });
    if (!response.ok) {
      if ([400, 401, 403, 404].includes(response.status)) {
        this.tokens.delete(base);
        throw authorization(`飞书文档不可访问（HTTP ${response.status}）。请检查凭据、应用文档权限及文档共享范围。`);
      }
      throw Error(`飞书接口请求失败（HTTP ${response.status}）`);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) { break; }
        size += value.length;
        if (size > 2 * 1024 * 1024) { throw Error('飞书文档过大，请拆分文档后重试'); }
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value.code !== 0) {
      // Clear rejected cached tokens so an explicit human retry can renew credentials.
      this.tokens.delete(base);
      // API error text can contain request data; only expose the numeric error code.
      throw authorization(`飞书接口拒绝访问（code ${Number(value.code)}）。请检查应用权限、凭据有效期及文档共享范围。`);
    }
    return value;
  }

  async token(base, config, signal) {
    if (config.userAccessToken) { return config.userAccessToken; }
    if (!config.appId || !config.appSecret) {
      throw authorization('请在 MCP 服务 → 飞书文档与电脑工具中配置飞书 App ID 和 App Secret，或用户访问令牌；不要在对话中发送密钥。');
    }
    const cached = this.tokens.get(base);
    if (cached?.appId === config.appId && cached.appSecret === config.appSecret && cached.expires > Date.now()) {
      return cached.token;
    }
    const result = await this.json(base, 'auth/v3/tenant_access_token/internal', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }) }, signal);
    if (!result.tenant_access_token) { throw authorization('飞书未返回有效的应用访问令牌，请检查应用凭据'); }
    this.tokens.set(base, { appId: config.appId, appSecret: config.appSecret, token: result.tenant_access_token,
      expires: Date.now() + Math.max(0, (result.expire - 60) * 1000) });
    return result.tenant_access_token;
  }

  async read({ url }, config, signal) {
    const address = new URL(url);
    const match = address.pathname.match(/^\/(docx|wiki)\/([a-zA-Z0-9_-]+)\/?$/);
    if (address.protocol !== 'https:' || address.username || address.password
      || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(address.hostname) || !match) {
      throw Error('请提供 HTTPS 飞书 / Lark 文档（docx）或知识库（wiki）链接');
    }
    const base = address.hostname.endsWith('larksuite.com') ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    const token = await this.token(base, config, signal);
    const options = { headers: { Authorization: `Bearer ${token}` } };
    let documentId = match[2];
    let title = '飞书文档';
    if (match[1] === 'wiki') {
      const { data } = await this.json(base, `wiki/v2/spaces/get_node?token=${encodeURIComponent(documentId)}`, options, signal);
      if (data.node.obj_type !== 'docx') { throw Error('此知识库节点不是新版文档，请提供 docx 文档链接'); }
      documentId = data.node.obj_token;
      title = data.node.title || title;
    }
    const { data } = await this.json(base, `docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`, options, signal);
    if (typeof data.content !== 'string' || Buffer.byteLength(data.content, 'utf8') > 850000) { throw Error('文档内容无效或过大，请拆分后重试'); }
    const result = { content: [{ type: 'text', text: `${title}\n来源：${url}\n\n${data.content}` }] };
    // Escaped quotes and line breaks also count toward the workbench's serialized result limit.
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 900000) { throw Error('文档内容过大，请拆分后重试'); }
    return result;
  }
}

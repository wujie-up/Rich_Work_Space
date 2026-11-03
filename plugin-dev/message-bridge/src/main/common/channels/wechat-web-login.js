function loginCredentials(response) {
  const xml = typeof response?.data === 'string' ? response.data : '';
  const field = name => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
  const ret = field('ret');
  if (ret !== '0') {
    const message = (field('message') || '登录响应无效，请重新扫码').slice(0, 300);
    throw Error(`微信网页登录被拒绝（${ret || '未知'}）：${message}`);
  }
  const credentials = { skey: field('skey'), sid: field('wxsid'), uin: field('wxuin'), passTicket: field('pass_ticket') };
  if (Object.values(credentials).some(value => !value)) {
    throw Error('微信网页登录凭据不完整，请重新扫码');
  }
  return credentials;
}

export async function loginWebClient(client, login) {
  let response;
  let requestError;
  // Keep the SDK's protocol headers without mutating its live request function. It ignores HTTP 200 XML and only parses rejected 301s.
  const context = Object.create(client);
  context.request = async options => {
    try {
      response = await client.request({ ...options, validateStatus: status => status === 200 || status === 301 });
      return response;
    } catch (error) {
      requestError = error;
      throw error;
    }
  };
  try {
    await login.call(context);
  } catch (error) {
    // The upstream catch dereferences error.response even for network failures; retain the original cause.
    throw requestError || error;
  }
  if (response) {
    const credentials = loginCredentials(response);
    const cookies = response.headers?.['set-cookie'] || [];
    const ticket = cookies.find(value => /^webwx.*?data.*?ticket=/i.test(value));
    Object.assign(client.PROP, credentials, ticket ? { webwxDataTicket: ticket.split(';')[0].slice(ticket.indexOf('=') + 1) } : {});
  }
}

// Keep the address as node text so downstream agents decide how to access the document.
export function documentLinkAnswer(value) {
  const text = value.trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw Error('请输入有效的 HTTP 或 HTTPS 网页链接');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Error('请输入不含账号密码的 HTTP 或 HTTPS 网页链接');
  }
  return { text, file: { name: url.hostname, size: new TextEncoder().encode(text).length, url: text } };
}

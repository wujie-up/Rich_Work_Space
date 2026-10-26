import { parseTree, requireMenu, validId } from './menu-catalog.js';

const BASE = 'https://saas-fat.dbaifin.com:89/admin';
// JSON reviver source preserves Java long identifiers before the rounded JS number can escape.
export const parseJson = text => JSON.parse(text, (_key, value, context) =>
  typeof value === 'number' && !Number.isSafeInteger(value) && Number.isInteger(value) ? context.source : value);
const integer = value => JSON.rawJSON(validId(value));
export function syncBody(menuId, institutions) {
  const ids = String(institutions).trim().split(/[,，\s]+/).filter(Boolean).map(validId);
  requireMenu(validId(menuId) !== '0', '来源根菜单 ID 必须大于 0');
  requireMenu(ids.length > 0 && ids.length <= 200 && new Set(ids).size === ids.length, '目标机构 1–200 个且不可重复');
  return JSON.stringify({ tenantId: 0, institutionIds: ids.map(integer), menuId: integer(menuId) });
}
export class MenuApi {
  constructor(settings, { fetch: request = globalThis.fetch } = {}) {
    const token = String(settings.token || '').trim();
    requireMenu(token && !/[\r\n]/.test(token), '请输入有效 authtoken');
    this.roleId = validId(settings.roleId);
    this.fetch = request;
    this.headers = { Authorization: /^bearer /i.test(token) ? token : `Bearer ${token}`, Accept: 'application/json',
      'Content-Type': 'application/json', 'Accept-Language': 'zh-CN', 'x-country-code': 'zh-CN' };
    if (settings.menuId) {
      this.headers.menuid = validId(settings.menuId);
    }
  }
  async request(path, body, { mutation = false } = {}) {
    let response;
    try {
      response = await this.fetch(BASE + path, { headers: this.headers, redirect: 'error', signal: AbortSignal.timeout(30000),
        method: body === undefined ? 'GET' : 'POST', body });
    } catch {
      throw Error(mutation ? '同步连接失败或超时；请求可能已执行，请核对目标机构后再重试' : '接口连接失败，请检查网络和系统信任证书');
    }
    requireMenu(response.ok, `接口返回 HTTP ${response.status}，请检查 token、角色与接口权限`);
    const result = parseJson(await response.text());
    requireMenu(result && String(result.code) === '200' && Object.hasOwn(result, 'data'), '接口请求失败或响应缺少 data，请检查登录状态和权限');
    return result.data;
  }
  async snapshot() {
    return parseTree(await this.request(`/sys/role-menu-rel/tree?roleId=${this.roleId}`));
  }
  async appCodes(tenant) {
    const codes = [];
    for (let page = 1; ; page += 1) {
      const data = await this.request('/sys/menu/page', JSON.stringify({ pageNum: page, pageSize: 200, model: { tenantId: integer(tenant) } }));
      requireMenu(data && /^\d+$/.test(String(data.pages)), '菜单分页 pages 非法');
      const pages = Number(data.pages);
      if (data.records === undefined && String(data.total) === '0' && pages === 0) {
        return codes;
      }
      requireMenu(Array.isArray(data.records) && (data.records.length ? pages >= page : pages === 0 && String(data.total || 0) === '0'),
        '菜单分页数据不完整');
      codes.push(...data.records.map(row => row.appCode).filter(Boolean));
      if (page >= pages) {
        return codes;
      }
    }
  }
  async sync(menuId, institutions) {
    const roots = (await this.snapshot()).filter(node => ['MENU', 'DIR'].includes(node.kind) && node.parent_id === '0');
    requireMenu(roots.some(node => node.id === validId(menuId)), '来源根菜单已变化，请重新加载');
    const result = await this.request('/sys/permission/data-sync/sync-menu', syncBody(menuId, institutions), { mutation: true });
    requireMenu(result === true, '同步接口未返回成功，请核对目标机构');
    return { synced: true };
  }
}

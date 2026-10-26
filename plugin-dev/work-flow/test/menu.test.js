import test from 'node:test';
import assert from 'node:assert/strict';
const menu = await import('../src/main/common/menu-catalog.js').catch(() => ({}));
const api = await import('../src/main/common/menu-api.js').catch(() => ({}));
export const catalog = [{ key: 's:ADMIN', kind: 'SYSTEM', code: 'ADMIN', name: '管理', system: 'ADMIN', parent: '', level: 0 },
  { key: 'm:9223372036854775806', id: '9223372036854775806', kind: 'DIR', code: 'ops', name: '运营', system: 'ADMIN',
    parent: 's:ADMIN', parent_id: '0', level: 1 }];
export const drafts = [{ key: 'd:one', kind: 'MENU', code: 'orders', name: "O'Reilly", parent: catalog[1].key, path: '/orders', sort: 0 },
  { key: 'd:two', kind: 'BUTTON', code: 'orders:export', name: '导出', parent: 'd:one', sort: 1 }];

test('批量父子解析复用稳定 appCode，SQL 事务与映射相同', () => {
  assert.equal(typeof menu.prepareDrafts, 'function');
  const nodes = menu.prepareDrafts(catalog, drafts);
  assert.equal(nodes[1].parentNode.key, 'd:one');
  assert.equal(nodes[0].system, 'ADMIN');
  assert.equal(menu.prepareDrafts(catalog, nodes)[0].appCode, nodes[0].appCode);
  const sql = menu.generateSql('9223372036854775806', nodes);
  assert.match(sql, /^START TRANSACTION;/);
  assert.match(sql, /O''Reilly/);
  assert.match(sql, /sys_menu_resource_rel/);
  assert.ok(sql.includes(nodes[0].appCode));
  assert.equal(menu.registryMappings(nodes)[0].pairs[0][1], nodes[0].appCode);
  assert.ok(sql.endsWith('COMMIT;'));
});
test('拒绝目录与菜单 code 冲突、孤立按钮、重复 appCode 与非法 ID', () => {
  assert.equal(typeof menu.prepareDrafts, 'function');
  assert.throws(() => menu.prepareDrafts(catalog, [{ ...drafts[0], code: 'OPS' }]), /code/);
  assert.throws(() => menu.prepareDrafts(catalog, [{ ...drafts[1], parent: 's:ADMIN' }]), /按钮/);
  assert.throws(() => menu.prepareDrafts(catalog, [{ ...drafts[0], appCode: 'abc' }], ['ABC']), /appCode/);
  assert.throws(() => menu.validId('9223372036854775808'), /ID/);
  assert.match(menu.sqlValue('a\\b\nc'), /^CONVERT\(0x/);
});
test('原始 JSON 长 ID 不丢精度，unchecked 菜单同样加载', () => {
  assert.equal(typeof api.parseJson, 'function');
  const raw = '[{"systemCode":"ADMIN","systemName":"管理","menus":[{"id":9223372036854775806,"parentId":0,"menuType":"MENU","menuCode":"x","menuName":"X","checked":false}]}]';
  const rows = api.parseJson(raw);
  assert.equal(rows[0].menus[0].id, '9223372036854775806');
  const parsed = menu.parseTree(rows);
  assert.equal(parsed[1].key, 'm:9223372036854775806');
  assert.equal(parsed[1].parent_id, '0');
});
test('父节点后定义时按依赖生成 SQL，循环父子关系不能确认', () => {
  const nodes = menu.prepareDrafts(catalog, [...drafts].reverse());
  assert.equal(nodes[0].key, 'd:one');
  assert.equal(nodes[1].parentNode.key, 'd:one');
  assert.throws(() => menu.prepareDrafts(catalog, [{ ...drafts[0], parent: 'd:one' }]), /循环/);
});
test('API 禁重定向、全部分页读取 appCode，同步序列化 ID 保持整数', async () => {
  assert.equal(typeof api.MenuApi, 'function');
  const calls = [];
  const client = new api.MenuApi({ token: 'private', roleId: '9223372036854775806' }, { fetch: async (url, options) => {
    calls.push({ url, ...options });
    return { ok: true, text: async () => '{"code":200,"data":{"pages":"2","records":[{"appCode":"a"}]}}' };
  } });
  assert.deepEqual(await client.appCodes('0'), ['a', 'a']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].redirect, 'error');
  assert.match(api.syncBody('9223372036854775806', '42,43'), /"menuId":9223372036854775806/);
  assert.throws(() => api.syncBody('1', '42,42'), /重复/);
});

import { randomUUID } from 'node:crypto';

const TABLES = { SYSTEM: ['sys_subsystem', 'system_code', 'system_name'], MENU: ['sys_menu', 'menu_code', 'menu_name'],
  DIR: ['sys_menu', 'menu_code', 'menu_name'], BUTTON: ['sys_resource', 'resource_code', 'resource_name'] };
export function requireMenu(condition, message) {
  if (!condition) {
    throw Object.assign(Error(message), { code: 'MENU_INVALID' });
  }
}
export function validId(value) {
  const text = String(value);
  requireMenu(/^\d{1,19}$/.test(text) && BigInt(text) <= 9223372036854775807n, '请输入有效 ID');
  return BigInt(text).toString();
}
const namespace = node => `${TABLES[node.kind][0]}|${node.system.toLowerCase()}|${node.code.toLowerCase()}`;

// Parents must be inserted before their children even after the user reorders or reparents drafts.
function parentFirst(drafts) {
  const pending = new Map(drafts.map(draft => [draft.key, draft]));
  requireMenu(pending.size === drafts.length, '草稿 ID 重复');
  const visiting = new Set();
  const ordered = [];
  function visit(draft) {
    requireMenu(!visiting.has(draft.key), '草稿父节点存在循环');
    visiting.add(draft.key);
    const parent = pending.get(draft.parent);
    if (parent) { visit(parent); }
    visiting.delete(draft.key);
    if (pending.delete(draft.key)) { ordered.push(draft); }
  }
  for (const draft of drafts) {
    if (pending.has(draft.key)) { visit(draft); }
  }
  return ordered;
}

export function parseTree(rows) {
  requireMenu(Array.isArray(rows), '菜单树 data 必须是数组');
  return rows.flatMap(row => {
    const system = { key: `s:${row.systemCode}`, kind: 'SYSTEM', code: row.systemCode, name: row.systemName,
      system: row.systemCode, parent: '', level: 0, sort: row.sortNo || 0 };
    return [system, ...(row.menus || []).flatMap(menu => parseMenu(menu, system))];
  });
}
function parseMenu(row, parent) {
  requireMenu(['MENU', 'DIR'].includes(row.menuType), '接口返回未知菜单类型');
  const node = { key: `m:${validId(row.id)}`, id: validId(row.id), kind: row.menuType, code: row.menuCode, name: row.menuName,
    system: parent.system, parent: parent.key, parent_id: validId(row.parentId), path: row.path || '', sort: row.sortNo || 0,
    level: row.treeLevel || parent.level + 1 };
  return [node, ...(row.buttons || []).map(button => ({ key: `b:${validId(button.id)}:${node.id}`, id: validId(button.id),
    kind: 'BUTTON', code: button.resourceCode, name: button.resourceName, sort: button.sortNo || 0,
    system: node.system, parent: node.key, level: node.level + 1 })), ...(row.children || []).flatMap(child => parseMenu(child, node))];
}

// Scope comes from the real parent; model output cannot redirect SQL to a different subsystem.
export function prepareDrafts(catalog, drafts, appCodes = []) {
  requireMenu(Array.isArray(drafts) && drafts.length <= 200, '每批最多新增 200 项');
  const known = new Map(catalog.map(node => [node.key, node]));
  const occupied = new Set(catalog.map(namespace));
  const apps = new Set(appCodes.filter(Boolean).map(code => code.trim().toLowerCase()));
  return parentFirst(drafts).map(draft => {
    const { key, kind, code, name, parent = '', path = '', sort = 0 } = draft;
    requireMenu(Object.hasOwn(TABLES, kind), '不支持的资源类型');
    requireMenu(typeof code === 'string' && /^[A-Za-z0-9_:./-]{1,100}$/.test(code), 'code 仅支持英文、数字及 _ : . / -，最多 100 字符');
    requireMenu(typeof name === 'string' && name.trim() && name.length <= 100, '名称必填，最多 100 字符');
    requireMenu(/^d:[A-Za-z0-9-]+$/.test(key) && !known.has(key), '草稿 ID 重复或非法');
    const parentNode = known.get(parent);
    if (kind === 'SYSTEM') {
      requireMenu(!parent && code.length <= 50, '子系统必须位于根节点，code 最多 50 字符');
    } else {
      requireMenu(parentNode && parentNode.kind !== 'BUTTON', '父节点不存在或不支持添加子项');
      requireMenu(kind !== 'BUTTON' || ['MENU', 'DIR'].includes(parentNode.kind), '按钮必须挂在菜单或目录下');
    }
    requireMenu(typeof path === 'string' && path.length <= 255, '路由路径最多 255 字符');
    requireMenu(Number.isInteger(sort) && sort >= 0 && sort <= 2147483647, '排序必须为非负整数');
    const node = { key, kind, code, name, parent, path, sort, system: kind === 'SYSTEM' ? code : parentNode.system,
      level: kind === 'SYSTEM' ? 0 : parentNode.level + 1 };
    requireMenu(!occupied.has(namespace(node)), `code 已存在：${code}`);
    if (kind === 'MENU') {
      node.appCode = draft.appCode ?? randomUUID().replaceAll('-', '');
      requireMenu(typeof node.appCode === 'string' && node.appCode.trim() && node.appCode.length <= 64, '菜单 appCode 必填，最多 64 字符');
      requireMenu(!apps.has(node.appCode.trim().toLowerCase()), `菜单 appCode 已存在：${node.appCode}`);
      apps.add(node.appCode.trim().toLowerCase());
    }
    if (parentNode) {
      node.parentNode = parentNode;
    }
    occupied.add(namespace(node));
    known.set(key, node);
    return node;
  });
}
export function sqlValue(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  const text = String(value);
  return /[\\\x00-\x1f]/.test(text) ? `CONVERT(0x${Buffer.from(text).toString('hex')} USING utf8mb4)` : `'${text.replaceAll("'", "''")}'`;
}
const insert = (table, fields) => `INSERT INTO ${table} (${Object.keys(fields).join(', ')})\nSELECT ${Object.values(fields).join(', ')};`;
const resourceId = (node, tenant) => `(SELECT id FROM ${TABLES[node.kind][0]} WHERE tenant_id = ${tenant} AND system_code = ${sqlValue(node.system)} AND ${TABLES[node.kind][1]} = ${sqlValue(node.code)} AND del_flag=0)`;
function nodeSql(node, tenant) {
  const [table, column, nameColumn] = TABLES[node.kind];
  const fields = { id: 'UUID_SHORT()', tenant_id: tenant, system_code: sqlValue(node.system), [nameColumn]: sqlValue(node.name),
    [column]: sqlValue(node.code), sort_no: node.sort, status: "'ENABLED'" };
  const parent = node.parentNode;
  if (node.kind === 'SYSTEM') {
    Object.assign(fields, { system_type: "'BIZ'", sso_enabled: '0' });
  }
  if (['MENU', 'DIR'].includes(node.kind)) {
    Object.assign(fields, { parent_id: parent.kind === 'SYSTEM' ? '0' : resourceId(parent, tenant), menu_type: sqlValue(node.kind),
      path: sqlValue(node.path), tree_level: node.level, visible: '1', data_permission_enabled: '0', field_permission_enabled: '0' });
  }
  if (node.kind === 'MENU') {
    fields.app_code = sqlValue(node.appCode);
  }
  const statements = [insert(table, fields)];
  if (node.kind === 'BUTTON') {
    statements.push(insert('sys_menu_resource_rel', { id: 'UUID_SHORT()', tenant_id: tenant,
      menu_id: resourceId(parent, tenant), resource_id: resourceId(node, tenant) }));
  }
  return statements.join('\n\n');
}
export function generateSql(tenant, nodes) {
  const id = validId(tenant);
  requireMenu(nodes.length, '请先添加资源');
  return ['START TRANSACTION;', ...nodes.map(node => nodeSql(node, id)), 'COMMIT;'].join('\n\n');
}
export function registryMappings(nodes) {
  const systems = [...new Set(nodes.filter(node => node.kind === 'MENU').map(node => node.system))];
  return systems.map(system => ({ system, pairs: nodes.filter(node => node.kind === 'MENU' && node.system === system)
    .map(node => [node.code, node.appCode]) }));
}

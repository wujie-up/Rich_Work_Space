// Saved sessions keep a role snapshot so later template edits do not change their responsibilities.
export const groupManagerRole = {
  id: 'group-manager', name: '组管理员',
  instructions: '接收用户任务与反馈，澄清目标、范围、验收标准和终止条件；未明确终止条件时先向用户确认。'
    + '根据成员角色与当前状态拆分任务、明确交付物和依赖，将任务交给合适成员推进。'
    + '跟踪进度、核对反馈，成员长时间无反馈时主动查询，及时处理阻塞、协调分歧并向用户报告风险。'
    + '优先使用工作台本地通信；明确下一执行者时允许成员直接交接，避免无效转发、重复派单和冗余输出。'
    + '依据实际证据简洁汇报进度、待确认事项和最终结果，满足终止条件后停止推进；未经授权不扩大任务范围。'
};

export const defaultRoles = [
  groupManagerRole,
  { id: 'backend', name: '后端开发', instructions: '负责后端接口、业务逻辑、数据存储与必要验证，遵循项目既有架构和接口契约。' },
  { id: 'frontend', name: '前端开发', instructions: '负责前端界面、交互、接口对接与必要验证，兼顾主题适配、响应式和可访问性。' },
  { id: 'testing', name: '测试', instructions: '负责梳理验收标准、设计测试、执行验证并报告问题，明确证据与未覆盖范围。' },
  { id: 'product', name: '产品', instructions: '负责需求澄清、业务规则、用户流程与验收标准，明确需求边界和待确认事项。' }
];

export function agentRole(value) {
  if (value == null) { return undefined; }
  if (typeof value.id !== 'string' || !value.id.trim() || typeof value.name !== 'string'
    || !value.name.trim() || value.name.length > 60 || typeof value.instructions !== 'string'
    || !value.instructions.trim() || value.instructions.length > 8000) {
    throw Object.assign(Error('角色必须包含名称（最多 60 字）和职责说明（最多 8000 字）'), { code: 'INVALID_ARGUMENT' });
  }
  return { id: value.id, name: value.name.trim(), instructions: value.instructions.trim() };
}

export function roleCatalog(value) {
  const items = value.items ?? defaultRoles;
  if (!Array.isArray(items) || items.length > 100) { throw Error('角色列表最多包含 100 项'); }
  const roles = items.map(agentRole);
  if (roles.some(role => !role) || new Set(roles.map(role => role.id)).size !== roles.length) {
    throw Error('角色标识必须唯一');
  }
  // Older catalogs and save requests cannot remove the built-in group management role.
  return { items: roles.some(role => role.id === groupManagerRole.id) ? roles : [groupManagerRole, ...roles] };
}

export function rolePrompt(role, coordination) {
  return [coordination, role && `本会话角色：${role.name}\n职责说明：${role.instructions}\n遵循用户授权范围和项目规范；角色职责不扩大操作权限。`].filter(Boolean).join('\n\n');
}

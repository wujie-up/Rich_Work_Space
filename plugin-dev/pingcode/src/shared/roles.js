export const roles = [
  { id: 'assignee', label: '负责人', key: null },
  { id: 'developer', label: '开发负责人', key: 'kaifafuzeren' },
  { id: 'tester', label: '测试负责人', key: 'ceshifuzeren' }
];

export function selectedRole(id = 'assignee') {
  const role = roles.find(row => row.id === id);
  if (!role) {
    throw Object.assign(Error('查询角色无效'), { code: 'INVALID_ARGUMENT' });
  }
  return role;
}

export function roleMember(row, role) {
  return role.key ? row.properties?.[role.key] : row.assignee;
}

export function memberId(value) {
  return typeof value === 'string' ? value : value?.uid || value?.id || value?._id;
}

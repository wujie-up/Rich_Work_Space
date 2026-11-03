// This POST is a read-only work-item search, never a general-purpose browser HTTP command.
export function validWorkItemQuery(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['criteria', 'project_id', 'pi', 'ps'].includes(key))
    || !Number.isSafeInteger(body.pi) || body.pi < 0 || !Number.isSafeInteger(body.ps) || body.ps < 1 || body.ps > 100) {
    return false;
  }
  const criteria = body.criteria;
  if (!criteria || Object.keys(criteria).some(key => !['conditions', 'condition_logic'].includes(key))
    || criteria.condition_logic !== 1 || !Array.isArray(criteria.conditions) || ![2, 3].includes(criteria.conditions.length)) {
    return false;
  }
  const [from, to, assignee] = criteria.conditions;
  if (criteria.conditions.some(item => !item || typeof item !== 'object'
    || Object.keys(item).some(key => !['property_key', 'operation', 'value', 'logic'].includes(key)) || item.logic !== 1)
    || !['created_at', 'completed_at'].includes(from.property_key) || from.property_key !== to.property_key
    || from.operation !== 2 || to.operation !== 5 || !Number.isSafeInteger(from.value)
    || !Number.isSafeInteger(to.value) || to.value <= from.value) {
    return false;
  }
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  return (!Object.hasOwn(body, 'project_id') || validId(body.project_id)) && (!assignee
    || (assignee.property_key === 'assignee' && assignee.operation === 6 && Array.isArray(assignee.value)
      && assignee.value.length === 1 && validId(assignee.value[0])));
}

// Field visibility uses the same declared defaults as execution, including nodes that have not been edited yet.
export function visibleNodeParams(type, params = {}) {
  const values = { ...Object.fromEntries((type?.params || []).map(spec => [spec.name, spec.default])), ...params };
  return (type?.params || []).filter(spec => (!spec.interaction || spec.interaction === (values.interaction || 'text'))
    && (!spec.when || Object.entries(spec.when).every(([name, expected]) => values[name] === expected)));
}

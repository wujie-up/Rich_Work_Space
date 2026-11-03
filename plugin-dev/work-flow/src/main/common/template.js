const PLACEHOLDER = /\{\{\s*([\w.-]+(?:\s*\?\?\s*[\w.-]+)*)\s*\}\}/g;
const WHOLE = /^\{\{\s*([\w.-]+(?:\s*\?\?\s*[\w.-]+)*)\s*\}\}$/;

export function readPath(variables, path) {
  let current = variables;
  for (const key of String(path).split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

export function stringify(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

// Select the current loop draft without also transmitting the original; empty values remain deliberate values.
function resolveExpression(variables, expression) {
  if (!expression.includes('??')) { return readPath(variables, expression); }
  for (const path of expression.split('??')) {
    const resolved = readPath(variables, path.trim());
    if (resolved !== undefined && resolved !== null) { return resolved; }
  }
  return undefined;
}

// A lone placeholder keeps its original type, so arrays and objects can flow between nodes unchanged.
export function value(input, variables) {
  const whole = typeof input === 'string' ? WHOLE.exec(input.trim()) : null;
  return whole ? resolveExpression(variables, whole[1]) : interpolate(input, variables);
}

export function interpolate(input, variables) {
  if (typeof input !== 'string') {
    return input;
  }
  return input.replace(PLACEHOLDER, (match, path) => {
    const resolved = resolveExpression(variables, path);
    return resolved === undefined ? '' : stringify(resolved);
  });
}

// A whole placeholder keeps its original type, so arrays and objects reach the next node unchanged.
export function resolveParams(params, variables) {
  const entries = Object.entries(params || {});
  return Object.fromEntries(entries.map(([name, raw]) => [name, value(raw, variables)]));
}

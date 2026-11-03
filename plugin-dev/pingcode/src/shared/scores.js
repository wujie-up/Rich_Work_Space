export function scoreValue(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return { kind: 'missing' };
  }
  if (!['string', 'number'].includes(typeof value) || !Number.isFinite(Number(value))) {
    return { kind: 'invalid' };
  }
  const text = String(value).trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || !(match[2] || match[3]) || text.length > 400) {
    return { kind: 'invalid' };
  }
  const exponent = Number(match[4] || 0);
  if (Math.abs(exponent) > 324) {
    return { kind: 'invalid' };
  }
  let units = BigInt((match[2] || '0') + (match[3] || '')) * (match[1] === '-' ? -1n : 1n);
  let scale = (match[3] || '').length - exponent;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { kind: 'value', units, scale };
}

function format(units, scale) {
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  const value = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits;
  return units === 0n ? '0' : sign + value;
}

export function summarize(tasks, state = '') {
  const rows = state ? tasks.filter(row => row.stateId === state) : tasks;
  let units = 0n;
  let scale = 0;
  let scored = 0;
  let missing = 0;
  let invalid = 0;
  for (const row of rows) {
    const value = scoreValue(row.score);
    if (value.kind === 'missing') {
      missing++;
    } else if (value.kind === 'invalid') {
      invalid++;
    } else {
      const next = Math.max(scale, value.scale);
      units = units * 10n ** BigInt(next - scale) + value.units * 10n ** BigInt(next - value.scale);
      scale = next;
      scored++;
    }
  }
  return { rows, total: format(units, scale), scored, missing, invalid };
}

export function bytes(value, rate = false) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.max(0, Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10)));
  return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}${rate ? '/s' : ''}`;
}

export function format(key, value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return key === 'cpu' ? `${value.toFixed(1)}%` : bytes(value, key !== 'memory');
}

// Missing samples break the path; a collection gap must not be drawn as measured zero usage.
export function chartPath(values, ceiling) {
  const peak = ceiling || Math.max(1, ...values.filter(Number.isFinite));
  let pen = false;
  return values.map((value, i) => {
    if (!Number.isFinite(value)) {
      pen = false;
      return '';
    }
    const point = `${(i * 280 / Math.max(1, values.length - 1)).toFixed(2)},${(46 - Math.min(1, value / peak) * 42).toFixed(2)}`;
    const command = pen ? 'L' : 'M';
    pen = true;
    return `${command}${point}`;
  }).join(' ');
}

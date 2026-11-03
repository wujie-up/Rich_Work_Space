export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function monthBounds(month) {
  if (!month) {
    return null;
  }
  if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) {
    throw Error('月份无效，请选择年月');
  }
  const [year, selectedMonth] = month.split('-').map(Number);
  const start = new Date(year, selectedMonth - 1, 1).getTime() / 1000;
  const end = new Date(year, selectedMonth, 1).getTime() / 1000;
  return { start, end };
}

export function filterTasks(tasks, { month = '', dateField = 'completedAt' } = {}) {
  if (!['completedAt', 'createdAt'].includes(dateField)) {
    throw Error('时间口径无效');
  }
  const bounds = monthBounds(month);
  if (!bounds) { return tasks; }
  const { start, end } = bounds;
  return tasks.filter(row => Number.isFinite(row[dateField]) && row[dateField] >= start && row[dateField] < end);
}

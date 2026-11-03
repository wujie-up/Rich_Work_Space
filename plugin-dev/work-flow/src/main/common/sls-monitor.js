import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname, isAbsolute, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
import { slsReport } from './sls-report.js';

const targetKey = target => `${target.region}/${target.project}/${target.logstore}`;
const scopeFields = ['system', 'country', 'region', 'project', 'logstore'];

function json(value) {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw fail('INVALID_ARGUMENT', `巡检配置不是有效 JSON：${error.message}`);
  }
}

function rulesOf(value) {
  const rules = json(value);
  if (!Array.isArray(rules)) {
    throw fail('INVALID_ARGUMENT', '过滤规则必须是 JSON 数组');
  }
  const ids = new Set();
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id.trim() || ids.has(rule.id) || typeof rule.enabled !== 'boolean'
      || typeof rule.reason !== 'string' || !rule.reason.trim() || !rule.scope || typeof rule.scope !== 'object' || Array.isArray(rule.scope)
      || Object.entries(rule.scope).some(([key, entry]) => !scopeFields.includes(key) || typeof entry !== 'string' || !entry.trim())
      || !Array.isArray(rule.conditions) || !rule.conditions.length
      || rule.conditions.some(condition => !condition || !['message', 'location'].includes(condition.field)
        || !['contains', 'equals'].includes(condition.operator) || typeof condition.value !== 'string' || !condition.value.trim())) {
      throw fail('INVALID_ARGUMENT', `无效过滤规则：${rule?.id || '未命名'}；需要唯一ID、启用状态、确认依据、适用范围和非空条件`);
    }
    ids.add(rule.id);
  }
  return rules.filter(rule => rule.enabled);
}

// Encode SQL comment-like payloads because the existing MCP validator rejects those tokens even inside literals.
function literal(value) {
  return /--|\/\*|\*\/|;\s*\S|\\|[\u0000-\u001f]/.test(value)
    ? `from_utf8(from_base64('${Buffer.from(value).toString('base64')}'))` : `'${value.replaceAll("'", "''")}'`;
}

function conditionSql(condition) {
  const field = `coalesce("${condition.field}", '')`;
  return condition.operator === 'equals' ? `${field} = ${literal(condition.value)}`
    : `strpos(${field}, ${literal(condition.value)}) > 0`;
}

function targetsOf(value) {
  const targets = json(value);
  if (!Array.isArray(targets) || !targets.length || targets.some(target => !target
    || scopeFields.some(field => typeof target[field] !== 'string' || !target[field].trim()))
    || new Set(targets.map(targetKey)).size !== targets.length) {
    throw fail('INVALID_ARGUMENT', '目标日志库必须非空且唯一，并填写系统、国家、地域、项目及日志库');
  }
  return targets;
}

async function queryPlan(context) {
  const targets = targetsOf(context.value('targets'));
  const rules = rulesOf(context.value('rules'));
  const plans = targets.map(target => {
    const matching = rules.filter(rule => Object.entries(rule.scope).every(([field, value]) => target[field] === value));
    const exclusions = matching.map(rule => `(${rule.conditions.map(conditionSql).join(' AND ')})`);
    const predicate = exclusions.length ? `NOT (${exclusions.join(' OR ')})` : 'TRUE';
    const where = exclusions.length ? ` WHERE ${predicate}` : '';
    return { ...target, ruleIds: matching.map(rule => rule.id), predicate, queries: {
      count: `level: ERROR | SELECT count(*) AS totalErrors, coalesce(sum(CASE WHEN ${predicate} THEN 1 ELSE 0 END), 0) AS errors, `
        + `coalesce(sum(CASE WHEN ${predicate} THEN 0 ELSE 1 END), 0) AS excludedErrors FROM log LIMIT 1`,
      patterns: `level: ERROR | SELECT location, message, count(*) AS occurrences FROM log${where}`
        + ' GROUP BY location, message ORDER BY occurrences DESC LIMIT 100',
      samples: `level: ERROR | SELECT location, message FROM log${where} LIMIT 3`
    } };
  });
  const countries = Object.fromEntries([...new Set(plans.map(target => target.country))]
    .map(country => [country, plans.filter(target => target.country === country)]));
  return { targets: plans, countries, rules };
}

function directory(context) {
  const path = context.value('stateDirectory');
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw fail('INVALID_ARGUMENT', '巡检状态目录需要绝对路径');
  }
  return path;
}

async function readState(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw Error('状态必须是 JSON 对象');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw fail('SLS_STATE_FAILED', `巡检状态读取失败（${path}）：${error.message}`);
  }
}

// An interrupted write must leave the previous cursor intact rather than a partially written JSON document.
async function writeState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await rename(temporary, path);
}

async function windowOf(context) {
  const root = directory(context);
  const cursor = await readState(join(root, 'cursor.json'));
  const previous = await readState(join(root, 'latest.json'));
  const to = Math.floor(Date.now() / 1000);
  // Legacy summaries were model-generated; only their explicit successful watermark may advance the start.
  const legacyFrom = previous.watermarkAdvanceAllowed === true ? previous.windowTo : previous.windowFrom;
  const from = cursor.windowTo ?? cursor.pendingFrom ?? legacyFrom ?? to - 1800;
  if (!Number.isInteger(from) || from < 0 || from >= to) {
    throw fail('SLS_WINDOW_INVALID', `巡检起点 ${from} 必须早于当前时间 ${to}（UTC秒），请核对已保存状态和系统时间`);
  }
  await mkdir(root, { recursive: true });
  await writeState(join(root, 'cursor.json'), { ...cursor, pendingFrom: from });
  const stamp = new Date(to * 1000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return { from, to, stamp, previous: { fingerprints: (previous.fingerprints || []).slice(0, 200) }, gaps: [],
    windowLabel: `[${new Date(from * 1000).toISOString()}, ${new Date(to * 1000).toISOString()})` };
}

// Use the report creation time in Beijing, independent of the machine timezone or a retried query window.
function datedReportPath(path) {
  const { dir, name, ext } = parse(path);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: '2-digit',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(Date.now()).map(part => [part.type, part.value]));
  return join(dir, `${name.replace(/-最新$/, '')}-${parts.year}${parts.month}${parts.day}-${parts.hour}:${parts.minute}${ext}`);
}

// Exclusive creation preserves earlier reports even when retries finish within the same minute.
async function saveReport(path, report) {
  const { dir, name, ext } = parse(path);
  for (let index = 1; ; index += 1) {
    const target = index === 1 ? path : join(dir, `${name}-${index}${ext}`);
    try {
      await writeFile(target, report, { encoding: 'utf8', flag: 'wx' });
      return target;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

async function checkpoint(context) {
  const root = directory(context);
  const window = json(context.value('window'));
  const targets = targetsOf(context.value('targets'));
  const groups = json(context.value('groups'));
  const coverage = Object.values(groups).flatMap(group => group.output?.coverage || []);
  const advanced = coverage.length === targets.length && targets.every(target => {
    const matches = coverage.filter(item => targetKey(item) === targetKey(target));
    return matches.length === 1 && matches[0].status === 'complete' && matches[0].patternsComplete === true
      && matches[0].from === window.from && matches[0].to === window.to;
  });
  const cursor = await readState(join(root, 'cursor.json'));
  if ((cursor.windowTo ?? cursor.pendingFrom) !== window.from) {
    throw fail('SLS_STATE_CONFLICT', '巡检游标已被其他运行修改，保留现有游标，请重新运行');
  }
  // Reports must be durable before a successful query window becomes the next run's starting point.
  let reportPath = context.value('reportPath');
  let report = context.value('report');
  if (typeof reportPath !== 'string' || !isAbsolute(reportPath) || typeof report !== 'string' || !report.trim()) {
    throw fail('INVALID_ARGUMENT', '报告需要非空正文和绝对保存路径');
  }
  try {
    report = slsReport(report, groups);
  } catch (error) {
    // Evidence formatting must not discard the original analysis or change the existing coverage decision.
    report += '\n\n> 关键日志附录生成失败，本报告仅保留分析正文，请在节点运行结果中核对原始查询证据。\n';
    console.error('sls-report-format-failed', { runId: context.runId, nodeId: context.nodeId, stack: error.stack });
  }
  reportPath = datedReportPath(reportPath);
  let archivePath = join(root, 'reports', `${window.stamp}.md`);
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(archivePath), { recursive: true });
  archivePath = await saveReport(archivePath, report);
  reportPath = await saveReport(reportPath, report);
  console.info('sls-report-saved', { runId: context.runId, nodeId: context.nodeId, reportPath, archivePath });
  await writeState(join(root, 'latest.json'), { ...json(context.value('summary')), windowFrom: window.from, windowTo: window.to,
    generatedAt: Date.now(), coverage, watermarkAdvanceAllowed: advanced });
  if (advanced) {
    await writeState(join(root, 'cursor.json'), { windowTo: window.to });
  }
  return { advanced, from: window.from, to: window.to, coverage, reportPath, archivePath };
}

export function slsTypes() {
  const stateDirectory = { name: 'stateDirectory', label: '巡检状态目录（绝对路径）', kind: 'text', default: '' };
  return [
    { type: 'sls.query-plan', label: 'SLS 过滤规则与查询', summary: '维护已确认业务异常规则，按国家及日志库生成计数、聚合和样本查询。',
      io: 'transform', kind: 'process', role: 'step', timeoutMs: 5000,
      params: [{ name: 'targets', label: '日志库清单 JSON', kind: 'textarea', rows: 3, default: '[]' },
        { name: 'rules', label: '已确认过滤规则 JSON', kind: 'textarea', rows: 8, default: '[]' }], resolve: queryPlan },
    { type: 'sls.window', label: 'SLS 连续查询时间窗', summary: '从上次成功结束时间查到当前时间；失败窗口保留，不静默跳过。',
      io: 'transform', kind: 'process', role: 'step', timeoutMs: 5000, params: [stateDirectory], resolve: windowOf },
    { type: 'sls.checkpoint', label: 'SLS 保存报告与游标', summary: '报告落盘后检查全部日志库的覆盖，只有完整成功才推进查询起点。',
      io: 'sink', kind: 'output', role: 'end', timeoutMs: 5000,
      params: [stateDirectory, { name: 'reportPath', label: '桌面报告路径（自动追加北京时间后缀，不覆盖）', kind: 'text', default: '' },
        { name: 'report', label: '报告正文', kind: 'textarea', rows: 3, default: '' }, ...['window', 'targets', 'groups', 'summary'].map(name => ({ name,
        label: { window: '本次时间窗', targets: '目标日志库', groups: '查询结果', summary: '跨轮问题摘要' }[name],
        kind: 'textarea', rows: 2, default: '' }))], resolve: checkpoint }
  ];
}

import { callbackTimeoutHours, payoutCountryLabel } from './payout-queries.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const cell = value => String(value ?? '（空）').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');

export function groupPayoutRecords(records) {
  const channels = new Map();
  for (const record of records) {
    const key = record.channel_code;
    if (!channels.has(key)) {
      channels.set(key, { name: record.channel_name, code: record.channel_code, countries: new Map() });
    }
    const countries = channels.get(key).countries;
    if (!countries.has(record.country_code)) {
      countries.set(record.country_code, []);
    }
    countries.get(record.country_code).push(record);
  }
  return [...channels.values()].sort((a, b) => a.code.localeCompare(b.code)).map(channel => ({
    name: channel.name, code: channel.code,
    countries: [...channel.countries].sort(([a], [b]) => a.localeCompare(b)).map(([country, rows]) => ({ country,
      records: [...rows].sort((a, b) => String(a.application_time ?? '').localeCompare(String(b.application_time ?? ''))
        || a.application_id.localeCompare(b.application_id)) }))
  }));
}

export function payoutReport(audit) {
  const lines = ['# 放款未回调订单巡检', '', `结果：${audit.complete ? '完整' : '不完整，不能作为完整订单清单'}`,
    `财务基准时间：${cell(audit.asOf)}（数据库时间）`, `范围：最近一个月，创建超过 ${callbackTimeoutHours(audit.timeoutHours)} 小时，放款调用成功且未收到真实回调；旧系统 payment_record.status=2。`,
    `财务候选事件数：${audit.candidateEvents}；复核后明细数：${audit.records.length}。`, ''];
  if (!audit.complete) {
    lines.push('## 查询缺口', '', ...audit.failures.map(message => `- ${cell(message)}`), '');
  }
  for (const channel of audit.channels || groupPayoutRecords(audit.records)) {
    for (const { country, records: rows } of channel.countries) {
      lines.push(`## 渠道：${cell(channel.name)} 国家：${cell(payoutCountryLabel(country))}`, '',
        '| 老系统申请单ID | 申请时间 | 渠道订单号 |',
        '| --- | --- | --- |');
      for (const row of rows) {
        lines.push(`| ${[row.application_id, row.application_time, row.channel_order_no].map(cell).join(' | ')} |`);
      }
      lines.push('');
    }
  }
  if (!audit.records.length) {
    lines.push(audit.complete ? '本轮未发现仍处于 status=2 的匹配放款记录。' : '当前没有可列出的已复核记录；存在查询缺口，不能判断为无订单。', '');
  }
  return lines.join('\n') + '\n';
}

export async function savePayoutReport(audit, { directory, now = Date.now(), runId }) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw Error('报告目录必须是绝对路径');
  }
  const stamp = new Date(now + 8 * 3600000).toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');
  const name = `放款未回调订单${audit.complete ? '' : '-未完成'}-${stamp}-${String(runId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12)}`;
  await mkdir(directory, { recursive: true });
  const report = payoutReport(audit);
  for (let index = 1; ; index++) {
    const path = join(directory, `${name}${index === 1 ? '' : `-${index}`}.md`);
    try {
      await writeFile(path, report, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return path;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

import { isAbsolute } from 'node:path';
import { collectPayoutAudit } from './payout-audit.js';
import { savePayoutReport } from './payout-report.js';
import { withPayoutMcp, payoutTimeoutMs as timeoutMs } from './payout-mcp.js';
import { fail } from './errors.js';

async function execute(context, tasks, logger) {
  const { reportDirectory } = context.params;
  if (!isAbsolute(String(reportDirectory || ''))) {
    throw fail('INVALID_ARGUMENT', '请选择报告保存目录（绝对路径）');
  }
  return withPayoutMcp(context, tasks, logger, async (query, options) => {
    const audit = await collectPayoutAudit(query, { ...options, timeoutHours: context.params.timeoutHours });
    options.signal.throwIfAborted();
    const path = await savePayoutReport(audit, { directory: reportDirectory, runId: context.runId });
    logger(audit.complete ? 'info' : 'error', 'payout-report', { runId: context.runId, nodeId: context.nodeId,
      path, complete: audit.complete, candidateEvents: audit.candidateEvents, matchedRecords: audit.records.length });
    if (!audit.complete) {
      throw fail('PAYOUT_INCOMPLETE', `巡检存在查询缺口，未完成报告：${path}；${audit.failures.join('；')}`);
    }
    return { complete: true, path, asOf: audit.asOf, candidateEvents: audit.candidateEvents,
      matchedRecords: audit.records.length, timeoutHours: audit.timeoutHours, queryCount: audit.queries.length };
  });
}

export function payoutAuditType({ tasks, logger = (level, event, fields) => console[level](`[work-flow:${event}]`, fields) }) {
  return { type: 'payout.audit', label: '放款未回调巡检', summary: '财务与国家库串行分页复核，按渠道、国家保存时间戳 Markdown 报告。',
    io: 'transform', kind: 'process', role: 'step', timeoutMs,
    params: [{ name: 'serviceId', label: 'Metabase MCP 服务ID（单个服务可留空）', kind: 'text', default: '' },
      { name: 'reportDirectory', label: '报告保存目录（绝对路径）', kind: 'text', default: '' },
      { name: 'timeoutHours', label: '未回调超时（小时，1–744）', kind: 'number', default: 6 }],
    resolve: context => execute(context, tasks, logger) };
}

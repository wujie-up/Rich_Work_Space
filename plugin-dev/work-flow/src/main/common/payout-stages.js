import { isAbsolute } from 'node:path';
import { collectFinancialCandidates, payoutBatches, reviewPayoutCandidates, rowsOf } from './payout-audit.js';
import { runContext } from './payout-queries.js';
import { groupPayoutRecords, savePayoutReport } from './payout-report.js';
import { withPayoutMcp, payoutTimeoutMs } from './payout-mcp.js';
import { fail } from './errors.js';

const parameter = (name, label, kind = 'text') => ({ name, label, kind, default: '' });
const service = parameter('serviceId', 'Metabase MCP 服务ID（单个服务可留空）');
const directory = parameter('reportDirectory', '报告保存目录（绝对路径）');
const financial = parameter('financial', '财务候选（上游完整输出变量）', 'textarea');

// Each visible node performs exactly one business step; the old combined node remains available.
export function payoutStageTypes({ tasks, logger = (level, event, fields) => console[level](`[work-flow:${event}]`, fields) }) {
  const step = (type, label, summary, params, resolve) => ({ type, label, summary, params,
    io: 'transform', kind: 'process', role: 'step', timeoutMs: payoutTimeoutMs,
    async resolve(context) {
      try {
        if (context.shouldStop()) {
          throw fail('PAYOUT_STOPPED', '巡检已停止');
        }
        const output = await resolve(context);
        logger('info', 'payout-stage-complete', { runId: context.runId, nodeId: context.nodeId, type,
          candidateEvents: output.candidateEvents, matchedRecords: output.matchedRecords,
          groupCount: output.groupCount, queryCount: output.queries?.length, path: output.path });
        return output;
      } catch (error) {
        logger('error', 'payout-stage-failed', { runId: context.runId, nodeId: context.nodeId, type, stack: error.stack });
        throw error;
      }
    } });
  return [
    step('payout.snapshot', '固定财务查询窗口', '读取财务库时间及最大事件ID，固定最近一个月的查询窗口和最大ID。',
      [service, directory], context => withPayoutMcp(context, tasks, logger, async (query, options) => {
        if (!isAbsolute(String(context.params.reportDirectory || ''))) {
          throw fail('INVALID_ARGUMENT', '请选择报告保存目录（绝对路径）');
        }
        const result = await query(runContext());
        options.signal.throwIfAborted();
        const rows = rowsOf(result);
        if (result.truncated || rows.length !== 1) {
          throw Error('财务时间及最大ID查询结果不完整');
        }
        return { asOf: rows[0].as_of, highWater: rows[0].high_water, reportDirectory: context.params.reportDirectory,
          query: { database: 'treasury', requestId: result.request_id || '', rowCount: 1 } };
      })),
    step('payout.financial', '查询财务未回调候选', 'PAYOUT、调用成功、callback_received=0；游标读取所有候选申请单、国家、时间、渠道。',
      [service, directory, parameter('snapshot', '固定窗口（上游输出变量）', 'textarea'),
        { name: 'timeoutHours', label: '未回调超时（小时，1–744）', kind: 'number', default: 6 }],
      context => withPayoutMcp(context, tasks, logger, async (query, options) => {
        const snapshot = context.params.snapshot;
        const result = await collectFinancialCandidates(query, { ...options,
          timeoutHours: context.params.timeoutHours, context: { as_of: snapshot.asOf, high_water: snapshot.highWater } });
        result.queries.unshift(snapshot.query);
        options.signal.throwIfAborted();
        await requireComplete(result, context);
        return result;
      })),
    step('payout.batch', '按国家与渠道分批', '按国家编码和proxy_id分组；申请单去重，每批最多100个，避免跨国串单。', [financial], async context => {
      const groups = payoutBatches(context.params.financial.events);
      return { groups, groupCount: groups.length, candidateEvents: context.params.financial.candidateEvents,
        applicationCount: groups.reduce((sum, group) => sum + group.applicationIds.length, 0),
        batchCount: groups.reduce((sum, group) => sum + Math.ceil(group.applicationIds.length / 100), 0) };
    }),
    step('payout.verify', '国家库复核并补充渠道订单号', '按申请单关联订单与支付记录，仅保留status=2及渠道匹配记录，补充payment_code和申请时间并去重。',
      [service, directory, financial, parameter('groups', '国家渠道分组（上游groups变量）', 'textarea')],
      context => withPayoutMcp(context, tasks, logger, async (query, options) => {
        const result = await reviewPayoutCandidates(query, context.params.financial, { ...options, groups: context.params.groups });
        options.signal.throwIfAborted();
        await requireComplete(result, context);
        return { ...result, matchedRecords: result.records.length };
      })),
    step('payout.group', '按渠道和国家汇总', '渠道为一级分组，国家为二级分组，订单按申请时间排列。',
      [parameter('records', '已复核明细（上游records变量）', 'textarea')], async context => {
        const channels = groupPayoutRecords(context.params.records);
        return { channels, channelCount: channels.length, countryGroupCount: channels.reduce((sum, channel) => sum + channel.countries.length, 0),
          matchedRecords: context.params.records.length };
      }),
    step('payout.markdown', '生成时间戳MD报告', '保留申请单ID、申请时间、渠道订单号；保存渠道→国家→订单清单，不覆盖已有报告。',
      [directory, parameter('audit', '复核结果（上游完整输出变量）', 'textarea'),
        parameter('channels', '渠道国家分组（上游channels变量）', 'textarea')], async context => {
        const audit = { ...context.params.audit, channels: context.params.channels };
        const path = await savePayoutReport(audit, { directory: context.params.reportDirectory, runId: context.runId });
        return { complete: audit.complete, path, asOf: audit.asOf, candidateEvents: audit.candidateEvents,
          matchedRecords: audit.records.length, queryCount: audit.queries.length };
      })
  ];
}

async function requireComplete(audit, context) {
  if (!audit.complete) {
    const path = await savePayoutReport(audit, { directory: context.params.reportDirectory, runId: context.runId });
    throw fail('PAYOUT_INCOMPLETE', `当前步骤存在查询缺口，未完成报告：${path}；${audit.failures.join('；')}`);
  }
}

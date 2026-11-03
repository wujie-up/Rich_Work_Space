import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, extname } from 'node:path';
import { sendFeishuCards } from './feishu-robot.js';
import { buildFeishuReportCards } from './feishu-report.js';
import { fail } from './errors.js';

export function feishuOutputType({ robots, logger = (level, event, fields) => console[level](`[work-flow:${event}]`, fields) }) {
  return { type: 'output.feishu', label: '飞书机器人通知', summary: '将上游Markdown报告转为飞书原生表格卡片，完整分段发送，不自动重试。',
    io: 'sink', kind: 'output', role: 'end', timeoutMs: 900000,
    params: [{ name: 'reportPath', label: '报告文件（上游 path 变量）', kind: 'text', default: '' }],
    async resolve(context) {
      const controller = new AbortController();
      const deadline = Date.now() + 890000;
      const check = () => {
        if (context.shouldStop() || Date.now() >= deadline) {
          controller.abort(fail('FEISHU_STOPPED', '飞书通知已停止；已经发送的消息不会撤回'));
        }
      };
      check();
      const timer = setInterval(check, 100);
      timer.unref?.();
      try {
        controller.signal.throwIfAborted();
        const requested = context.value('reportPath');
        if (typeof requested !== 'string' || !isAbsolute(requested)) {
          throw fail('INVALID_ARGUMENT', '飞书通知需要上游 Markdown 报告的绝对路径');
        }
        const path = await realpath(requested);
        const info = await stat(path);
        if (extname(path).toLowerCase() !== '.md' || !info.isFile() || info.size > 1048576) {
          throw fail('INVALID_ARGUMENT', '请选择不超过1MiB的 Markdown 报告；未发送任何消息');
        }
        const config = await robots.snapshot();
        const text = await readFile(path, 'utf8');
        const result = await sendFeishuCards(config, buildFeishuReportCards(text), { signal: controller.signal,
          beforeSend: () => {
            check();
            controller.signal.throwIfAborted();
          },
          onPart: part => logger('info', 'feishu-report-part', { runId: context.runId, nodeId: context.nodeId, ...part }) });
        return { ...result, path, delivered: true };
      } catch (error) {
        logger('error', 'feishu-report-failed', { runId: context.runId, nodeId: context.nodeId, stack: error.stack });
        throw error;
      } finally {
        clearInterval(timer);
      }
    } };
}

import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configObject, mappedInput, resolveMapping, renderReport, transformData } from './configured-data.js';
import { callConfiguredMcp } from './configured-mcp.js';
import { createScriptRunner, scriptTimeout } from './scripts.js';
import { fail } from './errors.js';

const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

async function reportOutput(input, config, context) {
  const value = renderReport(input, config);
  if (Buffer.byteLength(value) > 4194304) {
    throw fail('CONFIGURED_OUTPUT_LIMIT', '报告超过4MiB，未保存');
  }
  if (!config.directory) {
    return { value };
  }
  if (typeof config.directory !== 'string' || !isAbsolute(config.directory)) {
    throw fail('INVALID_ARGUMENT', '报告directory需要绝对路径');
  }
  if (context.shouldStop()) {
    throw fail('CONFIGURED_CANCELED', '节点已取消，未保存报告');
  }
  await mkdir(config.directory, { recursive: true });
  const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
  const path = join(config.directory, `report-${stamp}-${randomUUID().slice(0, 8)}.md`);
  await writeFile(path, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { value, path };
}

export function configuredNodeType({ tasks, scripts = createScriptRunner(), logger = () => {} }) {
  return { type: 'custom.configured', label: '自定义节点',
    summary: '用配置完成MCP查询、数据处理、报告，或在独立进程执行可信JS/Python脚本；输出统一为value。',
    io: 'transform', kind: 'process', role: 'step', timeoutMs: 330000,
    params: [
      { name: 'mode', label: '执行模式', kind: 'select', default: 'transform', options: [
        { value: 'transform', label: '数据处理配置' }, { value: 'mcp', label: 'MCP工具调用' },
        { value: 'report', label: 'Markdown报告模板' }, { value: 'script', label: '脚本执行' }] },
      { name: 'input', label: '输入（支持上游变量）', kind: 'textarea', rows: 2, default: '', placeholder: '{{source.value}}' },
      { name: 'inputMapping', label: '输入映射JSON（可选，填写后代替输入）', kind: 'textarea', rows: 3, default: '', templated: false,
        placeholder: '{"orders":"{{source.value}}"}' },
      { name: 'config', label: '配置JSON（脚本模式下作为params）', kind: 'textarea', rows: 6, default: '{}', templated: false,
        placeholder: '{"operations":[{"op":"filter","field":"status","value":2}]}' },
      { name: 'language', label: '脚本语言', kind: 'select', default: 'javascript', when: { mode: 'script' },
        options: [{ value: 'javascript', label: 'JavaScript' }, { value: 'python', label: 'Python' }] },
      { name: 'code', label: '脚本函数体（input、params输入，return结果）', kind: 'textarea', rows: 12, default: 'return input',
        templated: false, when: { mode: 'script' } },
      { name: 'pythonExecutable', label: 'Python解释器路径（留空使用平台默认）', kind: 'text', default: '',
        when: { mode: 'script', language: 'python' } },
      { name: 'timeoutSeconds', label: '脚本/MCP超时（秒，1–300）', kind: 'number', default: 30 }
    ],
    async resolve(context) {
      const started = Date.now();
      const mode = context.params.mode || 'transform';
      try {
        if (context.shouldStop()) {
          throw fail('CONFIGURED_CANCELED', '节点已取消');
        }
        const timeoutSeconds = scriptTimeout(context.params.timeoutSeconds);
        const input = context.params.inputMapping ? mappedInput(context.params.inputMapping, context.variables) : context.params.input ?? null;
        if (jsonBytes(input) > 1048576) {
          throw fail('CONFIGURED_INPUT_LIMIT', '节点输入超过1MiB，请先拆分数据');
        }
        if (typeof context.params.config === 'string' && Buffer.byteLength(context.params.config) > 131072) {
          throw fail('INVALID_ARGUMENT', '配置JSON不能超过128KiB');
        }
        const config = configObject(context.params.config || '{}');
        let result;
        switch (mode) {
          case 'script':
            result = await scripts.run({ language: context.params.language || 'javascript', code: context.params.code,
              input, params: resolveMapping(config, context.variables), pythonExecutable: context.params.pythonExecutable,
              timeoutSeconds, shouldStop: context.shouldStop });
            break;
          case 'transform': result = { value: transformData(input, resolveMapping(config, context.variables)) }; break;
          case 'report': result = await reportOutput(input, resolveMapping(config, context.variables), context); break;
          case 'mcp': result = await callConfiguredMcp(tasks, config, input, { ...context, timeoutSeconds }); break;
          default: throw fail('INVALID_ARGUMENT', `不支持的自定义执行模式：${mode}`);
        }
        if (context.shouldStop()) {
          throw fail('CONFIGURED_CANCELED', '节点已取消，不发布执行结果');
        }
        if (jsonBytes(result) > 4194304) {
          throw fail('CONFIGURED_OUTPUT_LIMIT', '节点结果超过4MiB，未发布不完整结果');
        }
        logger('info', 'configured-node-complete', { runId: context.runId, nodeId: context.nodeId, mode,
          elapsedMs: Date.now() - started, count: Array.isArray(result.value) ? result.value.length : undefined, pages: result.pages });
        return result;
      } catch (error) {
        logger('error', 'configured-node-failed', { runId: context.runId, nodeId: context.nodeId, mode, stack: error.stack });
        throw error;
      }
    } };
}

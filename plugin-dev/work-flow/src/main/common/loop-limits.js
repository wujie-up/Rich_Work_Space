import { fail } from './errors.js';

// Only newly verified issue IDs count; rewording or reordering the same issues cannot renew the loop budget.
export function loopPause(params, round, progress) {
  const total = Number(params.maxTotalIterations || 0);
  const stagnant = Number(params.maxStagnantIterations || 0);
  if (stagnant && progress !== undefined) {
    if (!Array.isArray(progress) || progress.some(id => typeof id !== 'string' || !id.trim())) {
      throw fail('INVALID_ARGUMENT', '循环进展输入必须为已验证关闭的问题编号数组');
    }
    const known = new Set(round.resolvedIssueIds || []);
    const added = progress.filter(id => !known.has(id));
    round.stagnantIterations = round.resolvedIssueIds === undefined || added.length ? 0 : (round.stagnantIterations || 0) + 1;
    round.resolvedIssueIds = [...new Set([...known, ...progress])];
  }
  if (total && round.iteration >= total) {
    return { reason: 'total-limit', canContinue: false,
      message: `已达到总轮次上限 ${total} 轮，进度已保存；请调整流程或资料后新建运行，不能追加轮次。` };
  }
  if (stagnant && round.stagnantIterations >= stagnant) {
    return { reason: 'no-progress', canContinue: true,
      message: `连续 ${round.stagnantIterations} 轮没有新增已验证关闭的问题，进度已保存；请检查修改与校验证据后决定是否继续。` };
  }
  if (round.iteration - round.budget >= Number(params.maxIterations ?? 3)) {
    return { reason: 'budget', canContinue: true, message: `循环已达到本批次轮数，当前第 ${round.iteration} 轮，等待确认。` };
  }
  return null;
}

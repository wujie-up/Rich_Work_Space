// Chinese punctuation inside a closing emphasis delimiter can make CommonMark render the asterisks literally.
function reportLabels(report) {
  let fence;
  return report.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) {
        fence = marker[1];
      } else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = null;
      }
      return line;
    }
    return fence ? line : line.replace(/^( {0,3}(?:[-*+] )?)\*\*(证据|根因|处理|验证)[：:] *\*\* */,
      '$1**$2**：');
  }).join('\n');
}

const heading = value => String(value || '未命名问题').replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&');

function evidenceSection(finding) {
  const title = `### ${heading(finding.priority)} · ${heading(finding.fingerprint)} · ${heading(finding.title)}`;
  if (!finding.samples?.length) {
    return `${title}\n\n未取得本轮关键日志样本：${heading(finding.sampleUnavailableReason || '查询结果未提供，需补查，不能以摘要代替原始日志。')}`;
  }
  const samples = finding.samples.map(sample => {
    const body = JSON.stringify(sample, null, 2);
    // Log messages can contain Markdown fences; use a longer delimiter without changing the evidence itself.
    const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) || []).map(run => run.length + 1)));
    return `${fence}json\n${body}\n${fence}`;
  });
  return [title, ...samples].join('\n\n');
}

// Keep query evidence out of model summarization so compression cannot silently remove the logs needed for filtering.
export function slsReport(report, groups) {
  const findings = Object.values(groups).flatMap(group => group.output?.findings || []);
  const normalized = reportLabels(report);
  if (!findings.length) {
    return normalized;
  }
  const priority = finding => ['P0', 'P1', 'P2', 'P3'].indexOf(finding.priority);
  findings.sort((left, right) => (priority(left) < 0 ? 4 : priority(left)) - (priority(right) < 0 ? 4 : priority(right)));
  return [normalized.trimEnd(), '## 关键日志与过滤定位',
    '以下为本轮查询保留的脱敏日志，不是根因摘要；样本条数不代表异常总量。source 标明系统、国家及日志库，'
      + 'location、message 可用于配置过滤条件，time 和 requestId 未返回时不推测。slsRequestId 为查询请求标识。'
      + '请只选取不含动态编号、脱敏占位符及截断标记的稳定片段，并限定适用国家和日志库；确认前不自动排除。',
    ...findings.map(evidenceSection)].join('\n\n') + '\n';
}

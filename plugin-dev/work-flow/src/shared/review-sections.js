import { formatQuestionOptions } from './user-input-prompt.js';

const PRIORITIES = ['P0', '阻断', 'P1', '高优先级', 'P2', '中优先级', 'P3', '低优先级'];
const LABELLED_ITEM = /^\s*(P[0-3]|阻断|高优先级|中优先级|低优先级)\s*\|\s*([^|\n]+)\|\s*([\s\S]+)$/u;
const REVIEW_LABEL = /^(汇总|结论|问题|待确认|覆盖情况|修订说明|需求与设计对应关系|设计修改|(?:产品|架构|开发|测试)(?:审核|评审)(?:[ ·][^：:\n]+)?)[：:][ \t]*/gmu;

// Only explicit priorities determine severity; unlabelled historical findings keep their original order.
function priorityRank(item) {
  const rank = PRIORITIES.indexOf(item.priority);
  return rank < 0 ? PRIORITIES.length : rank;
}

function reviewItem(value) {
  if (value && typeof value === 'object' && typeof value.title === 'string' && typeof value.detail === 'string') {
    return { title: value.title, detail: formatQuestionOptions(value.detail),
      ...(PRIORITIES.includes(value.priority) ? { priority: value.priority } : {}) };
  }
  const detail = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const priority = detail.match(/^\s*[（(【\[]?((?:P[0-3])|阻断|高优先级|中优先级|低优先级)(?=$|[\s：:·|）)】\]])/u)?.[1];
  const labelled = detail.match(LABELLED_ITEM);
  if (labelled) {
    return { title: labelled[2].trim(), detail: formatQuestionOptions(labelled[3].trim()), priority: labelled[1] };
  }
  const content = detail.replace(/^\s*[（(【\[]?(?:P[0-3]|阻断|高优先级|中优先级|低优先级)[\s：:·）)】\]]+/u, '')
    .replace(/^([IQ]-\d+(?:\s*[（(][^）)]*[）)])?)[：:]\s*/u, '');
  const sentence = content.match(/^[^。！？；;\n]+[。！？]?/u)?.[0] || content;
  const title = sentence.length > 48 ? `${sentence.slice(0, 47)}…` : sentence.replace(/。$/u, '');
  const remainder = sentence.length <= 48 && sentence.length < content.length
    ? detail.slice(0, detail.length - content.length) + content.slice(sentence.length).trim() : detail;
  return { title, detail: formatQuestionOptions(remainder), ...(priority ? { priority } : {}) };
}

function reviewItems(values) {
  return [...new Map(values.map(value => [JSON.stringify(value), value])).values()]
    .map(reviewItem).sort((a, b) => priorityRank(a) - priorityRank(b));
}

function parseReviewValue(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    // Retain malformed source in the folded original rather than inventing an incomplete decision.
    console.error('[workflow:review-format-invalid]', { section: label }, error);
    return null;
  }
}

// Presentation is derived from legacy text too, so saved runs benefit without changing their execution data.
export function formatReviewSections(prompt, question) {
  const source = String(prompt);
  const matches = [...source.matchAll(REVIEW_LABEL)];
  const parts = new Map();
  const evidence = [];
  for (const [index, match] of matches.entries()) {
    const label = match[1];
    const text = source.slice(match.index + match[0].length, matches[index + 1]?.index ?? source.length).trim();
    if (/(?:审核|评审)/u.test(label)) {
      const review = parseReviewValue(label, text);
      if (review && typeof review.summary === 'string') {
        evidence.push({ title: `${label} · ${review.passed === true ? '已通过' : '未通过'}`, collapsed: true,
          items: [{ title: '角色结论', detail: review.summary },
            ...reviewItems([...(Array.isArray(review.questions) ? review.questions : []),
              ...(Array.isArray(review.issues) ? review.issues : [])])] });
      }
      continue;
    }
    const value = ['问题', '待确认', '需求与设计对应关系', '设计修改'].includes(label)
      ? parseReviewValue(label, text) : [text];
    if (Array.isArray(value)) {
      parts.set(label, [...(parts.get(label) || []), ...value]);
    }
  }
  if (!parts.size && !evidence.length) {
    // Clarification presents one question at a time without the round-review labels.
    return LABELLED_ITEM.test(question || source)
      ? [{ title: '当前需要确认', items: [reviewItem(question || source)] },
        { title: '完整评审原文', collapsed: true, items: [{ title: '原始记录', detail: source }] }]
      : [];
  }
  const sections = question && question.trim() !== source.trim()
    ? [{ title: '当前需要确认', items: [reviewItem(question)] }] : [];
  const add = (title, values, collapsed = false) => {
    const items = reviewItems(values);
    if (items.length) { sections.push({ title, items, ...(collapsed ? { collapsed } : {}) }); }
  };
  add('本轮结论', [...(parts.get('结论') || []), ...(parts.get('汇总') || [])]);
  add('需要你确认', parts.get('待确认') || []);
  const issues = reviewItems(parts.get('问题') || []);
  const high = item => ['P0', 'P1', '阻断', '高优先级'].includes(item.priority);
  const highIssues = issues.filter(high);
  const otherIssues = issues.filter(item => !high(item));
  if (highIssues.length) { sections.push({ title: '阻断与高优先级问题', items: highIssues }); }
  if (otherIssues.length) { sections.push({ title: '其他问题', items: otherIssues }); }
  add('覆盖与修订', [...(parts.get('覆盖情况') || []), ...(parts.get('需求与设计对应关系') || []),
    ...(parts.get('修订说明') || []), ...(parts.get('设计修改') || [])], true);
  sections.push(...evidence);
  sections.push({ title: '完整评审原文', collapsed: true, items: [{ title: '原始记录', detail: source }] });
  return sections;
}

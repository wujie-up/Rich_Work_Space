import { STAGES, ROLES, COMMON, AUTHOR_FIELDS, REVIEW_FIELDS, DECISION_FIELDS,
  REVIEW_INSTRUCTIONS, DECISION_INSTRUCTIONS, phaseCriteria } from './stages.mjs';
import { layoutNodes } from '../../../plugin-dev/work-flow/src/renderer/canvas-layout.js';

const ref = path => `{{${path}}}`;
const previous = path => ref(`loop.previous.${path}`);
const threshold = minimum => Array.from({ length: 101 - minimum }, (_, index) => `|${minimum + index}:[]:[]|`).join('');
const preflightFields = { state: ['ready', 'clarify'], projectDirectory: 'string', outputDirectory: 'string', allowedFiles: 'string',
  evidenceFiles: 'string', requirements: 'string', analysis: 'string', design: 'string', cases: 'string', defects: 'string',
  testEnvironment: 'string', decisions: 'string[]', questions: 'string[]' };

function graph(name) {
  const nodes = [];
  const edges = [];
  return {
    nodes, edges,
    node(id, type, title, params = {}) {
      nodes.push({ id, type, title, params, x: 0, y: 0, width: type === 'flow.route' ? 270 : 240,
        height: type === 'flow.route' ? 200 : 130 });
      return id;
    },
    edge(from, to, branch) { edges.push({ from, to, ...(branch ? { branch } : {}) }); },
    agent(id, title, rolePrompt, instructions, input, fields, params = {}) {
      // The existing input mapper resolves references once, preserving literal {{...}} inside source documents.
      return this.node(id, 'agent.review', title, { mode: 'plan', providerId: '', cwd: ref('preflight.output.projectDirectory'),
        rolePrompt, instructions, inputMapping: JSON.stringify({ context: input }), outputFields: JSON.stringify(fields), ...params });
    },
    route(id, title, input, expected) { return this.node(id, 'flow.route', title, { input, operator: 'equals', expected }); },
    loop(id, title, target, params = {}) {
      this.node(id, 'flow.loop', title, { input: ref('start.started'), operator: 'equals', expected: 'true',
        maxIterations: 5, maxTotalIterations: 5, ...params });
      this.edge(id, target, 'continue');
      return id;
    },
    report(id, title, input) { return this.node(id, 'result.collect', title, { title, input, format: 'text' }); },
    file(id, title, from, filename, content) {
      this.node(id, 'output.file', title, { path: `${ref('preflight.output.outputDirectory')}/${filename}`, content, mode: 'overwrite' });
      this.edge(from, id);
    },
    finish() {
      const positions = layoutNodes(nodes, edges);
      return { format: 'deckpg.workflow', version: 1,
        workflow: { name, nodes: nodes.map(node => ({ ...node, ...positions.get(node.id) })), edges, trigger: { mode: 'manual' } } };
    }
  };
}

function startup(g, stages) {
  const labels = stages.map(stage => `${stage.number} ${stage.title}`).join('、');
  g.node('start', 'flow.start', '开始');
  g.node('materials', 'flow.user-input', `提供${stages[0].inputLabel}`, { title: `提供${stages[0].inputLabel}`, interaction: 'file',
    prompt: '选择工作台/系统中的 Markdown、TXT 文件，或粘贴文档链接（不在输入节点抓取正文）。原文只读。'
      + '其他阶段资料可在下一步填写路径、链接或正文；已有文档和上一阶段导出文件均可。' });
  g.node('settings', 'flow.user-input', '本次项目与补充资料', { title: '本次项目与补充资料', interaction: 'text',
    prompt: `运行阶段：${labels}。集中提供资料即可，无需修改后续节点。输出目录请使用新的独立任务目录，同名产物会覆盖。`
      + '已有分析/设计/用例/缺陷可填写文件路径、链接或正文；原文不覆盖。页面测试需要可用工具、地址和权限，不要输入密钥。',
    initialValue: JSON.stringify({ projectDirectory: '', outputDirectory: '', requirements: '', analysis: '', design: '', cases: '', defects: '',
      testEnvironment: '', constraints: '', allowedFiles: '' }, null, 2) });
  g.agent('preflight', '协调 Agent · 核对启动资料', '你是本次流水线资料协调 Agent，负责核对资料与环境，不修改文件。', COMMON
    + `本次阶段：${labels}。把首份文档归入 ${stages[0].number === 1 ? 'requirements' : stages[0].number === 6 ? 'defects' : 'analysis'}。`
    + '读取补充文档的实际内容，保留输入来源、需求编号和用户已确认决定。缺少必须资料、无法读取链接或目录、工具权限不够时列出具体 questions。'
    + '只核对本次首阶段所需输入；后续阶段的新增文档由前序自动提供，不要求用户预先交齐。需求评审可创建分析；设计评审可创建设计；用例评审可创建用例；代码实施必须有分析和设计；测试必须有分析和用例；修复必须有分析/设计/缺陷；验收必须有分析。'
    + 'projectDirectory 从用户资料或需求中提取，代码相关阶段核对存在的项目绝对目录；outputDirectory 必须是独立输出绝对目录，不能与任何输入原文件路径相同。'
    + '代码阶段 allowedFiles 从用户约束/既有设计及代码核对确定，1–30 个精确相对文件路径换行分隔，无通配符、不含 ../ 和绝对路径，不能越过用户授权。'
    + '完整版可由后续设计阶段给出实施文件范围。evidenceFiles 使用项目内 .deckpg/test-evidence.md 和 .deckpg/acceptance-evidence.md，专供页面验证，不授权修改业务代码。'
    + '所有字段均返回，非当前阶段必需资料可为空。将历轮用户回答累积 decisions。确认必需资料可用才 ready 且 questions=[]，否则 clarify。',
  `主文档/链接：${ref('materials.text')}\n来源：${ref('materials.file')}\n补充资料：${ref('settings.text')}`
    + `\n上次核对：${previous('preflight.output')}\n用户补充：${previous('preflight-questions.text')}`, preflightFields, { cwd: '' });
  g.route('preflight-ready', '启动资料齐备？', `${ref('preflight.output.state')}:${ref('preflight.output.questions')}`, 'ready:[]');
  g.node('preflight-questions', 'flow.user-input', '补充缺少的启动资料', { title: '补充启动资料', interaction: 'text', prompt: ref('preflight.output.questions') });
  g.loop('preflight-loop', '核对资料 · 最多五轮', 'preflight');
  g.report('preflight-unresolved', '未完成 · 启动资料仍不齐备', ref('preflight.output'));
  g.edge('start', 'materials');
  g.edge('materials', 'settings');
  g.edge('settings', 'preflight');
  g.edge('preflight', 'preflight-ready');
  g.edge('preflight-ready', 'preflight-questions', 'false');
  g.edge('preflight-questions', 'preflight-loop');
  g.edge('preflight-loop', 'preflight-unresolved', 'exit');
}

function materialInput(stage, full) {
  const sources = { requirements: 'preflight.output.requirements', analysis: full && stage.number > 1 ? 's1-author.output.artifact' : 'preflight.output.analysis',
    design: full && stage.number > 2 ? 's2-author.output.artifact' : 'preflight.output.design',
    cases: full && stage.number > 3 ? 's3-author.output.artifact' : 'preflight.output.cases' };
  return Object.entries(sources).map(([name, source]) => `${name}：${ref(source)}`).join('\n')
    + (full ? STAGES.filter(prior => prior.number < stage.number)
      .map(prior => `\n阶段 ${prior.number} 已确认决定：${ref(`s${prior.number}-author.output.decisions`)}`).join('') : '')
    + `\n启动资料和约束：${ref('preflight.output')}\n用户原始约束：${ref('settings.text')}`;
}

function authorInput(stage, full) {
  const id = `s${stage.number}`;
  return materialInput(stage, full) + `\n上一版完整产物：${previous(`${id}-author.output`)}`
    + stage.reviewers.map(role => `\n上轮${ROLES[role].name}意见：${previous(`${id}-review-${role}.output`)}`).join('')
    + `\n上轮汇总：${previous(`${id}-decision.output`)}\n作者问题回答：${previous(`${id}-author-questions.text`)}`
    + `\n评审问题回答：${previous(`${id}-review-questions.text`)}\n修复问题回答：${previous('s6-author-questions.text')}`
    + `\n本轮测试未决问题答复：${ref('s5-review-questions.text')}`
    + STAGES[4].reviewers.map(role => `\n本轮测试${ROLES[role].name}评审：${ref(`s5-review-${role}.output`)}`).join('')
    + `\n本轮测试协调结论：${ref('s5-decision.output')}`
    + `\n上轮缺陷报告：${previous('s5-author.output')}\n上轮修复记录：${previous('s6-author.output')}`
    + `\n本轮缺陷报告：${ref('s5-author.output')}\n本轮修复记录：${ref('s6-author.output')}`;
}

function author(g, stage, full) {
  const id = `s${stage.number}`;
  const files = [5, 7].includes(stage.number) ? ref('preflight.output.evidenceFiles')
    : full && stage.number >= 4 ? ref('s2-author.output.allowedFiles') : ref('preflight.output.allowedFiles');
  g.agent(`${id}-author`, `${stage.number} ${ROLES[stage.owner].name} Agent · ${stage.title}`, `你是负责${stage.title}的${ROLES[stage.owner].name} Agent。`,
    COMMON + '不能完成时 state=clarify，questions 不得为空；本轮产物可供评审时 state=ready 且 questions=[]。' + phaseCriteria(stage.number) + stage.instructions, authorInput(stage, full), AUTHOR_FIELDS, { mode: stage.mode, ...(stage.mode === 'code' ? { files } : {}) });
  g.route(`${id}-author-ready`, '本轮工作可评审？', `${ref(`${id}-author.output.state`)}:${ref(`${id}-author.output.questions`)}`, 'ready:[]');
  g.node(`${id}-author-questions`, 'flow.user-input', `${stage.number} 补充无法决策的问题`, {
    title: `${stage.title} · 需要补充`, interaction: 'text', prompt: ref(`${id}-author.output.questions`) });
  g.edge(`${id}-author`, `${id}-author-ready`);
  g.edge(`${id}-author-ready`, `${id}-author-questions`, 'false');
  return `${id}-author-ready`;
}

function reviews(g, stage, full) {
  const id = `s${stage.number}`;
  const reviews = stage.reviewers.map(role => `${id}-review-${role}`);
  if (reviews.length > 1) {
    g.node(`${id}-parallel`, 'flow.parallel', `${stage.number} 独立角色并行评审`, { joinNodeId: `${id}-join` });
    g.node(`${id}-join`, 'flow.join', `${stage.number} 等待全部评审`, {});
  }
  for (const role of stage.reviewers) {
    g.agent(`${id}-review-${role}`, `${stage.number} ${ROLES[role].name} Agent · 独立评审`, `你是独立${ROLES[role].name}评审 Agent，重点：${ROLES[role].focus}。`,
      REVIEW_INSTRUCTIONS + phaseCriteria(stage.number) + (stage.number === 7 ? '验收必须逐检查项全部认可（100%）。' : ''),
      materialInput(stage, full) + `\n本轮完整产物和共同清单：${ref(`${id}-author.output`)}`
        + `\n上轮协调结论：${previous(`${id}-decision.output`)}`
        + `\n前轮缺陷/修复：${previous('s5-author.output')}\n${previous('s6-author.output')}`
        + `\n本轮修复：${ref('s6-author.output')}`, REVIEW_FIELDS);
    if (reviews.length > 1) {
      g.edge(`${id}-parallel`, `${id}-review-${role}`);
      g.edge(`${id}-review-${role}`, `${id}-join`);
    }
  }
  g.agent(`${id}-decision`, `${stage.number} 协调 Agent · 复核检查项`, '你是评审汇总协调 Agent，只复核证据、对齐分歧，不代其他角色批准。',
    DECISION_INSTRUCTIONS + phaseCriteria(stage.number), `当前阶段：${stage.number} ${stage.title}\n本轮产物：${ref(`${id}-author.output`)}`
      + `\n上轮协调结论：${previous(`${id}-decision.output`)}`
      + stage.reviewers.map(role => `\n${ROLES[role].name}评审：${ref(`${id}-review-${role}.output`)}`).join(''), DECISION_FIELDS);
  g.edge(reviews.length > 1 ? `${id}-join` : reviews[0], `${id}-decision`);
  // An integer whitelist implements >=90 with existing contains routing, including blockers/questions in the same token.
  for (const role of stage.reviewers) {
    const nodeId = `${id}-guard-${role}`;
    g.node(nodeId, 'flow.route', `${ROLES[role].name}认可率及阻断检查`, { input: threshold(stage.number === 7 ? 100 : 90), operator: 'contains',
      expected: `|${ref(`${id}-review-${role}.output.score`)}:${ref(`${id}-review-${role}.output.blockers`)}:${ref(`${id}-review-${role}.output.questions`)}|` });
  }
  g.route(`${id}-guard-decision`, '检查项与证据已核对？',
    `${ref(`${id}-decision.output.route`)}:${ref(`${id}-decision.output.reconciled`)}:${ref(`${id}-decision.output.questions`)}`, 'aligned:true:[]');
  g.route(`${id}-needs-human`, '需要用户决策？', ref(`${id}-decision.output.route`), 'clarify');
  g.node(`${id}-review-questions`, 'flow.user-input', `${stage.number} 用户处理未决问题`, {
    title: `${stage.title} · 未决问题`, interaction: 'text', prompt: ref(`${id}-decision.output.questions`) });
  const guards = [...stage.reviewers.map(role => `${id}-guard-${role}`), `${id}-guard-decision`];
  g.edge(`${id}-decision`, guards[0]);
  guards.forEach((guard, index) => {
    g.edge(guard, index + 1 < guards.length ? guards[index + 1] : `${id}-passed`, 'true');
    g.edge(guard, `${id}-needs-human`, 'false');
  });
  g.edge(`${id}-needs-human`, `${id}-review-questions`, 'true');
  return reviews.length > 1 ? `${id}-parallel` : reviews[0];
}

function stageReports(g, stage) {
  const id = `s${stage.number}`;
  // Whole arrays preserve literal templates and blank lines through the existing collector and file writer.
  g.report(`${id}-passed`, `${stage.number} ${stage.title} · 已通过 · status=aligned`, ref(`${id}-author.output.artifact`));
  g.report(`${id}-unresolved`, `${stage.number} ${stage.title} · 未完成，尚未达成一致 · status=unfinished`, ref(`${id}-author.output.artifact`));
  for (const status of ['passed', 'unresolved']) {
    g.file(`${id}-${status}-file`, `${stage.number} 保存完整产物`, `${id}-${status}`,
      `0${stage.number}-${stage.artifact}.md`, ref(`${id}-${status}.items`));
  }
  const prefix = `audit/0${stage.number}-${stage.artifact}`;
  g.file(`${id}-author-file`, `${stage.number} 保存作者原始记录`, `${id}-author`, `${prefix}-author.json`, ref(`${id}-author.output`));
  g.file(`${id}-decision-file`, `${stage.number} 保存协调结论`, `${id}-decision`, `${prefix}-decision.json`, ref(`${id}-decision.output`));
  const reviewNode = stage.reviewers.length > 1 ? `${id}-join` : `${id}-review-${stage.reviewers[0]}`;
  g.file(`${id}-reviews-file`, `${stage.number} 保存全员评审`, reviewNode, `${prefix}-reviews.json`,
    ref(stage.reviewers.length > 1 ? reviewNode : `${reviewNode}.output`));
}

function stageFlow(g, stage, full, { retry = true, fix = false } = {}) {
  const id = `s${stage.number}`;
  author(g, stage, full);
  const entry = reviews(g, stage, full);
  stageReports(g, stage);
  g.edge(`${id}-author-ready`, entry, 'true');
  g.loop(`${id}-loop`, `${stage.number} 修订复审 · 总计五轮`, `${id}-author`, { maxStagnantIterations: 2,
    progressInput: ref(`${id}-decision.output.resolvedIssueIds`) });
  g.edge(`${id}-loop`, `${id}-unresolved`, 'exit');
  g.edge(`${id}-author-questions`, `${id}-loop`);
  if (fix) {
    const repair = stageFlow(g, STAGES[5], full, { retry: false });
    g.edge(`${id}-needs-human`, repair.entry, 'false');
    g.edge(`${id}-review-questions`, repair.entry);
    g.edge(repair.passed, `${id}-loop`);
    g.edge(repair.unresolved, `${id}-loop`);
  } else {
    g.edge(`${id}-needs-human`, retry ? `${id}-loop` : `${id}-unresolved`, 'false');
    g.edge(`${id}-review-questions`, `${id}-loop`);
  }
  return { entry: `${id}-author`, passed: `${id}-passed`, unresolved: `${id}-unresolved` };
}

function build(name, stages, { full = false, fix = false } = {}) {
  const g = graph(name);
  startup(g, stages);
  let preceding = 'preflight-ready';
  const failed = ['preflight-unresolved'];
  for (const stage of stages) {
    if (fix && stage.number === 6) { continue; }
    const flow = stageFlow(g, stage, full, { retry: ![5, 7].includes(stage.number), fix: fix && stage.number === 5 });
    g.edge(preceding, flow.entry, preceding === 'preflight-ready' ? 'true' : undefined);
    preceding = flow.passed;
    failed.push(flow.unresolved);
  }
  g.node('end', 'flow.end', '本次执行结论', { input: '' });
  g.edge(preceding, 'end');
  failed.forEach(id => g.edge(id, 'end'));
  return g.finish();
}

// Independent fifth/sixth workflows do not invoke one another; the ninth explicitly owns their shared loop.
export function buildWorkflows() {
  return [
    { file: '00-full-pipeline.workflow.json', document: build('软件开发七阶段 · 完整流水线', STAGES, { full: true, fix: true }) },
    ...STAGES.map(stage => ({ file: `0${stage.number}-${stage.key}.workflow.json`, document: build(`研发阶段 ${stage.number} · ${stage.title}`, [stage]) })),
    { file: '08-verification-fix-loop.workflow.json', document: build('测试验证与缺陷修复 · 联跑循环', [STAGES[4], STAGES[5]], { fix: true }) }
  ];
}

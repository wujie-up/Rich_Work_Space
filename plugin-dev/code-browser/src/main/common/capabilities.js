import { gitActions } from './git-actions.js';
import { lifecycles } from './maven-phases.js';

const path = { type: 'string', maxLength: 2048, description: '相对用户已选项目目录的路径' };
const revision = { type: 'string', minLength: 1, maxLength: 200, description: 'Git 提交 SHA、分支、标签或 HEAD~1 等版本表达式' };
const lines = { startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } };

export const tools = [
  { name: 'edit', title: '读取可编辑文件', description: '完整读取不超过 128 KiB 的 UTF-8 文件及保存校验版本。', properties: { path }, required: ['path'] },
  { name: 'save', title: '保存源码', description: '保存已有 UTF-8 文件，校验 edit 返回的 revision；外部修改时拒绝覆盖。保留 BOM 和换行格式。',
    properties: { path, text: { type: 'string', maxLength: 131072 }, revision: { type: 'string', minLength: 64, maxLength: 64 } },
    required: ['path', 'text', 'revision'], effects: ['filesystem.write'], confirmation: 'always' },
  { name: 'springApps', title: '发现 Spring Boot 项目', description: '按需扫描 Maven 项目内的 Spring Boot 启动类及运行状态。轻量扫描，最多 10000 项/200 个应用/10 秒。', properties: {} },
  { name: 'springTask', title: 'Spring Boot 日志', description: '读取指定启动任务的状态与末尾 128 KiB 日志。', properties: { id: { type: 'string' } }, required: ['id'] },
  { name: 'startSpring', title: '启动 Spring Boot', description: '使用所属模块的 Maven spring-boot:run 启动已发现的主类，会执行项目逻辑并可能下载依赖。最多同时运行 8 个应用。',
    properties: { path }, required: ['path'], effects: ['filesystem.write', 'process.execute', 'network.write'], confirmation: 'always' },
  { name: 'stopSpring', title: '停止 Spring Boot', description: '停止指定应用及其进程组，保留日志。', properties: { id: { type: 'string' } }, required: ['id'], effects: ['process.execute'] },
  { name: 'workspace', title: '当前代码项目', description: '获取用户在coding插件中选择的项目目录；无项目时请用户先打开插件选择。', properties: {} },
  { name: 'list', title: '列出源码目录', description: '列出项目子目录和文件，忽略生成目录和符号链接。最多返回 2000 项。', properties: { path, compact: { type: 'boolean' } } },
  { name: 'read', title: '读取源码', description: '读取 UTF-8 源码，支持 Java、Vue、JS、TS 等。单次最多 500 行/128 KiB，文件不超过 1 MiB。',
    properties: { path, ...lines }, required: ['path'] },
  { name: 'search', title: '搜索源码文本', description: '在项目源码中区分大小写地搜索字面文本，忽略生成目录；达到上限返回 truncated。',
    properties: { query: { type: 'string', minLength: 1, maxLength: 256 }, path,
      limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['query'] },
  { name: 'definitions', title: '查找 Java 定义', description: '按精确名称查找当前项目 Java 类和方法声明，返回候选 path、line、kind。轻量词法扫描，不解析继承、依赖库或重载语义；最多 100 个候选、10000 项或 10 秒，达到上限返回 truncated。',
    properties: { name: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['name'] },
  { name: 'log', title: '查看 Git 提交', description: '读取已选项目范围内的 Git 提交历史，可按文件过滤。',
    properties: { revision, path, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
  { name: 'diff', title: '比较 Git 版本', description: '读取两个提交之间的统一差异。target 也可为 WORKTREE（含暂存与未暂存修改）或 INDEX（暂存区）。不含未跟踪文件。完整差异上限 128 KiB；指定 path 的差异及 summary 文件列表上限 8 MiB。',
    properties: { base: revision, target: { ...revision, description: '提交表达式，或 WORKTREE、INDEX；默认 WORKTREE' }, path,
      summary: { type: 'boolean', description: '只返回变更文件列表，不读取补丁；默认 false' } } },
  { name: 'show', title: '读取历史源码', description: '读取某个 Git 提交中的文件，支持已删除文件。行数与大小限制同读取源码。',
    properties: { revision, path, ...lines }, required: ['path'] },
  { name: 'gitStatus', title: 'Git 仓库状态', description: '读取已选目录所属仓库根、分支、远程名称、文件状态、冲突及储藏。写操作作用于整个所属仓库。', properties: {} },
  { name: 'gitTask', title: 'Git 任务状态', description: '读取最近一次 Git 管理任务，日志限量；刷新后可继续观察。', properties: {} },
  { name: 'gitOperation', title: '执行 Git 管理操作',
    description: '执行结构化 Git 白名单操作，作用于已选目录所属的整个仓库。包括提交、更新、推送、分支、集成、储藏及回滚；可能执行仓库 hooks、过滤器并写入远程。与 Agent 共享资源互斥，立即返回任务，使用 code.gitTask 查询，code.cancelGit 停止。硬重置、丢弃修改及删除储藏需 confirmed:true。',
    properties: { action: { type: 'string', enum: Object.keys(gitActions) },
      branch: { type: 'string', maxLength: 200 }, newBranch: { type: 'string', maxLength: 200 }, revision,
      localBranch: { type: 'string', maxLength: 200, description: '更新或推送的本地分支，默认当前分支；非当前分支仅支持快进更新' },
      remote: { type: 'string', maxLength: 200 }, message: { type: 'string', maxLength: 4000 },
      paths: { type: 'array', maxItems: 200, items: { ...path, description: '相对实际 Git 仓库根目录的路径' } }, all: { type: 'boolean' }, includeUntracked: { type: 'boolean' },
      mode: { type: 'string', enum: ['soft', 'mixed', 'hard'] }, pullMode: { type: 'string', enum: ['ff-only', 'merge', 'rebase'] },
      mainline: { type: 'integer', minimum: 1, maximum: 100 }, stash: { type: 'string', maxLength: 100 }, confirmed: { type: 'boolean' } },
    required: ['action'], effects: ['filesystem.write', 'process.execute', 'network.write'], confirmation: 'always' },
  { name: 'cancelGit', title: '停止 Git 任务', description: '停止指定任务及其进程组。已经发生的修改不会自动恢复，请刷新仓库状态检查未完成操作。',
    properties: { id: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['id'], effects: ['process.execute'] },
  { name: 'mavenProjects', title: '发现 Maven 项目', description: '按需查找项目内 pom.xml，跳过依赖与构建目录，最多 200 个项目/10000 项/10 秒，达到上限返回 truncated。', properties: {} },
  { name: 'compile', title: 'Maven 编译',
    description: '在已选项目或模块目录执行白名单 Maven 生命周期阶段（默认 compile），优先 mvnw，否则 mvn。会执行构建逻辑、写构建产物和依赖缓存并可能联网。立即返回任务，使用 code.build 读取日志/状态，code.cancelBuild 停止。最多运行 10 分钟。',
    properties: { path, phase: { type: 'string', enum: Object.values(lifecycles).flat() },
      clean: { type: 'boolean', description: '先执行 clean' }, skipTests: { type: 'boolean', description: '跳过测试执行' },
      alsoMake: { type: 'boolean', description: '从根 POM 使用 -pl/-am 构建所选模块及其依赖' } }, effects: ['filesystem.write', 'process.execute', 'network.write'], confirmation: 'always' },
  { name: 'build', title: '读取编译状态', description: '获取最近一次 Maven 编译任务及日志；task 为 null 表示尚无任务。日志仅保留末尾 128 KiB。',
    properties: {} },
  { name: 'cancelBuild', title: '停止 Maven 编译', description: '停止指定 ID 的 Maven 编译任务及其进程组，保留已产生的文件和日志。',
    properties: { id: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['id'], effects: ['process.execute'] }
];

export function descriptor(tool) {
  return { id: `code.${tool.name}`, version: 1, title: tool.title, description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required || [], additionalProperties: false },
    outputSchema: { type: 'object' }, effects: tool.effects || ['filesystem.read'], confirmation: tool.confirmation || 'policy',
    execution: { timeoutMs: 20000, cancellable: true, retry: 'never' }, state: 'ready' };
}

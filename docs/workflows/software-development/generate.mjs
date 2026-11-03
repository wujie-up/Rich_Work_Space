import { mkdir, writeFile } from 'node:fs/promises';
import { buildWorkflows } from './workflows.mjs';
import { createRegistry } from '../../../plugin-dev/work-flow/src/main/common/nodes.js';
import { Workflows } from '../../../plugin-dev/work-flow/src/main/common/workflows.js';
import { WorkflowTransfer } from '../../../plugin-dev/work-flow/src/main/common/workflow-transfer.js';

const registry = createRegistry({ credentials: {} });
const workflows = new Workflows({ storage: {}, pluginId: 'work-flow', classify: type => registry.list().find(node => node.type === type) });
const transfer = new WorkflowTransfer({ workflows, types: () => registry.list(), activeRun: () => false, logger: () => {} });
const entries = buildWorkflows();
// Validate the entire set before writing; generation never imports into an installed plugin or changes user data.
for (const entry of entries) { transfer.preview(entry.document); }
await mkdir(new URL('./exports/', import.meta.url), { recursive: true });
for (const { file, document } of entries) {
  await writeFile(new URL(`./exports/${file}`, import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
  console.info(`workflow-export: ${file}; nodes=${document.workflow.nodes.length}; edges=${document.workflow.edges.length}`);
}

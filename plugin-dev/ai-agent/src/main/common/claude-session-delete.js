import { deleteSession } from '@anthropic-ai/claude-agent-sdk';

// A separate process keeps the SDK's config-directory cache out of the multi-profile plugin worker.
try {
  await deleteSession(process.argv[2], { dir: process.argv[3] });
} catch (error) {
  console.error('Claude session deletion failed');
  process.exitCode = 1;
}

// Playwright error messages may contain form values; retain stack frames without page data or credentials.
export function logError(context, error) {
  const safe = new Error('Browser operation failed');
  safe.stack = `${safe.name}: ${safe.message}\n${String(error.stack || '').split('\n').filter(line => /^\s+at /.test(line)).join('\n')}`;
  console.error(`[ai-browser] ${context}`, safe);
}

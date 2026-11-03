const cancelled = () => Object.assign(Error('查询已取消'), { code: 'CANCELLED' });

export async function mapConcurrent(items, limit, mapper, signal) {
  if (signal?.aborted) { throw cancelled(); }
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const results = new Array(items.length);
  let next = 0;
  let failure;
  async function worker() {
    while (!combined.aborted && next < items.length) {
      const index = next++;
      try {
        results[index] = await mapper(items[index], combined, index);
      } catch (error) {
        failure ||= signal?.aborted ? cancelled() : error;
        controller.abort();
      }
    }
  }
  // Join cancelled siblings too, so a failed query leaves no active requests behind.
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) { throw failure; }
  if (signal?.aborted) { throw cancelled(); }
  return results;
}

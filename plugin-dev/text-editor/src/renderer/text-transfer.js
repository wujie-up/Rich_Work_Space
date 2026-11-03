const chunkSize = 64 * 1024;
const textFields = { 'editor.save': { index: 1, fields: ['text'] }, 'editor.draft': { index: 0, fields: ['text', 'saved'] } };

// Keep each request below the host limit, including JSON escaping and multibyte characters.
export async function invokeText(call, method, args) {
  const spec = textFields[method];
  if (!spec || JSON.stringify(args).length <= chunkSize) {
    return call(method, args);
  }
  const payload = args[spec.index];
  const metadata = [...args];
  metadata[spec.index] = { ...payload };
  const lengths = {};
  for (const field of spec.fields) {
    lengths[field] = payload[field].length;
    metadata[spec.index][field] = '';
  }
  const id = await call('editor.transfer.start', [method, metadata, lengths]);
  try {
    for (const field of spec.fields) {
      const text = payload[field];
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + chunkSize, text.length);
        // Do not split a surrogate pair: backend UTF-8 byte counts must match the final text.
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) {
          end -= 1;
        }
        await call('editor.transfer.append', [id, field, text.slice(offset, end)]);
        offset = end;
      }
    }
    return await call('editor.transfer.finish', [id]);
  } catch (error) {
    console.error('[text-editor] text transfer failed', { method, transferId: id, error });
    try {
      await call('editor.transfer.abort', [id]);
    } catch (cleanupError) {
      // Expiry also releases abandoned transfers when the desktop connection is lost.
      console.error('[text-editor] text transfer cleanup failed', { method, transferId: id, error: cleanupError });
    }
    throw error;
  }
}

import { escape as e } from './api.js';

// Both workflow tasks and menu tasks expose the same AI plugin questions and approvals.
export function agentRequests(requests = [], kind = 'plan') {
  return requests.map((request, index) => `<div class="warning"><pre class="output">${e(JSON.stringify(request.params, null, 2))}</pre>
    ${request.method === 'item/tool/requestUserInput' ? `<label>回答（按问题 ID 填写）<textarea id="request-${kind}-${index}" rows="3"
      placeholder='{"question_id":"回答"}'></textarea></label><button data-answer="${index}" data-kind="${kind}" title="发送回答" aria-label="发送回答" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 18 9-18 9 4-9z M7 12h14"/></svg></button>`
      : `${kind === 'code' ? `<button data-approval="${index}" data-kind="${kind}" data-decision="accept" title="批准本次请求" aria-label="批准本次请求" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l5 5L20 6"/></svg></button>` : ''}
      <button data-approval="${index}" data-kind="${kind}" data-decision="decline" title="拒绝" aria-label="拒绝" class="icon-button"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12 M6 18L18 6"/></svg></button>`}</div>`).join('');
}

import { escape as e } from './api.js';

// Both workflow tasks and menu tasks expose the same AI plugin questions and approvals.
export function agentRequests(requests = [], kind = 'plan') {
  return requests.map((request, index) => `<div class="warning"><pre class="output">${e(JSON.stringify(request.params, null, 2))}</pre>
    ${request.method === 'item/tool/requestUserInput' ? `<label>回答（按问题 ID 填写）<textarea id="request-${kind}-${index}" rows="3"
      placeholder='{"question_id":"回答"}'></textarea></label><button data-answer="${index}" data-kind="${kind}">发送回答</button>`
      : `${kind === 'code' ? `<button data-approval="${index}" data-kind="${kind}" data-decision="accept">批准本次请求</button>` : ''}
      <button data-approval="${index}" data-kind="${kind}" data-decision="decline">拒绝</button>`}</div>`).join('');
}

import { formatReviewSections } from '../../shared/review-sections.js';
import { formatUserInputPrompt } from '../../shared/user-input-prompt.js';

// The host owns presentation; this pump advances runs even when no workflow view is open.
export class WorkflowInteractions {
  constructor({ engine, messages, logger }) {
    Object.assign(this, { engine, messages, logger });
    this.requests = new Map();
    this.stopped = false;
  }

  start() {
    this.timer = setInterval(() => {
      if (!this.task && !this.stopped) {
        this.task = this.tick().catch(error => this.logger('error', 'interaction-pump', { message: error.message, stack: error.stack }))
          .finally(() => { this.task = null; });
      }
    }, 400);
    this.timer.unref();
  }

  async tick() {
    for (const run of this.engine.records.values()) {
      if (this.stopped) { return; }
      if (run.status === 'waiting' && run.pending?.kind === 'service' && (!run.pending.interaction || run.pending.parallel)) {
        await this.engine.resume(run.id);
      }
      const pending = run.pending;
      const batch = pending?.interaction;
      const question = batch?.questions[batch.currentIndex];
      const approval = !question && pending?.task?.requests?.find(request => request.method !== 'item/tool/requestUserInput');
      const key = question || approval ? JSON.stringify([run.id, run.resumeCount || 0, pending.nodeId,
        pending.request?.taskKey, batch?.id, question?.id, approval?.id]) : null;
      const previous = this.requests.get(run.id);
      if (previous && (previous.key !== key || run.status !== 'waiting')) {
        await this.messages.cancel(previous.id);
        this.requests.delete(run.id);
      }
      if ((!question && !approval) || this.stopped || run.status !== 'waiting') { continue; }
      let message = this.requests.get(run.id);
      if (!message) {
        const options = approval ? ['允许本次', '拒绝'] : question.options.map((option, index) => question.descriptions[index]
          ? `${option} — ${question.descriptions[index]}` : option);
        const prompt = approval ? `Agent 请求授权：${approval.method}\n${JSON.stringify(approval.params, null, 2)}`
          : [batch.context, question.question].filter(Boolean).join('\n\n');
        message = await this.messages.request({ key, title: approval ? `${run.workflowName} · Agent 授权确认`
            : `${run.workflowName} · 第 ${batch.currentIndex + 1} / ${batch.questions.length} 题`,
          required: pending.kind === 'service', placement: 'center', sections: formatReviewSections(prompt, question?.question),
          optionsOnly: Boolean(approval) || pending.request?.form?.interaction === 'choice',
          question: approval ? prompt : formatUserInputPrompt(prompt), options });
        if (this.stopped || run.status !== 'waiting') { await this.messages.cancel(message.id); continue; }
        message = { key, id: message.id, options };
        this.requests.set(run.id, message);
      }
      const result = await this.messages.get(message.id);
      if (result.state === 'deferred' && run.status === 'waiting') {
        await this.engine.interrupt(run.id);
        this.requests.delete(run.id);
      }
      if (result.state === 'answered' && !message.handled && !this.stopped) {
        if (approval) {
          await this.engine.respond(run.id, { requestId: approval.id, decision: result.answer.text === '允许本次' ? 'accept' : 'decline' });
          message.handled = true;
          continue;
        }
        const index = message.options.indexOf(result.answer.text);
        await this.engine.answer(run.id, { batchId: batch.id, questionId: question.id,
          text: index < 0 ? result.answer.text : question.options[index] });
        this.requests.delete(run.id);
      }
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const request of this.requests.values()) { await this.messages.cancel(request.id); }
    this.requests.clear();
  }
}

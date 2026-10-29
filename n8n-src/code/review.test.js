const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReviewPage, parseDecision, outgoingEmail, safeId } = require('./review');
const { decisionTask, inquiryTask, maskSecrets, formatAlert, buildRunLog } = require('./records');

const draft = { subject: 'Re: office cleaning', body: 'Hi Dana,\nThanks for reaching out.' };

test('review page escapes inquiry text and posts to the resume URL', () => {
  const page = buildReviewPage({
    inquiry: { name: '<script>x</script>', email: 'a@example.com', source: 'form', received_at: 'now', message: 'Hi & hello' },
    qualification: { tier: 'qualified', topic: 'regular_cleaning', urgency: 'normal', reason: 'r' },
    draft, recordUrl: 'https://demo.my.salesforce.com/lightning/r/Lead/00QA/view', resumeUrl: 'http://localhost:5680/webhook-waiting/42',
  });
  assert.ok(!page.includes('<script>x</script>'));
  assert.ok(page.includes('&lt;script&gt;'));
  assert.ok(page.includes('action="http://localhost:5680/webhook-waiting/42"'));
  assert.ok(page.includes('Open record in Salesforce'));
  assert.ok(page.includes('name="reviewer"'));
});

test('missing reviewer or decision is not accepted', () => {
  const result = parseDecision({ subject: 's', body: 'b' }, draft);
  assert.deepEqual(result.errors, ['Your name is required', 'Choose Approve or Reject']);
});

test('approve with edits reports edited=true and keeps the edited text', () => {
  const result = parseDecision({ reviewer: 'Morgan (Ops)', decision: 'approve', subject: 'Re: office cleaning', body: 'Hi Dana,\r\nWe can walk the site Tuesday.' }, draft);
  assert.deepEqual(result.errors, []);
  assert.equal(result.edited, true);
  assert.equal(result.body, 'Hi Dana,\nWe can walk the site Tuesday.');
});

test('unchanged approve reports edited=false; no body means timeout', () => {
  assert.equal(parseDecision({ reviewer: 'M', decision: 'approve', subject: draft.subject, body: draft.body }, draft).edited, false);
  assert.equal(parseDecision(undefined, draft).timedOut, true);
});

test('demo mode always redirects the reply and refuses without a redirect inbox', () => {
  assert.deepEqual(outgoingEmail({ to: 'dana@example.com', subject: 'Hi', body: 'b', demoMode: true, redirectTo: 'leads+replies@gmail.com' }), { to: 'leads+replies@gmail.com', subject: '[demo → dana@example.com] Hi', body: 'b' });
  assert.throws(() => outgoingEmail({ to: 'dana@example.com', subject: 'Hi', body: 'b', demoMode: true, redirectTo: '' }));
});

test('decision tasks name the reviewer', () => {
  const approved = decisionTask('00QA', { decision: 'approve', reviewer: 'Morgan', edited: true, subject: 's', body: 'b' }, { date: '2026-10-30', sentTo: 'x@gmail.com' });
  assert.equal(approved.WhoId, '00QA');
  assert.equal(approved.Subject, 'AI reply approved by Morgan');
  assert.match(approved.Description, /edited: yes, approved by Morgan on 2026-10-30, sent to x@gmail.com/);
  assert.equal('Inquiry_Source_ID__c' in approved, false);
  assert.match(decisionTask('00QA', { decision: 'reject', reviewer: 'Morgan' }, { date: '2026-10-30' }).Description, /rejected by Morgan .* nothing sent/);
  assert.equal(decisionTask('00QA', { timedOut: true }, { date: '2026-10-30' }).Subject, 'AI reply review timed out');
});

test('inquiry task keeps the message, the AI reason and the source id', () => {
  const task = inquiryTask('00QA', { source: 'form', source_id: 'form:tw-demo-0001', received_at: '2026-10-30T01:02:03Z', subject: 'Website contact form', message: 'We need weekly cleaning for a 3,200 sq ft dental office in Oakland, starting in December, please.' }, { tier: 'qualified', topic: 'regular_cleaning', urgency: 'normal', reason: 'Clear need. Quote: "weekly cleaning"' });
  assert.equal(task.Inquiry_Source_ID__c, 'form:tw-demo-0001');
  assert.equal(task.ActivityDate, '2026-10-30');
  assert.equal(task.Status, 'Completed');
  assert.ok(task.Subject.startsWith('Inquiry via form: We need weekly cleaning'));
  assert.ok(task.Subject.length <= 80);
  assert.match(task.Description, /^\[form\] 2026-10-30T01:02:03Z\nWebsite contact form\n\nWe need weekly/);
  assert.match(task.Description, /AI: qualified \/ regular_cleaning \/ normal — Clear need\./);
});

test('alerts mask tokens and webhook URLs', () => {
  assert.equal(maskSecrets('Bearer abc and https://hooks.slack.com/services/T/B/C'), 'Bearer *** and https://hooks.slack.com/***');
  assert.equal(maskSecrets('token 00D5g000004XyZa!AQ4AQ.abc_def failed'), 'token *** failed');
  assert.match(formatAlert({ workflow: { id: 'wf', name: 'Process inquiry' }, execution: { id: '9', lastNodeExecuted: 'Create lead', error: { message: 'sk-secret failed' } } }).text, /Error: \*\*\* failed/);
});

test('run log and safe ids', () => {
  assert.equal(safeId('email:<t2@example.com>'), 'email_t2_example.com');
  const log = buildRunLog({ inquiry: { source_id: 'form:tw-1', source: 'form', email: 'a@example.com' }, recordType: 'Lead', recordId: '00QA', action: 'created', qualification: { tier: 'qualified', llm_ok: true, llm_error: null }, draft: 'approved' });
  assert.equal(log.action, 'created');
  assert.equal(log.tier, 'qualified');
  assert.deepEqual([log.record_type, log.record_id], ['Lead', '00QA']);
});

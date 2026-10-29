// Generates workflows/*.json. Code-node logic lives in n8n-src/code/*.js so it can be unit tested.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const root = dirname(fileURLToPath(import.meta.url));
const outputDir = join(root, '..', 'workflows');

const { PERSON_FIELDS } = createRequire(import.meta.url)('./code/match.js');
const CREDS = {
  salesforce: { oAuth2Api: { id: 'salesforceOAuthCred01', name: 'Salesforce (client credentials)' } },
  openai: { httpHeaderAuth: { id: 'openAiCred01', name: 'OpenAI' } },
  imap: { imap: { id: 'gmailImapCred01', name: 'Gmail IMAP (demo inbox)' } },
  smtp: { smtp: { id: 'gmailSmtpCred01', name: 'Gmail SMTP (demo inbox)' } },
};

const id = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// n8n registers production webhooks by webhookId; derive a stable UUID from the path.
const stableUuid = (value) => createHash('sha1').update(value).digest('hex').slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const at = (node, x, y) => ({ ...node, position: [x, y] });
const edge = (node, index = 0) => ({ node, type: 'main', index });
const note = (name, content, x, y, width, height, color) => ({ id: `note-${id(name)}`, name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y], parameters: { content, width, height, color } });

// Strip the CommonJS export line so the module bodies can be inlined into a Code node.
const source = (...names) => names.map((name) => readFileSync(join(root, 'code', `${name}.js`), 'utf8').replace(/^if \(typeof module !== 'undefined'\).*$/m, '').trim()).join('\n\n');

function loadPrompt(name) {
  const text = readFileSync(join(root, '..', 'prompts', `${name}.md`), 'utf8');
  const section = (title) => (text.split(/^## /m).find((part) => part.startsWith(title)) || '').slice(title.length).trim();
  const schema = section('JSON schema').match(/```json\s*([\s\S]*?)```/);
  return { system: section('System'), userTemplate: section('User template'), schema: schema ? JSON.parse(schema[1]) : null };
}

const code = (name, jsCode) => ({ id: id(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: { jsCode } });
const ifNode = (name, leftValue, operator, rightValue = '') => ({
  id: id(name), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [0, 0],
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ id: `${id(name)}-condition`, leftValue, rightValue, operator }], combinator: 'and' }, options: {} },
});
const isTrue = { type: 'boolean', operation: 'true', singleValue: true };
const equals = { type: 'string', operation: 'equals' };
const notEmpty = { type: 'string', operation: 'notEmpty', singleValue: true };
const greater = { type: 'number', operation: 'gt' };

const webhook = (name, path, method = 'POST') => ({ id: id(name), name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: stableUuid(path), parameters: { httpMethod: method, path, responseMode: 'responseNode', options: {} } });
const respond = (name, { body, code: status = 200, html = false, json = false }) => ({
  id: id(name), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [0, 0],
  parameters: {
    respondWith: json ? 'json' : 'text', responseBody: body,
    options: { responseCode: status, ...(html ? { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } } : {}) },
  },
});

const fullResponse = { response: { response: { fullResponse: true, neverError: true, responseFormat: 'autodetect' } } };
// Paths are relative to /services/data/<version>; the OAuth2 credential gets and renews the token.
const salesforce = (name, method, pathExpression, bodyExpression, { full = false } = {}) => ({
  id: id(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, credentials: CREDS.salesforce,
  parameters: {
    method, url: `={{ $env.SF_INSTANCE_URL + '/services/data/' + $env.SF_API_VERSION + ${pathExpression} }}`, authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api',
    ...(bodyExpression ? { sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${bodyExpression}) }}` } : {}),
    options: full ? fullResponse : {},
  },
});
// Errors continue as an item with `error`, so a failed AI call still ends in a saved lead.
const openai = (name) => ({
  id: id(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput', credentials: CREDS.openai,
  parameters: {
    method: 'POST', url: 'https://api.openai.com/v1/chat/completions', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ model: $env.OPENAI_MODEL, ...$json.request }) }}', options: { timeout: 60000 },
  },
});
const slack = (name, textExpression) => ({
  id: id(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0], retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
  parameters: { method: 'POST', url: '={{ $env.SLACK_WEBHOOK_URL }}', sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify({ text: ${textExpression} }) }}`, options: {} },
});
const callProcess = (name) => ({
  id: id(name), name, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [0, 0],
  parameters: {
    source: 'database', workflowId: { __rl: true, value: 'wfProcessInquiry', mode: 'id' }, mode: 'each',
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
    options: { waitForSubWorkflow: false },
  },
});

const workflow = (wfId, name, nodes, connections, errorWorkflow = true) => ({
  id: wfId, name, active: false,
  settings: { executionOrder: 'v1', ...(errorWorkflow ? { errorWorkflow: 'wfErrorHandler' } : {}) },
  nodes, connections, pinData: {}, versionId: '1',
});

const loadFixtures = "JSON.parse(require('fs').readFileSync('/files/sample-data/fixtures.json', 'utf8')).fixtures";
const runLogShape = (fields) => `[{ json: { runLog: ${fields} } }]`;
const recordLog = 'recordType: ctx.recordType, recordId: ctx.recordId, matchedBy: ctx.matchedBy';

// Shared tail: write the run log, then post any alerts to Slack.
function runLogTail(x, y) {
  return [
    at(code('Write run log', `${source('review', 'records', 'llm')}

const fs = require('fs');
const entry = $input.first().json.runLog;
const fixtures = ${loadFixtures};
const log = buildRunLog({ ...entry, fixtureId: fixtureIdFor(entry.inquiry.source_id, fixtures), executionId: $execution.id });
const name = safeId(entry.inquiry.source_id);
fs.mkdirSync('/files/output/run-log', { recursive: true });
fs.writeFileSync('/files/output/run-log/' + Date.now() + '-' + name + '.json', JSON.stringify(log, null, 2), 'utf8');
const reviewFile = '/files/output/review/' + name + '.json';
if (log.draft !== 'none' && fs.existsSync(reviewFile)) {
  const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  fs.writeFileSync(reviewFile, JSON.stringify({ ...review, status: log.draft, closed_at: log.ts }, null, 2), 'utf8');
}
return [{ json: log }];`), x, y),
    at(ifNode('Any alerts?', '={{ $json.alerts.length }}', greater, 0), x + 220, y),
    at(slack('Send alert', "$json.alerts.join('\\n')"), x + 440, y - 100),
  ];
}
const tailConnections = {
  'Write run log': { main: [[edge('Any alerts?')]] },
  'Any alerts?': { main: [[edge('Send alert')], []] },
};

function formIntake() {
  const nodes = [
    note('About', '## Form intake\n`POST /webhook/inquiry` from the website form. Bad input gets a 400 and a Slack alert; good input gets a 202 and goes to **Process inquiry**.', -80, -60, 1240, 140, 7),
    at(webhook('Receive form inquiry', 'inquiry'), 0, 200),
    at(code('Normalize form', `${source('normalize')}

const item = $input.first().json;
const demoMode = $env.DEMO_MODE === '1';
const inquiry = normalizeForm(item.body || {}, item.headers || {}, { demoMode });
return [{ json: { ...inquiry, validation: validateInquiry(inquiry, { demoOnly: demoMode }) } }];`), 220, 200),
    at(ifNode('Valid inquiry?', '={{ $json.validation.valid }}', isTrue), 440, 200),
    at(respond('Respond 202 accepted', { json: true, code: 202, body: '={{ JSON.stringify({ accepted: true, source_id: $json.source_id }) }}' }), 680, 100),
    at(callProcess('Process inquiry'), 900, 100),
    at(respond('Respond 400 rejected', { json: true, code: 400, body: "={{ JSON.stringify({ accepted: false, error: 'invalid_inquiry', reason: $json.validation.reason }) }}" }), 680, 320),
    at(code('Log rejected input', `${source('records')}

const inquiry = $('Normalize form').first().json;
return ${runLogShape("{ inquiry, action: 'rejected_input', alerts: [rejectedInputAlert(inquiry, inquiry.validation.reason)] }")};`), 900, 320),
    ...runLogTail(1120, 320),
  ];
  return workflow('wfFormIntake', 'Lead intake: website form', nodes, {
    'Receive form inquiry': { main: [[edge('Normalize form')]] },
    'Normalize form': { main: [[edge('Valid inquiry?')]] },
    'Valid inquiry?': { main: [[edge('Respond 202 accepted')], [edge('Respond 400 rejected')]] },
    'Respond 202 accepted': { main: [[edge('Process inquiry')]] },
    'Respond 400 rejected': { main: [[edge('Log rejected input')]] },
    'Log rejected input': { main: [[edge('Write run log')]] },
    ...tailConnections,
  });
}

function emailIntake() {
  const nodes = [
    note('About', '## Email intake\nWatches the demo inbox over IMAP (unread only, marked read after). The sender comes from Reply-To when present. Our own outgoing replies are skipped.', -80, -60, 1240, 140, 7),
    at({ id: 'watch-inbox', name: 'Watch inbox', type: 'n8n-nodes-base.emailReadImap', typeVersion: 2, position: [0, 0], credentials: CREDS.imap, parameters: { mailbox: 'INBOX', postProcessAction: 'read', format: 'resolved', options: { customEmailConfig: '["UNSEEN"]' } } }, 0, 200),
    at(code('Normalize email', `${source('normalize')}

// In demo mode, mail from real senders (for example Google's welcome emails) is skipped without an alert.
const demoMode = $env.DEMO_MODE === '1';
return $input.all()
  .map((item) => normalizeEmail(item.json, { selfAddress: $env.GMAIL_ADDRESS }))
  .filter((inquiry) => !inquiry.skip && !(demoMode && inquiry.email && !isDemoAddress(inquiry.email)))
  .map((inquiry) => ({ json: { ...inquiry, validation: validateInquiry(inquiry, { demoOnly: demoMode }) } }));`), 220, 200),
    at(ifNode('Valid inquiry?', '={{ $json.validation.valid }}', isTrue), 440, 200),
    at(callProcess('Process inquiry'), 680, 100),
    at(code('Log rejected input', `${source('records')}

return $input.all().map((item) => ({ json: { runLog: { inquiry: item.json, action: 'rejected_input', alerts: [rejectedInputAlert(item.json, item.json.validation.reason)] } } }));`), 680, 320),
    ...runLogTail(900, 320),
  ];
  return workflow('wfEmailIntake', 'Lead intake: email inbox', nodes, {
    'Watch inbox': { main: [[edge('Normalize email')]] },
    'Normalize email': { main: [[edge('Valid inquiry?')]] },
    'Valid inquiry?': { main: [[edge('Process inquiry')], [edge('Log rejected input')]] },
    'Log rejected input': { main: [[edge('Write run log')]] },
    ...tailConnections,
  });
}

function processInquiry() {
  const qualifyPrompt = loadPrompt('qualify');
  const draftPrompt = loadPrompt('draft-reply');
  const contactFields = PERSON_FIELDS.join(',');
  const mockLoader = (kind) => `${source('llm')}

const fs = require('fs');
const ctx = $input.first().json;
const id = fixtureIdFor(ctx.inquiry.source_id, ${loadFixtures});
const file = '/files/sample-data/mock-llm/' + id + '.${kind}.json';
const content = id && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
return [{ json: mockResponse(content, ${kind === 'qualify' ? 'Boolean(ctx.inquiry.demo_flags && ctx.inquiry.demo_flags.break_llm)' : 'false'}) }];`;

  const nodes = [
    note('Find record', '## 1. Find the Lead or Contact\nOne Composite call: a Task with this source id (repeat submission: stop here), then Contact and Lead by email, then by stored E.164 phone. Only if none matched: a phone search for numbers typed in another format.', -80, -120, 1840, 160, 7),
    note('Classify', '## 2. Classify\nOpenAI (or a stored mock answer) sorts the lead. Code checks the enums and that the quote is really in the message. Any failure becomes **Needs review** with no draft and a Slack alert.', 1820, -120, 1320, 160, 5),
    note('Write Salesforce', '## 3. Write to Salesforce\nUpdate the matched Lead or Contact, or create a Lead (if a duplicate rule blocks it, update the record it names). Then log a Task with the original message and the AI reason.', 3200, -120, 2200, 160, 4),
    note('Review', '## 4. Human review\nDraft a reply, post the review link to Slack and wait. Nothing is sent until a named reviewer approves; the decision is saved as a Task.', 5460, -120, 2640, 160, 6),

    at({ id: 'start', name: 'Start', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0], parameters: { inputSource: 'passthrough' } }, 0, 200),
    at(code('Build lookup', `${source('match')}

const inquiry = $input.first().json;
return [{ json: { inquiry, lookup: buildLookupRequest(inquiry, $env.SF_API_VERSION) } }];`), 220, 200),
    at(salesforce('Salesforce lookup', 'POST', "'/composite'", '$json.lookup', { full: true }), 440, 200),
    at(code('Resolve match', `${source('match')}

const match = resolveMatch($input.first().json);
const inquiry = $('Build lookup').first().json.inquiry;
return [{ json: { inquiry, record: match.record, matchedBy: match.matchedBy, duplicate: match.duplicate, phoneSearch: inquiry.phone ? phoneSearchPath(inquiry) : null } }];`), 660, 200),
    at(ifNode('Search by phone?', '={{ !$json.duplicate && !$json.record && !!$json.inquiry.phone }}', isTrue), 880, 200),
    at(salesforce('Phone search', 'GET', '$json.phoneSearch', null, { full: true }), 1100, 60),
    at(code('Read phone search', `${source('match')}

const ctx = $('Resolve match').first().json;
const record = readPhoneSearch($input.first().json);
return [{ json: { ...ctx, record, matchedBy: record ? 'phoneSearch' : null } }];`), 1320, 60),
    at(ifNode('Repeat submission?', '={{ !!$json.duplicate }}', isTrue), 1540, 200),
    at(code('Log repeat submission', `const ctx = $input.first().json;
const whoId = ctx.duplicate.whoId;
return ${runLogShape("{ inquiry: ctx.inquiry, recordType: String(whoId).startsWith('003') ? 'Contact' : 'Lead', recordId: whoId, matchedBy: 'dupTask', action: 'duplicate_submission', alerts: [] }")};`), 1760, 420),

    at(code('Build qualify request', `${source('llm')}

const PROMPT = ${JSON.stringify(qualifyPrompt)};
const ctx = $input.first().json;
return [{ json: { ...ctx, request: buildQualifyRequest(ctx.inquiry, PROMPT) } }];`), 1760, 200),
    at(ifNode('Use live LLM?', '={{ $env.LLM_MODE }}', equals, 'live'), 1980, 200),
    at(openai('Qualify (OpenAI)'), 2200, 100),
    at(code('Load mock qualification', mockLoader('qualify')), 2200, 320),
    at(code('Apply qualification', `${source('llm', 'match')}

const ctx = $('Build qualify request').first().json;
const qualification = qualificationFromLlm($input.first().json, ctx.inquiry.message);
const target = buildRecordFields(ctx.inquiry, qualification, ctx.record);
return [{ json: { inquiry: ctx.inquiry, record: ctx.record, matchedBy: ctx.matchedBy, qualification, target, recordType: target.type, recordId: target.id || null } }];`), 2420, 200),

    at(ifNode('Existing record?', '={{ $json.recordId }}', notEmpty), 3280, 200),
    at(salesforce('Create lead', 'POST', "'/sobjects/Lead'", '$json.target.fields', { full: true }), 3500, 320),
    at(code('Read create result', `${source('match')}

const res = $input.first().json;
const ctx = $('Apply qualification').first().json;
if (res.statusCode === 201) return [{ json: { ...ctx, recordType: 'Lead', recordId: res.body.id, conflict: false } }];
const existing = parseDuplicateRule(res);
if (!existing) throw new Error('Salesforce create lead failed: ' + res.statusCode + ' ' + JSON.stringify(res.body).slice(0, 300));
return [{ json: { ...ctx, recordType: existing.type, recordId: existing.id, matchedBy: 'duplicateRule', conflict: true } }];`), 3720, 320),
    at(ifNode('Blocked by duplicate rule?', '={{ $json.conflict }}', isTrue), 3940, 320),
    at(salesforce('Get existing record', 'GET', `'/sobjects/' + $json.recordType + '/' + $json.recordId + '?fields=${contactFields}' + ($json.recordType === 'Lead' ? ',Company' : '')`), 4160, 420),
    at(code('Rebuild fields', `${source('match')}

const ctx = $('Read create result').first().json;
const { attributes, ...fields } = $input.first().json;
const record = { type: ctx.recordType, id: ctx.recordId, fields };
return [{ json: { ...ctx, record, target: buildRecordFields(ctx.inquiry, ctx.qualification, record) } }];`), 4380, 420),
    at(salesforce('Update record', 'PATCH', "'/sobjects/' + $json.recordType + '/' + $json.recordId", '$json.target.fields', { full: true }), 4600, 100),
    at(code('Prepare inquiry task', `${source('records')}

const update = $('Update record').isExecuted ? $('Update record').first().json : null;
if (update && update.statusCode !== 204) throw new Error('Salesforce update failed: ' + update.statusCode + ' ' + JSON.stringify(update.body).slice(0, 300));
const created = $('Read create result').isExecuted ? $('Read create result').first().json : null;
const wasCreated = Boolean(created && !created.conflict);
const ctx = wasCreated ? created : ($('Rebuild fields').isExecuted ? $('Rebuild fields').first().json : $('Apply qualification').first().json);
return [{ json: { ...ctx, action: wasCreated ? 'created' : 'updated', task: inquiryTask(ctx.recordId, ctx.inquiry, ctx.qualification) } }];`), 4820, 200),
    at(salesforce('Create inquiry task', 'POST', "'/sobjects/Task'", '$json.task'), 5040, 200),
    at(code('Restore context', "return [{ json: $('Prepare inquiry task').first().json }];"), 5260, 200),
    at(ifNode('Draft a reply?', "={{ $json.qualification.llm_ok && $json.qualification.tier !== 'not_qualified' }}", isTrue), 5480, 200),
    at(code('Log without draft', `${source('records', 'match')}

const ctx = $input.first().json;
const link = recordUrl($env.SF_INSTANCE_URL, ctx.recordType, ctx.recordId);
const alerts = ctx.qualification.llm_ok ? [] : [llmFailureAlert(ctx.inquiry, ctx.qualification, link)];
return ${runLogShape(`{ inquiry: ctx.inquiry, ${recordLog}, action: ctx.action, qualification: ctx.qualification, draft: 'none', alerts }`)};`), 5700, 420),

    at(code('Build draft request', `${source('llm')}

const PROMPT = ${JSON.stringify(draftPrompt)};
const ctx = $input.first().json;
return [{ json: { ...ctx, request: buildDraftRequest(ctx.inquiry, ctx.qualification, PROMPT) } }];`), 5700, 100),
    at(ifNode('Use live LLM? (draft)', '={{ $env.LLM_MODE }}', equals, 'live'), 5920, 100),
    at(openai('Draft reply (OpenAI)'), 6140, 0),
    at(code('Load mock draft', mockLoader('draft')), 6140, 200),
    at(code('Check draft', `${source('llm')}

const ctx = $('Build draft request').first().json;
const { request, ...rest } = ctx;
return [{ json: { ...rest, draft: draftFromLlm($input.first().json) } }];`), 6360, 100),
    at(ifNode('Draft usable?', '={{ $json.draft.ok }}', isTrue), 6580, 100),
    at(code('Log draft failure', `${source('records', 'match')}

const ctx = $input.first().json;
const alert = ':warning: AI reply draft failed (' + ctx.draft.error + ') for ' + (ctx.inquiry.email || ctx.inquiry.phone) + '. The lead is in Salesforce; please write the reply by hand: ' + recordUrl($env.SF_INSTANCE_URL, ctx.recordType, ctx.recordId);
return ${runLogShape(`{ inquiry: ctx.inquiry, ${recordLog}, action: ctx.action, qualification: ctx.qualification, draft: 'none', alerts: [alert] }`)};`), 6800, 320),
    at(code('Build review page', `${source('review', 'records', 'match')}

const fs = require('fs');
const ctx = $input.first().json;
const reviewId = safeId(ctx.inquiry.source_id);
const resumeUrl = $execution.resumeUrl;
const page = buildReviewPage({ inquiry: ctx.inquiry, qualification: ctx.qualification, draft: ctx.draft, recordUrl: recordUrl($env.SF_INSTANCE_URL, ctx.recordType, ctx.recordId), resumeUrl });
fs.mkdirSync('/files/output/review', { recursive: true });
fs.writeFileSync('/files/output/review/' + reviewId + '.html', page, 'utf8');
fs.writeFileSync('/files/output/review/' + reviewId + '.json', JSON.stringify({ source_id: ctx.inquiry.source_id, resume_url: resumeUrl, execution_id: $execution.id, status: 'pending', created_at: new Date().toISOString() }, null, 2), 'utf8');
const reviewUrl = ($env.WEBHOOK_URL || 'http://localhost:5680/') + 'webhook/review?id=' + encodeURIComponent(reviewId);
return [{ json: { ...ctx, reviewId, reviewUrl, slackText: reviewAlert(ctx.inquiry, ctx.qualification, reviewUrl) } }];`), 6800, 0),
    at(slack('Notify reviewer', '$json.slackText'), 7020, 0),
    at({ id: 'wait-for-review', name: 'Wait for review', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [0, 0], webhookId: stableUuid('wait-for-review'), parameters: { resume: 'webhook', httpMethod: 'POST', responseMode: 'responseNode', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 72, resumeUnit: 'hours', options: {} } }, 6580, 0),
    at(code('Read decision', `${source('review')}

const ctx = $('Build review page').first().json;
const input = $input.first().json;
const body = Object.prototype.hasOwnProperty.call(input, 'body') ? input.body : undefined;
const result = parseDecision(body, ctx.draft);
return [{ json: { ...ctx, result, errorHtml: errorPage(result.errors || []), receiptHtml: receiptPage(result.decision === 'approve' ? 'Review received: approved and sent' : 'Review received: rejected, nothing sent') } }];`), 7460, 0),
    at(ifNode('Timed out?', '={{ $json.result.timedOut }}', isTrue), 7680, 0),
    at(ifNode('Review complete?', '={{ $json.result.errors.length }}', { type: 'number', operation: 'equals' }, 0), 7900, 100),
    at(respond('Respond: fix the form', { html: true, code: 422, body: '={{ $json.errorHtml }}' }), 8120, 320),
    at(ifNode('Approved?', '={{ $json.result.decision }}', equals, 'approve'), 8120, 100),
    at(code('Prepare email', `${source('review')}

const ctx = $input.first().json;
const email = outgoingEmail({ to: ctx.inquiry.email, subject: ctx.result.subject, body: ctx.result.body, demoMode: $env.DEMO_MODE === '1', redirectTo: $env.REPLY_REDIRECT_TO });
return [{ json: { ...ctx, email } }];`), 8340, 0),
    at({ id: 'send-reply', name: 'Send reply', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [0, 0], credentials: CREDS.smtp, parameters: { fromEmail: '={{ "Tidewell Commercial Cleaning <" + $env.GMAIL_ADDRESS + ">" }}', toEmail: '={{ $json.email.to }}', subject: '={{ $json.email.subject }}', emailFormat: 'text', text: '={{ $json.email.body }}', options: { appendAttribution: false } } }, 7900, 0),
    at(code('Mark sent', "return [{ json: $('Prepare email').first().json }];"), 8780, 0),
    at(respond('Respond: sent', { html: true, body: '={{ $json.receiptHtml }}' }), 9000, 0),
    at(respond('Respond: rejected', { html: true, body: '={{ $json.receiptHtml }}' }), 8340, 200),
    at(code('Prepare decision task', `${source('records')}

const ctx = $input.first().json;
const r = ctx.result;
const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const approved = !r.timedOut && r.decision === 'approve';
const sentTo = approved ? ctx.email.to : null;
const draft = r.timedOut ? 'timeout' : approved ? 'approved' : 'rejected';
const runLog = { inquiry: ctx.inquiry, ${recordLog}, action: ctx.action, qualification: ctx.qualification, draft, sentTo, reviewer: r.reviewer || null, edited: r.timedOut ? null : r.edited, alerts: [] };
return [{ json: { task: decisionTask(ctx.recordId, r, { date, sentTo }), runLog } }];`), 9220, 200),
    at(salesforce('Create decision task', 'POST', "'/sobjects/Task'", '$json.task'), 9440, 200),
    at(code('Restore run log', "return [{ json: { runLog: $('Prepare decision task').first().json.runLog } }];"), 9660, 200),
    ...runLogTail(9880, 420),
  ];
  const connections = {
    Start: { main: [[edge('Build lookup')]] },
    'Build lookup': { main: [[edge('Salesforce lookup')]] },
    'Salesforce lookup': { main: [[edge('Resolve match')]] },
    'Resolve match': { main: [[edge('Search by phone?')]] },
    'Search by phone?': { main: [[edge('Phone search')], [edge('Repeat submission?')]] },
    'Phone search': { main: [[edge('Read phone search')]] },
    'Read phone search': { main: [[edge('Repeat submission?')]] },
    'Repeat submission?': { main: [[edge('Log repeat submission')], [edge('Build qualify request')]] },
    'Log repeat submission': { main: [[edge('Write run log')]] },
    'Build qualify request': { main: [[edge('Use live LLM?')]] },
    'Use live LLM?': { main: [[edge('Qualify (OpenAI)')], [edge('Load mock qualification')]] },
    'Qualify (OpenAI)': { main: [[edge('Apply qualification')]] },
    'Load mock qualification': { main: [[edge('Apply qualification')]] },
    'Apply qualification': { main: [[edge('Existing record?')]] },
    'Existing record?': { main: [[edge('Update record')], [edge('Create lead')]] },
    'Create lead': { main: [[edge('Read create result')]] },
    'Read create result': { main: [[edge('Blocked by duplicate rule?')]] },
    'Blocked by duplicate rule?': { main: [[edge('Get existing record')], [edge('Prepare inquiry task')]] },
    'Get existing record': { main: [[edge('Rebuild fields')]] },
    'Rebuild fields': { main: [[edge('Update record')]] },
    'Update record': { main: [[edge('Prepare inquiry task')]] },
    'Prepare inquiry task': { main: [[edge('Create inquiry task')]] },
    'Create inquiry task': { main: [[edge('Restore context')]] },
    'Restore context': { main: [[edge('Draft a reply?')]] },
    'Draft a reply?': { main: [[edge('Build draft request')], [edge('Log without draft')]] },
    'Log without draft': { main: [[edge('Write run log')]] },
    'Build draft request': { main: [[edge('Use live LLM? (draft)')]] },
    'Use live LLM? (draft)': { main: [[edge('Draft reply (OpenAI)')], [edge('Load mock draft')]] },
    'Draft reply (OpenAI)': { main: [[edge('Check draft')]] },
    'Load mock draft': { main: [[edge('Check draft')]] },
    'Check draft': { main: [[edge('Draft usable?')]] },
    'Draft usable?': { main: [[edge('Build review page')], [edge('Log draft failure')]] },
    'Log draft failure': { main: [[edge('Write run log')]] },
    'Build review page': { main: [[edge('Notify reviewer')]] },
    'Notify reviewer': { main: [[edge('Wait for review')]] },
    'Wait for review': { main: [[edge('Read decision')]] },
    'Read decision': { main: [[edge('Timed out?')]] },
    'Timed out?': { main: [[edge('Prepare decision task')], [edge('Review complete?')]] },
    'Review complete?': { main: [[edge('Approved?')], [edge('Respond: fix the form')]] },
    'Respond: fix the form': { main: [[edge('Wait for review')]] },
    'Approved?': { main: [[edge('Prepare email')], [edge('Respond: rejected')]] },
    'Prepare email': { main: [[edge('Send reply')]] },
    'Send reply': { main: [[edge('Mark sent')]] },
    'Mark sent': { main: [[edge('Respond: sent')]] },
    'Respond: sent': { main: [[edge('Prepare decision task')]] },
    'Respond: rejected': { main: [[edge('Prepare decision task')]] },
    'Prepare decision task': { main: [[edge('Create decision task')]] },
    'Create decision task': { main: [[edge('Restore run log')]] },
    'Restore run log': { main: [[edge('Write run log')]] },
    ...tailConnections,
  };
  return workflow('wfProcessInquiry', 'Lead intake: process inquiry', nodes, connections);
}

function reviewPageServer() {
  const nodes = [
    note('About', '## Review page\n`GET /webhook/review?id=…` serves the saved review page so the Slack link opens in the browser.', -80, -60, 700, 140, 7),
    at(webhook('Open review page', 'review', 'GET'), 0, 200),
    at(code('Load review page', `const fs = require('fs');
const id = String(($input.first().json.query || {}).id || '');
const file = '/files/output/review/' + id + '.html';
if (!/^[A-Za-z0-9._-]{1,80}$/.test(id) || !fs.existsSync(file)) return [{ json: { status: 404, html: '<!doctype html><meta charset="utf-8"><p>Review page not found.</p>' } }];
const meta = JSON.parse(fs.readFileSync('/files/output/review/' + id + '.json', 'utf8'));
const html = fs.readFileSync(file, 'utf8');
const banner = meta.status === 'pending' ? '' : '<p style="font:600 16px system-ui;background:#fff4d6;padding:.75rem;border-radius:6px;max-width:860px;margin:1rem auto">Already reviewed: ' + meta.status + '. Submitting again has no effect.</p>';
return [{ json: { status: 200, html: html.replace('<body>', '<body>' + banner) } }];`), 220, 200),
    at({ ...respond('Respond with page', { html: true, body: '={{ $json.html }}' }), parameters: { respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseCode: '={{ $json.status }}', responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } } } }, 440, 200),
  ];
  return workflow('wfReviewPage', 'Lead intake: review page', nodes, {
    'Open review page': { main: [[edge('Load review page')]] },
    'Load review page': { main: [[edge('Respond with page')]] },
  });
}

function errorHandler() {
  const nodes = [
    note('About', '## Error handler\nAny failed node in the lead intake workflows posts a masked alert to Slack and keeps a local error log.', -80, -60, 900, 140, 1),
    at({ id: 'error-trigger', name: 'Error trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0], parameters: {} }, 0, 200),
    at(code('Format alert', `${source('records')}

return [{ json: formatAlert($input.first().json) }];`), 220, 200),
    at(slack('Send alert', '$json.text'), 440, 200),
    at(code('Write error log', `const fs = require('fs');
const alert = $('Format alert').first().json;
fs.mkdirSync('/files/output/run-log', { recursive: true });
fs.appendFileSync('/files/output/run-log/errors.jsonl', JSON.stringify({ ts: new Date().toISOString(), ...alert }) + '\\n', 'utf8');
return [{ json: alert }];`), 660, 200),
  ];
  return workflow('wfErrorHandler', 'Lead intake: error handler', nodes, {
    'Error trigger': { main: [[edge('Format alert')]] },
    'Format alert': { main: [[edge('Send alert')]] },
    'Send alert': { main: [[edge('Write error log')]] },
  }, false);
}

function buildWorkflows(destination = outputDir) {
  const workflows = [formIntake(), emailIntake(), processInquiry(), reviewPageServer(), errorHandler()];
  mkdirSync(destination, { recursive: true });
  for (const item of workflows) writeFileSync(join(destination, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`, 'utf8');
  return workflows;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = buildWorkflows();
  console.log(`Wrote ${built.length} workflows: ${built.map((item) => item.id).join(', ')}`);
}
export { buildWorkflows };

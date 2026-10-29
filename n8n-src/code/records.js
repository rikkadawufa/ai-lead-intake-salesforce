// Salesforce Tasks, Slack texts and the run log; every number here comes from code, not the AI.

const SUBJECT_LIMIT = 255;

function oneLine(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function inquiryDescription(inquiry, qualification) {
  const header = [`[${inquiry.source}] ${inquiry.received_at}`, ...(inquiry.subject ? [inquiry.subject] : [])];
  const ai = `AI: ${qualification.tier} / ${qualification.topic} / ${qualification.urgency} — ${qualification.reason}`;
  return [...header, '', inquiry.message, '', ai].join('\n');
}

function decisionText(result, { date, sentTo }) {
  if (result.timedOut) return { subject: 'AI reply review timed out', description: 'Reply drafted by AI; review timed out, nothing sent.' };
  if (result.decision === 'approve') {
    return {
      subject: `AI reply approved by ${result.reviewer}`,
      description: `Reply drafted by AI, edited: ${result.edited ? 'yes' : 'no'}, approved by ${result.reviewer} on ${date}, sent to ${sentTo}.\n\nSubject: ${result.subject}\n\n${result.body}`,
    };
  }
  return { subject: `AI reply rejected by ${result.reviewer}`, description: `Reply drafted by AI, rejected by ${result.reviewer} on ${date}, nothing sent.` };
}

// One Task per inquiry, linked to the Lead or Contact; Inquiry_Source_ID__c is what repeat detection looks up.
function inquiryTask(whoId, inquiry, qualification) {
  // Form inquiries carry a fixed subject ("Website contact form"), so their Tasks show the start of the message.
  const topic = inquiry.source === 'email' && inquiry.subject ? inquiry.subject : inquiry.message;
  return {
    WhoId: String(whoId),
    Subject: oneLine(`Inquiry via ${inquiry.source}: ${topic}`, Math.min(SUBJECT_LIMIT, `Inquiry via ${inquiry.source}: `.length + 60)),
    Description: inquiryDescription(inquiry, qualification),
    Status: 'Completed',
    Priority: 'Normal',
    ActivityDate: String(inquiry.received_at || new Date().toISOString()).slice(0, 10),
    Inquiry_Source_ID__c: inquiry.source_id,
  };
}

function decisionTask(whoId, result, { date, sentTo }) {
  const text = decisionText(result, { date, sentTo });
  return { WhoId: String(whoId), Subject: oneLine(text.subject, SUBJECT_LIMIT), Description: text.description, Status: 'Completed', Priority: 'Normal', ActivityDate: date };
}

function maskSecrets(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '***')
    .replace(/\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]+/g, '***')
    .replace(/https:\/\/hooks\.slack\.com\/[^\s"']+/g, 'https://hooks.slack.com/***');
}

function formatAlert(payload = {}, baseUrl = 'http://localhost:5680') {
  const workflow = payload.workflow || {};
  const execution = payload.execution || {};
  const message = maskSecrets((execution.error && execution.error.message) || 'Unknown error');
  const url = `${baseUrl}/workflow/${workflow.id || ''}/executions/${execution.id || ''}`;
  return { text: `:rotating_light: Lead intake workflow error\nWorkflow: ${workflow.name || workflow.id || 'unknown'}\nNode: ${execution.lastNodeExecuted || 'unknown'}\nError: ${message}\n${url}`, url };
}

function rejectedInputAlert(inquiry, reason) {
  const who = inquiry.email || inquiry.phone || inquiry.name || 'unknown sender';
  return `:warning: Inquiry not accepted (${reason}) from ${who} via ${inquiry.source}. Nothing was written to Salesforce; please follow up by hand if needed.`;
}

function llmFailureAlert(inquiry, qualification, link) {
  return `:warning: AI classification failed for ${inquiry.email || inquiry.phone} (${qualification.llm_error}). The lead was saved in Salesforce as Needs review with no draft reply: ${link}`;
}

function reviewAlert(inquiry, qualification, reviewUrl) {
  return `:incoming_envelope: New lead: ${inquiry.name || inquiry.email} (${qualification.tier}, ${qualification.urgency} urgency) — review the draft reply: ${reviewUrl}`;
}

function buildRunLog({ inquiry, fixtureId = null, recordType = null, recordId = null, matchedBy = null, action, qualification = null, draft = 'none', sentTo = null, reviewer = null, edited = null, alerts = [], executionId = null }) {
  return {
    ts: new Date().toISOString(),
    execution_id: executionId,
    source_id: inquiry.source_id,
    source: inquiry.source,
    fixture_id: fixtureId,
    email: inquiry.email,
    record_type: recordType,
    record_id: recordId,
    matched_by: matchedBy,
    action,
    tier: qualification ? qualification.tier : null,
    llm_ok: qualification ? qualification.llm_ok : null,
    llm_error: qualification ? qualification.llm_error : null,
    draft,
    reviewer,
    edited,
    sent_to: sentTo,
    alerts,
  };
}

if (typeof module !== 'undefined') module.exports = { inquiryTask, decisionTask, decisionText, maskSecrets, formatAlert, rejectedInputAlert, llmFailureAlert, reviewAlert, buildRunLog };

// OpenAI requests and the checks that decide whether an AI answer can be used (SPEC §5).

const TIERS = ['qualified', 'needs_review', 'not_qualified'];
const TOPICS = ['regular_cleaning', 'deep_cleaning', 'quote_request', 'complaint', 'job_application', 'sales_pitch', 'other'];
const URGENCIES = ['high', 'normal', 'low'];
const BROKEN_MODEL = 'does-not-exist-model';

function fillTemplate(template, values) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => (values[key] == null ? '' : String(values[key])));
}

function inquiryText(inquiry) {
  return [
    `Source: ${inquiry.source}`,
    `Name: ${inquiry.name || '(not given)'}`,
    `Company: ${inquiry.company || '(not given)'}`,
    `Subject: ${inquiry.subject || '(none)'}`,
    'Message:',
    inquiry.message,
  ].join('\n');
}

function chatRequest(prompt, userContent, schemaName, modelOverride) {
  const request = {
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: userContent }],
    response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: prompt.schema } },
    temperature: 0,
  };
  if (modelOverride) request.model = modelOverride;
  return request;
}

function buildQualifyRequest(inquiry, prompt) {
  const override = inquiry.demo_flags && inquiry.demo_flags.break_llm ? BROKEN_MODEL : undefined;
  return chatRequest(prompt, fillTemplate(prompt.userTemplate, { inquiry: inquiryText(inquiry) }), 'lead_qualification', override);
}

function buildDraftRequest(inquiry, qualification, prompt) {
  const content = fillTemplate(prompt.userTemplate, { inquiry: inquiryText(inquiry), tier: qualification.tier, topic: qualification.topic, urgency: qualification.urgency });
  return chatRequest(prompt, content, 'reply_draft');
}

function readLlmJson(response) {
  if (!response) return { data: null, error: 'empty_response' };
  if (response.error) {
    const error = response.error;
    const status = error.httpCode || error.status || (error.cause && error.cause.status) || '';
    return { data: null, error: `api_error${status ? `_${status}` : ''}` };
  }
  const content = response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content;
  if (!content) return { data: null, error: 'empty_response' };
  try {
    return { data: JSON.parse(content), error: null };
  } catch (e) {
    return { data: null, error: 'invalid_json' };
  }
}

const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

function validateQualification(data, message) {
  const errors = [];
  if (!data || typeof data !== 'object') return { valid: false, errors: ['not_an_object'] };
  if (!TIERS.includes(data.tier)) errors.push('bad_tier');
  if (!TOPICS.includes(data.topic)) errors.push('bad_topic');
  if (!URGENCIES.includes(data.urgency)) errors.push('bad_urgency');
  if (!String(data.reason || '').trim()) errors.push('missing_reason');
  const quote = squash(data.quote);
  if (!quote || !squash(message).includes(quote)) errors.push('quote_not_in_message');
  return { valid: errors.length === 0, errors };
}

// A verbatim quote that runs long is cut at a word boundary; it stays a prefix of the original text.
const QUOTE_LIMIT = 160;
function shortenQuote(quote) {
  const text = String(quote).replace(/\s+/g, ' ').trim();
  if (text.length <= QUOTE_LIMIT) return text;
  const cut = text.slice(0, QUOTE_LIMIT);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : QUOTE_LIMIT).replace(/[\s,;:.]+$/, '')}…`;
}

function qualificationFromLlm(response, message) {
  const parsed = readLlmJson(response);
  if (parsed.error) return fallbackQualification(parsed.error);
  const checked = validateQualification(parsed.data, message);
  if (!checked.valid) return fallbackQualification(`validation_failed:${checked.errors.join(',')}`);
  const { tier, topic, urgency, reason, quote } = parsed.data;
  return { tier, topic, urgency, reason: `${reason.trim()} Quote: "${shortenQuote(quote)}"`, llm_ok: true, llm_error: null };
}

function fallbackQualification(errorClass) {
  return {
    tier: 'needs_review',
    topic: 'other',
    urgency: 'normal',
    reason: `AI classification failed: ${errorClass}; needs a human look.`,
    llm_ok: false,
    llm_error: errorClass,
  };
}

function draftFromLlm(response) {
  const parsed = readLlmJson(response);
  if (parsed.error) return { ok: false, error: parsed.error };
  const { subject, body } = parsed.data || {};
  const words = String(body || '').trim().split(/\s+/).filter(Boolean).length;
  if (!String(subject || '').trim() || !words) return { ok: false, error: 'missing_subject_or_body' };
  if (words > 160) return { ok: false, error: 'body_too_long' };
  return { ok: true, subject: subject.trim(), body: body.trim() };
}

function fixtureIdFor(sourceId, fixtures = []) {
  for (const fixture of fixtures) {
    if (fixture.channel === 'form' && sourceId === `form:${fixture.submission_id}`) return fixture.id;
    if (fixture.channel === 'email' && sourceId === `email:${fixture.message_id}`) return fixture.id;
  }
  return null;
}

// Mock mode reads a stored answer instead of calling OpenAI; a missing file behaves like an API failure.
function mockResponse(fileContent, breakLlm) {
  if (breakLlm) return { error: { message: `The model \`${BROKEN_MODEL}\` does not exist (mock)`, httpCode: '404' } };
  if (!fileContent) return { error: { message: 'mock file missing', httpCode: 'mock_missing' } };
  return { choices: [{ message: { content: fileContent } }] };
}

if (typeof module !== 'undefined') module.exports = { TIERS, TOPICS, URGENCIES, BROKEN_MODEL, buildQualifyRequest, buildDraftRequest, readLlmJson, validateQualification, shortenQuote, qualificationFromLlm, fallbackQualification, draftFromLlm, fixtureIdFor, mockResponse, fillTemplate };

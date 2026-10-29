const test = require('node:test');
const assert = require('node:assert/strict');
const { buildQualifyRequest, readLlmJson, validateQualification, qualificationFromLlm, draftFromLlm, fixtureIdFor, mockResponse, BROKEN_MODEL } = require('./llm');

const prompt = { system: 'sys', userTemplate: 'Classify:\n{{inquiry}}', schema: { type: 'object' } };
const message = 'We need weekly cleaning for a 4,000 sq ft office in Oakland.';
const answer = (data) => ({ choices: [{ message: { content: JSON.stringify(data) } }] });
const good = { tier: 'qualified', topic: 'regular_cleaning', urgency: 'normal', reason: 'Office, size and frequency given.', quote: 'weekly cleaning for a 4,000 sq ft office' };

test('qualify request uses strict json_schema and only overrides the model when breaking on purpose', () => {
  const request = buildQualifyRequest({ source: 'form', message, demo_flags: { break_llm: false } }, prompt);
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal('model' in request, false);
  assert.match(request.messages[1].content, /4,000 sq ft/);
  assert.equal(buildQualifyRequest({ source: 'form', message, demo_flags: { break_llm: true } }, prompt).model, BROKEN_MODEL);
});

test('a valid answer keeps its quote in the stored reason', () => {
  const result = qualificationFromLlm(answer(good), message);
  assert.equal(result.llm_ok, true);
  assert.equal(result.tier, 'qualified');
  assert.match(result.reason, /Quote: "weekly cleaning/);
});

test('a quote that is not in the message is rejected', () => {
  const checked = validateQualification({ ...good, quote: 'daily cleaning for a warehouse' }, message);
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.includes('quote_not_in_message'));
});

test('a long verbatim quote is accepted and shortened (live round 1, T1)', () => {
  const t1 = "Hi, we're looking for weekly after-hours cleaning for our dental office in Oakland, about 3,200 sq ft with 6 treatment rooms. Ideally starting the first week of December. Could someone come by for a walkthrough?";
  const quote = "we're looking for weekly after-hours cleaning for our dental office in Oakland, about 3,200 sq ft with 6 treatment rooms. Ideally starting the first week of December.";
  const result = qualificationFromLlm(answer({ ...good, quote }), t1);
  assert.equal(result.llm_ok, true);
  const shown = result.reason.match(/Quote: "(.*)"$/)[1];
  assert.ok(shown.length <= 161 && shown.endsWith('…'));
  assert.ok(t1.includes(shown.slice(0, -1)));
});

test('a long quote that is not in the message still fails', () => {
  assert.equal(qualificationFromLlm(answer({ ...good, quote: 'x '.repeat(100) }), message).llm_ok, false);
});

test('quote check ignores whitespace and case differences', () => {
  assert.equal(validateQualification({ ...good, quote: 'Weekly   cleaning for a 4,000 SQ FT office' }, message).valid, true);
});

test('bad enum values and API errors fall back to needs_review without a draft', () => {
  const badEnum = qualificationFromLlm(answer({ ...good, tier: 'hot' }), message);
  assert.equal(badEnum.tier, 'needs_review');
  assert.equal(badEnum.llm_ok, false);
  assert.match(badEnum.llm_error, /bad_tier/);
  const apiError = qualificationFromLlm({ error: { message: 'model not found', httpCode: '404' } }, message);
  assert.equal(apiError.llm_error, 'api_error_404');
  assert.match(apiError.reason, /needs a human look/);
});

test('unparseable content is an invalid_json failure', () => {
  assert.equal(readLlmJson({ choices: [{ message: { content: 'not json' } }] }).error, 'invalid_json');
  assert.equal(readLlmJson({}).error, 'empty_response');
});

test('draft needs subject and a short body', () => {
  assert.equal(draftFromLlm(answer({ subject: 'Re: cleaning', body: 'Thanks for reaching out.' })).ok, true);
  assert.equal(draftFromLlm(answer({ subject: '', body: 'x' })).ok, false);
  assert.equal(draftFromLlm(answer({ subject: 'Hi', body: 'word '.repeat(200) })).error, 'body_too_long');
});

test('fixtures map form and email source ids', () => {
  const fixtures = [{ id: 'T1', channel: 'form', submission_id: 'tw-1' }, { id: 'T2', channel: 'email', message_id: '<t2@example.com>' }];
  assert.equal(fixtureIdFor('form:tw-1', fixtures), 'T1');
  assert.equal(fixtureIdFor('email:<t2@example.com>', fixtures), 'T2');
  assert.equal(fixtureIdFor('form:other', fixtures), null);
});

test('mock mode fails like the real API when asked to', () => {
  assert.equal(qualificationFromLlm(mockResponse(JSON.stringify(good), true), message).llm_error, 'api_error_404');
  assert.equal(qualificationFromLlm(mockResponse('', false), message).llm_error, 'api_error_mock_missing');
  assert.equal(qualificationFromLlm(mockResponse(JSON.stringify(good), false), message).llm_ok, true);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeForm, normalizeEmail, validateInquiry } = require('./normalize');
const { qualificationFromLlm, draftFromLlm, mockResponse } = require('./llm');

const dataDir = path.join(__dirname, '..', '..', 'sample-data');
const { fixtures } = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixtures.json'), 'utf8'));
const byId = Object.fromEntries(fixtures.map((fixture) => [fixture.id, fixture]));
const mock = (name) => {
  const file = path.join(dataDir, 'mock-llm', `${name}.json`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

function inquiryFor(fixture) {
  const base = fixture.resend_of ? byId[fixture.resend_of] : fixture;
  if (base.channel === 'form') return normalizeForm({ ...base.payload, submission_id: base.submission_id }, base.break_llm ? { 'x-demo-break-llm': '1' } : {}, { demoMode: true });
  return normalizeEmail({ from: 'leads@gmail.com', replyTo: `${base.from_name} <${base.reply_to}>`, subject: base.subject, text: base.body, messageId: base.message_id }, { selfAddress: 'leads@gmail.com' });
}

test('every fixture uses a reserved demo domain', () => {
  for (const fixture of fixtures) {
    const email = fixture.payload ? fixture.payload.email : fixture.reply_to;
    if (email) assert.match(email, /@example\.(com|org)$/, fixture.id);
  }
});

test('mock answers pass the same checks as live answers', () => {
  for (const fixture of fixtures) {
    const inquiry = inquiryFor(fixture);
    if (!validateInquiry(inquiry).valid || fixture.resend_of || fixture.break_llm) continue;
    const qualification = qualificationFromLlm(mockResponse(mock(`${fixture.id}.qualify`), false), inquiry.message);
    assert.equal(qualification.llm_ok, true, `${fixture.id}: ${qualification.llm_error}`);
    if (qualification.tier !== 'not_qualified') assert.equal(draftFromLlm(mockResponse(mock(`${fixture.id}.draft`), false)).ok, true, fixture.id);
  }
});

test('T6 is rejected before Salesforce and T3 repeats the T1 source id', () => {
  assert.equal(validateInquiry(inquiryFor(byId.T6)).reason, 'no_contact');
  assert.equal(inquiryFor(byId.T3).source_id, inquiryFor(byId.T1).source_id);
  assert.equal(inquiryFor(byId.T2).email, inquiryFor(byId.T1).email);
});

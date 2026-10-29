const test = require('node:test');
const assert = require('node:assert/strict');
const { toE164, normalizeForm, normalizeEmail, validateInquiry, stripQuotedReply } = require('./normalize');

test('phone numbers become E.164 or null, never a guess', () => {
  assert.equal(toE164('(415) 555-0142'), '+14155550142');
  assert.equal(toE164('1-415-555-0142'), '+14155550142');
  assert.equal(toE164('+61 2 5550 1234'), '+61255501234');
  assert.equal(toE164('5550142'), null);
  assert.equal(toE164(''), null);
});

test('form body is trimmed, lowercased and keyed by submission id', () => {
  const inquiry = normalizeForm({ name: ' Dana Whitfield ', email: 'Dana@Example.com', phone: '415 555 0142', message: ' Hi ', submission_id: 'tw-1' }, {}, { now: '2026-10-29T00:00:00.000Z' });
  assert.equal(inquiry.source_id, 'form:tw-1');
  assert.equal(inquiry.email, 'dana@example.com');
  assert.equal(inquiry.phone, '+14155550142');
  assert.equal(inquiry.message, 'Hi');
  assert.equal(inquiry.demo_flags.break_llm, false);
});

test('missing submission id falls back to a stable hash of email and message', () => {
  const a = normalizeForm({ email: 'a@example.com', message: 'Need a quote' });
  const b = normalizeForm({ email: 'A@example.com ', message: 'Need a quote' });
  assert.equal(a.source_id, b.source_id);
  assert.match(a.source_id, /^form:[0-9a-f]{16}$/);
});

test('break-llm header only counts in demo mode', () => {
  assert.equal(normalizeForm({}, { 'X-Demo-Break-LLM': '1' }, { demoMode: true }).demo_flags.break_llm, true);
  assert.equal(normalizeForm({}, { 'x-demo-break-llm': '1' }, { demoMode: false }).demo_flags.break_llm, false);
});

test('email prefers Reply-To over From and keeps the Message-ID', () => {
  const mail = {
    from: { value: [{ address: 'leads@gmail.com', name: 'Website' }] },
    replyTo: { value: [{ address: 'Dana@Example.com', name: 'Dana Whitfield' }] },
    subject: 'Follow-up', text: 'Can you start Monday? Call me on 415-555-0142\n\n-- \nDana', messageId: '<t2@example.com>', date: '2026-10-29T01:00:00Z',
  };
  const inquiry = normalizeEmail(mail, { selfAddress: 'leads@gmail.com' });
  assert.equal(inquiry.email, 'dana@example.com');
  assert.equal(inquiry.name, 'Dana Whitfield');
  assert.equal(inquiry.source_id, 'email:<t2@example.com>');
  assert.equal(inquiry.phone, '+14155550142');
  assert.equal(inquiry.message, 'Can you start Monday? Call me on 415-555-0142');
});

test('email from our own inbox without Reply-To is skipped', () => {
  assert.deepEqual(normalizeEmail({ from: 'Tidewell <Leads@gmail.com>', text: 'Approved reply' }, { selfAddress: 'leads@gmail.com' }), { skip: true, reason: 'self_sent' });
});

test('quoted replies are dropped from the message', () => {
  assert.equal(stripQuotedReply('New text\n> old line\nOn Tue, Oct 28, 2026 Dana wrote:\n> older'), 'New text');
});

test('validation reasons', () => {
  assert.deepEqual(validateInquiry({ email: null, phone: null, message: 'hello there' }), { valid: false, reason: 'no_contact' });
  assert.equal(validateInquiry({ email: 'not-an-email', message: 'hello there' }).reason, 'bad_email');
  assert.equal(validateInquiry({ email: 'a@example.com', message: ' hi ' }).reason, 'empty_message');
  assert.equal(validateInquiry({ email: null, phone: '+14155550142', message: 'hello there' }).valid, true);
});

test('demo mode keeps real addresses out of Salesforce', () => {
  assert.equal(validateInquiry({ email: 'no-reply@accounts.google.com', message: 'Welcome to Gmail' }, { demoOnly: true }).reason, 'non_demo_address');
  assert.equal(validateInquiry({ email: 'jordan.blake@example.org', message: 'hello there' }, { demoOnly: true }).valid, true);
  assert.equal(validateInquiry({ email: 'a@sub.example.com', message: 'hello there' }, { demoOnly: true }).reason, 'non_demo_address');
  assert.equal(validateInquiry({ email: 'real@company.com', message: 'hello there' }).valid, true);
});

test('demo mode accepts phone-only inquiries only from the fictional 555-01xx range', () => {
  assert.equal(validateInquiry({ email: null, phone: '+15105550177', message: 'hello there' }, { demoOnly: true }).valid, true);
  assert.equal(validateInquiry({ email: null, phone: '+15105551234', message: 'hello there' }, { demoOnly: true }).reason, 'non_demo_address');
  assert.equal(validateInquiry({ email: 'real@company.com', phone: '+15105550177', message: 'hello there' }, { demoOnly: true }).reason, 'non_demo_address');
});

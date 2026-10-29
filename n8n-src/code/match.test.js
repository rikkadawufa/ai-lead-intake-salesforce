const test = require('node:test');
const assert = require('node:assert/strict');
const { soqlString, nationalDigits, buildLookupRequest, phoneSearchPath, readPhoneSearch, resolveMatch, mergeTier, buildRecordFields, parseDuplicateRule, recordUrl } = require('./match');

const inquiry = { source: 'email', source_id: 'email:<t2@example.com>', email: 'dana@example.com', phone: '+15105550142', name: 'Dana Whitfield', company: null };
const qualification = { tier: 'needs_review', topic: 'regular_cleaning', urgency: 'high', reason: 'Asks about start date.' };

const part = (referenceId, records, status = 200) => ({ referenceId, httpStatusCode: status, body: { totalSize: records.length, done: true, records } });
const ok = (...parts) => ({ statusCode: 200, body: { compositeResponse: parts } });
const lead = (id, extra = {}) => ({ attributes: { type: 'Lead' }, Id: id, ...extra });
const contact = (id, extra = {}) => ({ attributes: { type: 'Contact' }, Id: id, ...extra });

test('SOQL strings escape quotes and backslashes', () => {
  assert.equal(soqlString("o'brien\\x"), "'o\\'brien\\\\x'");
});

test('US E.164 numbers become 10 digits for phone search', () => {
  assert.equal(nationalDigits('+15105550142'), '5105550142');
  assert.equal(nationalDigits('+442071234567'), '442071234567');
});

test('lookup asks for the repeat task, email and phone matches in one composite call', () => {
  const request = buildLookupRequest(inquiry, 'v63.0');
  assert.equal(request.allOrNone, false);
  assert.deepEqual(request.compositeRequest.map((item) => item.referenceId), ['dupTask', 'contactEmail', 'leadEmail', 'contactPhone', 'leadPhone']);
  const leadEmail = decodeURIComponent(request.compositeRequest[2].url);
  assert.match(leadEmail, /^\/services\/data\/v63\.0\/query\?q=SELECT .* FROM Lead WHERE Email = 'dana@example\.com' AND IsConverted = false/);
  assert.ok(request.compositeRequest.every((item) => item.url.includes('/query?q=')), 'composite only accepts query sub-requests here');
});

test('phone search uses 10 digits, since SOSL refuses + and dashes', () => {
  assert.match(decodeURIComponent(phoneSearchPath(inquiry)), /^\/search\?q=FIND \{5105550142\} IN PHONE FIELDS RETURNING Contact\(.*\), Lead\(.*WHERE IsConverted = false/);
});

test('lookup skips email or phone queries when the inquiry has none', () => {
  assert.deepEqual(buildLookupRequest({ ...inquiry, phone: null }, 'v63.0').compositeRequest.map((item) => item.referenceId), ['dupTask', 'contactEmail', 'leadEmail']);
  assert.deepEqual(buildLookupRequest({ ...inquiry, email: null }, 'v63.0').compositeRequest.map((item) => item.referenceId), ['dupTask', 'contactPhone', 'leadPhone']);
});

test('a hostile email cannot break out of the SOQL string', () => {
  const url = decodeURIComponent(buildLookupRequest({ ...inquiry, email: "x' OR Email != '" }, 'v63.0').compositeRequest[1].url);
  assert.ok(url.includes("Email = 'x\\' OR Email != \\''"));
});

test('Contact wins over Lead, and email over phone', () => {
  const both = resolveMatch(ok(part('dupTask', []), part('contactEmail', [contact('003A')]), part('leadEmail', [lead('00QA')])));
  assert.deepEqual([both.record.type, both.record.id, both.matchedBy], ['Contact', '003A', 'contactEmail']);
  const phone = resolveMatch(ok(part('dupTask', []), part('contactEmail', []), part('leadEmail', [lead('00QE')]), part('contactPhone', [contact('003P')])));
  assert.equal(phone.record.id, '00QE');
});

test('phone search prefers a Contact, strips attributes and fails loudly', () => {
  const found = readPhoneSearch({ statusCode: 200, body: { searchRecords: [lead('00QS'), contact('003S', { Phone: '(510) 555-0142' })] } });
  assert.deepEqual(found, { type: 'Contact', id: '003S', fields: { Id: '003S', Phone: '(510) 555-0142' } });
  assert.equal(readPhoneSearch({ statusCode: 200, body: { searchRecords: [] } }), null);
  assert.throws(() => readPhoneSearch({ statusCode: 400, body: [{ errorCode: 'MALFORMED_SEARCH' }] }), /phone search failed: 400/);
});

test('no match and a repeat task are reported', () => {
  const none = resolveMatch(ok(part('dupTask', []), part('contactEmail', []), part('leadEmail', [])));
  assert.deepEqual(none, { record: null, matchedBy: null, duplicate: null });
  const repeat = resolveMatch(ok(part('dupTask', [{ attributes: { type: 'Task' }, Id: '00T1', WhoId: '00QA' }]), part('contactEmail', []), part('leadEmail', [lead('00QA')])));
  assert.deepEqual(repeat.duplicate, { taskId: '00T1', whoId: '00QA' });
});

test('a failed sub-request or call stops the flow instead of looking like no match', () => {
  const bad = ok(part('dupTask', []), { referenceId: 'leadEmail', httpStatusCode: 400, body: [{ errorCode: 'INVALID_FIELD', message: 'No such column Phone_E164__c' }] });
  assert.throws(() => resolveMatch(bad), /leadEmail 400 .*INVALID_FIELD/);
  assert.throws(() => resolveMatch({ statusCode: 401, body: [{ errorCode: 'INVALID_SESSION_ID' }] }), /lookup failed: 401/);
});

test('qualified records are never downgraded', () => {
  assert.equal(mergeTier('qualified', 'needs_review'), 'qualified');
  assert.equal(mergeTier('needs_review', 'qualified'), 'qualified');
  assert.equal(mergeTier('not_qualified', 'needs_review'), 'needs_review');
  assert.equal(mergeTier(undefined, 'not_qualified'), 'not_qualified');
});

test('a new inquiry becomes a Lead with the required fields filled', () => {
  const { type, fields } = buildRecordFields({ ...inquiry, source: 'form', company: 'Harborview Dental Group' }, qualification);
  assert.equal(type, 'Lead');
  assert.deepEqual([fields.FirstName, fields.LastName, fields.Company, fields.LeadSource], ['Dana', 'Whitfield', 'Harborview Dental Group', 'Web']);
  assert.deepEqual([fields.Phone, fields.Phone_E164__c, fields.Lead_Tier__c, fields.Inquiry_Source__c], ['+15105550142', '+15105550142', 'needs_review', 'form']);
});

test('missing name and company fall back to safe values', () => {
  const { fields } = buildRecordFields({ ...inquiry, name: null, phone: null }, qualification);
  assert.equal(fields.LastName, 'dana');
  assert.equal(fields.Company, '[not provided]');
  assert.equal('FirstName' in fields, false);
  assert.equal('LeadSource' in fields, false);
  assert.equal(buildRecordFields({ ...inquiry, name: 'Alex', email: null }, qualification).fields.LastName, 'Alex');
});

test('an existing record keeps its identity and tier; only empty fields are filled', () => {
  const record = { type: 'Lead', id: '00QA', fields: { Email: 'dana@example.com', FirstName: 'Dana', LastName: 'Whitfield', Phone: '(510) 555-0142', Lead_Tier__c: 'qualified', Company: '[not provided]' } };
  const result = buildRecordFields({ ...inquiry, company: 'Harborview Dental Group' }, qualification, record);
  assert.equal(result.id, '00QA');
  assert.equal(result.fields.Lead_Tier__c, 'qualified');
  assert.equal(result.fields.Company, 'Harborview Dental Group');
  assert.equal(result.fields.Phone_E164__c, '+15105550142');
  for (const key of ['Email', 'Phone', 'FirstName', 'LastName']) assert.equal(key in result.fields, false, key);
});

test('a Contact never gets a Company field', () => {
  const result = buildRecordFields({ ...inquiry, company: 'Brookside' }, qualification, { type: 'Contact', id: '003A', fields: { Email: 'dana@example.com' } });
  assert.equal(result.type, 'Contact');
  assert.equal('Company' in result.fields, false);
});

test('a duplicate rule block names the existing record', () => {
  const body = [{ errorCode: 'DUPLICATES_DETECTED', message: 'Use one of these records?', duplicateResult: { matchResults: [{ entityType: 'Lead', matchRecords: [{ record: { attributes: { type: 'Lead' }, Id: '00QX' } }] }] } }];
  assert.deepEqual(parseDuplicateRule({ statusCode: 400, body }), { type: 'Lead', id: '00QX' });
  assert.equal(parseDuplicateRule({ statusCode: 400, body: [{ errorCode: 'REQUIRED_FIELD_MISSING' }] }), null);
  assert.equal(parseDuplicateRule({ statusCode: 201, body: { id: '00QY' } }), null);
});

test('record links open the Lightning record page', () => {
  assert.equal(recordUrl('https://demo-dev-ed.develop.my.salesforce.com/', 'Lead', '00QA'), 'https://demo-dev-ed.develop.my.salesforce.com/lightning/r/Lead/00QA/view');
});

// Lead/Contact matching, repeat detection and the field values written to Salesforce (SPEC §4).

const TIER_RANK = { not_qualified: 0, needs_review: 1, qualified: 2 };
const PERSON_FIELDS = ['Id', 'FirstName', 'LastName', 'Email', 'Phone', 'Phone_E164__c', 'Lead_Tier__c'];
const NO_COMPANY = '[not provided]';
// Contacts before Leads, email before phone.
const MATCH_ORDER = ['contactEmail', 'leadEmail', 'contactPhone', 'leadPhone'];

function soqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function nationalDigits(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function buildLookupRequest(inquiry, apiVersion) {
  const base = `/services/data/${apiVersion}`;
  const query = (referenceId, soql) => ({ method: 'GET', url: `${base}/query?q=${encodeURIComponent(soql)}`, referenceId });
  const contactFields = PERSON_FIELDS.join(', ');
  const leadFields = `${contactFields}, Company`;
  const requests = [query('dupTask', `SELECT Id, WhoId FROM Task WHERE Inquiry_Source_ID__c = ${soqlString(inquiry.source_id)} LIMIT 1`)];
  if (inquiry.email) {
    requests.push(query('contactEmail', `SELECT ${contactFields} FROM Contact WHERE Email = ${soqlString(inquiry.email)} ORDER BY CreatedDate LIMIT 1`));
    requests.push(query('leadEmail', `SELECT ${leadFields} FROM Lead WHERE Email = ${soqlString(inquiry.email)} AND IsConverted = false ORDER BY CreatedDate LIMIT 1`));
  }
  if (inquiry.phone) {
    requests.push(query('contactPhone', `SELECT ${contactFields} FROM Contact WHERE Phone_E164__c = ${soqlString(inquiry.phone)} ORDER BY CreatedDate LIMIT 1`));
    requests.push(query('leadPhone', `SELECT ${leadFields} FROM Lead WHERE Phone_E164__c = ${soqlString(inquiry.phone)} AND IsConverted = false ORDER BY CreatedDate LIMIT 1`));
  }
  return { allOrNone: false, compositeRequest: requests };
}

// Composite does not accept /search, so the phone search is its own call, made only when nothing else matched.
// It finds numbers typed in another format; new records show up in search after a few minutes.
function phoneSearchPath(inquiry) {
  const contactFields = PERSON_FIELDS.join(', ');
  const sosl = `FIND {${nationalDigits(inquiry.phone)}} IN PHONE FIELDS RETURNING Contact(${contactFields} ORDER BY CreatedDate), Lead(${contactFields}, Company WHERE IsConverted = false ORDER BY CreatedDate)`;
  return `/search?q=${encodeURIComponent(sosl)}`;
}

function readPhoneSearch(response) {
  if (!response || response.statusCode !== 200) {
    throw new Error(`Salesforce phone search failed: ${response ? response.statusCode : 'no response'} ${JSON.stringify(response && response.body).slice(0, 300)}`);
  }
  const list = (response.body && response.body.searchRecords) || [];
  // Search results mix both types; prefer a Contact.
  return recordOf(list.find((item) => item.attributes.type === 'Contact') || list[0]);
}

function recordOf(item) {
  if (!item) return null;
  const { attributes, ...fields } = item;
  return { type: attributes && attributes.type, id: item.Id, fields };
}

// Input is the HTTP node output with fullResponse + neverError: { statusCode, body }.
function resolveMatch(response) {
  if (!response || response.statusCode !== 200 || !response.body || !Array.isArray(response.body.compositeResponse)) {
    throw new Error(`Salesforce lookup failed: ${response ? response.statusCode : 'no response'} ${JSON.stringify(response && response.body).slice(0, 300)}`);
  }
  const parts = Object.fromEntries(response.body.compositeResponse.map((part) => [part.referenceId, part]));
  const failed = Object.values(parts).filter((part) => part.httpStatusCode !== 200);
  if (failed.length) {
    // A missing field or bad query must not look like "no match": stop so the error workflow alerts.
    throw new Error(`Salesforce lookup failed: ${failed.map((part) => `${part.referenceId} ${part.httpStatusCode} ${JSON.stringify(part.body).slice(0, 200)}`).join('; ')}`);
  }
  const records = (ref) => (parts[ref] ? parts[ref].body.records || [] : []);
  const task = records('dupTask')[0];
  const duplicate = task ? { taskId: task.Id, whoId: task.WhoId } : null;
  for (const ref of MATCH_ORDER) {
    const found = records(ref)[0];
    if (found) return { record: recordOf(found), matchedBy: ref, duplicate };
  }
  return { record: null, matchedBy: null, duplicate };
}

function mergeTier(existing, incoming) {
  if (!existing || !(existing in TIER_RANK)) return incoming;
  return existing === 'qualified' ? 'qualified' : incoming;
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

function aiFields(inquiry, qualification, currentTier) {
  return {
    Lead_Tier__c: mergeTier(currentTier, qualification.tier),
    Inquiry_Topic__c: qualification.topic,
    Inquiry_Urgency__c: qualification.urgency,
    Inquiry_Source__c: inquiry.source,
    AI_Reason__c: qualification.reason,
  };
}

// New inquiries become Leads; Lead needs LastName and Company.
function newLeadFields(inquiry, qualification) {
  const name = splitName(inquiry.name);
  const emailName = inquiry.email ? inquiry.email.split('@')[0] : '';
  const fields = {
    LastName: name.last || name.first || emailName || '(unknown)',
    Company: inquiry.company || NO_COMPANY,
    ...aiFields(inquiry, qualification, null),
  };
  if (name.last && name.first) fields.FirstName = name.first;
  if (inquiry.email) fields.Email = inquiry.email;
  if (inquiry.phone) {
    fields.Phone = inquiry.phone;
    fields.Phone_E164__c = inquiry.phone;
  }
  if (inquiry.source === 'form') fields.LeadSource = 'Web';
  return { type: 'Lead', fields };
}

// Existing records keep their identity; only empty fields are filled.
function updateFields(inquiry, qualification, record) {
  const current = record.fields || {};
  const fields = aiFields(inquiry, qualification, current.Lead_Tier__c);
  const name = splitName(inquiry.name);
  if (inquiry.email && !current.Email) fields.Email = inquiry.email;
  if (inquiry.phone && !current.Phone) fields.Phone = inquiry.phone;
  if (inquiry.phone && !current.Phone_E164__c) fields.Phone_E164__c = inquiry.phone;
  if (name.last && name.first && !current.FirstName) fields.FirstName = name.first;
  if (record.type === 'Lead' && inquiry.company && (!current.Company || current.Company === NO_COMPANY)) fields.Company = inquiry.company;
  return { type: record.type, id: record.id, fields };
}

function buildRecordFields(inquiry, qualification, record = null) {
  return record ? updateFields(inquiry, qualification, record) : newLeadFields(inquiry, qualification);
}

// Salesforce duplicate rules can block a new Lead; the error names the existing record.
function parseDuplicateRule(response) {
  if (!response || response.statusCode !== 400 || !Array.isArray(response.body)) return null;
  const error = response.body.find((item) => item.errorCode === 'DUPLICATES_DETECTED');
  if (!error || !error.duplicateResult) return null;
  for (const result of error.duplicateResult.matchResults || []) {
    const match = (result.matchRecords || [])[0];
    if (match && match.record && match.record.Id) return { type: result.entityType || (match.record.attributes && match.record.attributes.type), id: match.record.Id };
  }
  return null;
}

function recordUrl(instanceUrl, type, id) {
  return `${String(instanceUrl || '').replace(/\/+$/, '')}/lightning/r/${type}/${id}/view`;
}

if (typeof module !== 'undefined') module.exports = { soqlString, nationalDigits, buildLookupRequest, phoneSearchPath, readPhoneSearch, resolveMatch, mergeTier, buildRecordFields, parseDuplicateRule, recordUrl, PERSON_FIELDS, NO_COMPANY };

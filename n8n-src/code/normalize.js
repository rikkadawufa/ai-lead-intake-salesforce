// Turn a form webhook or an IMAP email into one inquiry shape (SPEC §3.1).

function toE164(raw, defaultCountryCode = '1') {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const digits = text.replace(/[^\d]/g, '');
  if (text.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (text.startsWith('00')) return digits.length - 2 >= 8 && digits.length - 2 <= 15 ? `+${digits.slice(2)}` : null;
  if (defaultCountryCode === '1') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  }
  return null;
}

function cleanText(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

function cleanEmail(value) {
  const text = cleanText(value);
  return text ? text.toLowerCase() : null;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

function formSubmissionId(body) {
  if (cleanText(body.submission_id)) return String(body.submission_id).trim();
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(`${cleanEmail(body.email) || ''}|${cleanText(body.message) || ''}`).digest('hex').slice(0, 16);
}

function normalizeForm(body = {}, headers = {}, { demoMode = false, now = new Date().toISOString() } = {}) {
  return {
    source: 'form',
    source_id: `form:${formSubmissionId(body)}`,
    received_at: now,
    name: cleanText(body.name),
    email: cleanEmail(body.email),
    phone: toE164(body.phone),
    company: cleanText(body.company),
    subject: cleanText(body.subject) || 'Website contact form',
    message: cleanText(body.message) || '',
    demo_flags: { break_llm: Boolean(demoMode) && String(headerValue(headers, 'x-demo-break-llm') || '') === '1' },
  };
}

// mailparser addresses look like { value: [{ address, name }], text }; the simple format gives a string.
function firstAddress(field) {
  if (!field) return { address: null, name: null };
  if (typeof field === 'string') {
    const match = field.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    return match ? { address: match[2].trim(), name: match[1].trim() || null } : { address: field.trim(), name: null };
  }
  const first = Array.isArray(field.value) ? field.value[0] : null;
  return first ? { address: first.address || null, name: first.name || null } : firstAddress(field.text);
}

function stripQuotedReply(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    if (line === '-- ' || line.trim() === '--') break;
    if (/^On .+wrote:$/.test(line.trim())) break;
    if (line.trim().startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function findPhone(text) {
  const match = String(text || '').match(/(\+?\d[\d\s().-]{7,}\d)/);
  return match ? toE164(match[1]) : null;
}

function normalizeEmail(mail = {}, { selfAddress = '', now = new Date().toISOString() } = {}) {
  const from = firstAddress(mail.from);
  const replyTo = firstAddress(mail.replyTo || headerValue(mail.headers, 'reply-to'));
  const self = String(selfAddress || '').toLowerCase();
  if (!replyTo.address && from.address && from.address.toLowerCase() === self) return { skip: true, reason: 'self_sent' };
  const sender = replyTo.address ? replyTo : from;
  const message = stripQuotedReply(mail.text || mail.textPlain || '');
  const messageId = cleanText(mail.messageId || headerValue(mail.headers, 'message-id'));
  const crypto = require('crypto');
  const fallbackId = crypto.createHash('sha256').update(`${sender.address || ''}|${mail.subject || ''}|${message}`).digest('hex').slice(0, 16);
  return {
    source: 'email',
    source_id: `email:${messageId || fallbackId}`,
    received_at: mail.date ? new Date(mail.date).toISOString() : now,
    name: cleanText(sender.name || from.name),
    email: cleanEmail(sender.address),
    phone: findPhone(message),
    company: null,
    subject: cleanText(mail.subject),
    message,
    demo_flags: { break_llm: false },
  };
}

// Demo safety: only reserved example domains, or phone-only inquiries from the fictional 555-0100–0199 range, may reach Salesforce.
function isDemoAddress(email) {
  return /@example\.(com|org)$/i.test(String(email || ''));
}

function isDemoPhone(e164) {
  return /^\+1\d{3}55501\d{2}$/.test(String(e164 || ''));
}

function validateInquiry(inquiry, { demoOnly = false } = {}) {
  if (!inquiry.email && !inquiry.phone) return { valid: false, reason: 'no_contact' };
  if (inquiry.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inquiry.email)) return { valid: false, reason: 'bad_email' };
  if (demoOnly && !(inquiry.email ? isDemoAddress(inquiry.email) : isDemoPhone(inquiry.phone))) return { valid: false, reason: 'non_demo_address' };
  if (String(inquiry.message || '').trim().length < 5) return { valid: false, reason: 'empty_message' };
  return { valid: true, reason: null };
}

if (typeof module !== 'undefined') module.exports = { toE164, normalizeForm, normalizeEmail, validateInquiry, isDemoAddress, isDemoPhone, stripQuotedReply, firstAddress };

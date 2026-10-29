// Human approval: review page, decision parsing and the outgoing reply (SPEC §6).

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeId(sourceId) {
  return String(sourceId || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

const TIER_LABEL = { qualified: 'Qualified', needs_review: 'Needs review', not_qualified: 'Not qualified' };

function buildReviewPage({ inquiry, qualification, draft, recordUrl, resumeUrl }) {
  const row = (label, value) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reply review: ${escapeHtml(inquiry.name || inquiry.email || 'new lead')}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 16px;background:#f4f6f8;color:#1d2430}
section{background:#fff;border-radius:10px;padding:1rem 1.25rem;margin:1rem 0;box-shadow:0 1px 2px #0001}
h1{font-size:1.4rem}h2{font-size:1.05rem;margin:.2rem 0 .8rem}th{text-align:left;color:#5b6575;font-weight:600;padding:.2rem 1rem .2rem 0;vertical-align:top;white-space:nowrap}
.msg{white-space:pre-wrap;background:#f7f8fa;border-radius:6px;padding:.75rem}.tier{display:inline-block;border-radius:999px;padding:.1rem .6rem;background:#e7f0ff;color:#1747a6;font-weight:600}
label{display:block;margin:.8rem 0 .3rem;font-weight:600}input[type=text],textarea{width:100%;box-sizing:border-box;font:inherit;padding:.5rem;border:1px solid #c9cfd8;border-radius:6px}
textarea{min-height:12rem}.choices label{display:inline-block;font-weight:500;margin-right:1.5rem}button{font:inherit;font-weight:600;background:#1d4ed8;color:#fff;border:0;border-radius:6px;padding:.6rem 1.2rem;cursor:pointer}
.note{color:#5b6575;font-size:.9rem}</style></head><body>
<h1>Review the AI draft before anything is sent</h1>
<section><h2>Inquiry</h2><table>
${row('From', `${inquiry.name || '(no name)'} <${inquiry.email || 'no email'}>`)}
${row('Phone', inquiry.phone || '(not given)')}
${row('Company', inquiry.company || '(not given)')}
${row('Source', `${inquiry.source} · ${inquiry.received_at}`)}
${row('Subject', inquiry.subject || '(none)')}
</table><p class="msg">${escapeHtml(inquiry.message)}</p>
<p><a href="${escapeHtml(recordUrl)}">Open record in Salesforce</a></p></section>
<section><h2>AI classification</h2><p><span class="tier">${escapeHtml(TIER_LABEL[qualification.tier] || qualification.tier)}</span> · ${escapeHtml(qualification.topic)} · urgency ${escapeHtml(qualification.urgency)}</p><p>${escapeHtml(qualification.reason)}</p></section>
<section><h2>Draft reply</h2><form method="POST" action="${escapeHtml(resumeUrl)}" enctype="application/x-www-form-urlencoded">
<label for="subject">Subject</label><input type="text" id="subject" name="subject" value="${escapeHtml(draft.subject)}">
<label for="body">Message</label><textarea id="body" name="body">${escapeHtml(draft.body)}</textarea>
<label>Decision</label><div class="choices"><label><input type="radio" name="decision" value="approve"> Approve and send</label><label><input type="radio" name="decision" value="reject"> Reject, send nothing</label></div>
<label for="reviewer">Your name</label><input type="text" id="reviewer" name="reviewer" required>
<p class="note">Nothing is sent until you approve. Your name is saved on the Salesforce record with the decision.</p>
<button type="submit">Submit review</button></form></section></body></html>`;
}

function parseDecision(body, draft) {
  if (body == null) return { timedOut: true, errors: [] };
  const errors = [];
  const reviewer = String(body.reviewer || '').trim();
  const decision = String(body.decision || '').trim();
  if (!reviewer) errors.push('Your name is required');
  if (!['approve', 'reject'].includes(decision)) errors.push('Choose Approve or Reject');
  const subject = String(body.subject ?? draft.subject).trim();
  const text = String(body.body ?? draft.body).replace(/\r\n/g, '\n').trim();
  if (decision === 'approve' && (!subject || !text)) errors.push('Subject and message cannot be empty');
  const edited = subject !== String(draft.subject).trim() || text !== String(draft.body).replace(/\r\n/g, '\n').trim();
  return { timedOut: false, errors, reviewer, decision, subject, body: text, edited };
}

function outgoingEmail({ to, subject, body, demoMode, redirectTo }) {
  if (demoMode) {
    if (!redirectTo) throw new Error('DEMO_MODE=1 needs REPLY_REDIRECT_TO; refusing to email a demo address');
    return { to: redirectTo, subject: `[demo → ${to}] ${subject}`, body };
  }
  return { to, subject, body };
}

function errorPage(errors) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Review not accepted</title></head><body style="font:16px system-ui;max-width:640px;margin:3rem auto"><h1>Review not accepted</h1><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul><p>Go back, fix the form and submit again. Nothing was sent.</p></body></html>`;
}

function receiptPage(text) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Review received</title></head><body style="font:16px system-ui;max-width:640px;margin:3rem auto"><h1>${escapeHtml(text)}</h1></body></html>`;
}

if (typeof module !== 'undefined') module.exports = { escapeHtml, safeId, buildReviewPage, parseDecision, outgoingEmail, errorPage, receiptPage };

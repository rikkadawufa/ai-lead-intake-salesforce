import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkflows } from './build-workflows.mjs';

const workflows = buildWorkflows(mkdtempSync(join(tmpdir(), 'wf-')));

test('builds the five workflows and every connection points at a real node', () => {
  assert.deepEqual(workflows.map((item) => item.id), ['wfFormIntake', 'wfEmailIntake', 'wfProcessInquiry', 'wfReviewPage', 'wfErrorHandler']);
  for (const workflow of workflows) {
    const names = new Set(workflow.nodes.map((node) => node.name));
    assert.equal(names.size, workflow.nodes.length, `${workflow.id} has duplicate node names`);
    for (const [from, value] of Object.entries(workflow.connections)) {
      assert.ok(names.has(from), `${workflow.id}: unknown source ${from}`);
      for (const branch of value.main) for (const target of branch) assert.ok(names.has(target.node), `${workflow.id}: unknown target ${target.node}`);
    }
  }
});

test('output is deterministic', () => {
  const again = buildWorkflows(mkdtempSync(join(tmpdir(), 'wf-')));
  assert.equal(JSON.stringify(again), JSON.stringify(workflows));
});

test('code nodes never use $json in run-once-for-all-items mode', () => {
  for (const workflow of workflows) {
    for (const node of workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.code')) {
      assert.ok(!/(^|[^.\w])\$json\b/.test(node.parameters.jsCode), `${workflow.id} / ${node.name} uses $json`);
    }
  }
});

test('the review page and the form it posts to both ask for the review login', () => {
  const page = workflows.find((item) => item.id === 'wfReviewPage').nodes.find((node) => node.name === 'Open review page');
  const wait = workflows.find((item) => item.id === 'wfProcessInquiry').nodes.find((node) => node.name === 'Wait for review');
  assert.equal(page.parameters.authentication, 'basicAuth');
  assert.equal(wait.parameters.incomingAuthentication, 'basicAuth');
  assert.equal(page.credentials.httpBasicAuth.id, 'reviewLoginCred01');
  assert.equal(wait.credentials.httpBasicAuth.id, 'reviewLoginCred01');
});

test('no secret values or leftover HubSpot calls are baked into the workflows', () => {
  const text = JSON.stringify(workflows);
  assert.ok(!/sk-[A-Za-z0-9]{10,}|00D[A-Za-z0-9]{12,15}!|hooks\.slack\.com\/services/.test(text));
  assert.ok(!/hubspot|hubapi/i.test(text));
});

test('every Salesforce call uses the OAuth2 client credentials credential', () => {
  const calls = workflows.flatMap((item) => item.nodes).filter((node) => String(node.parameters.url || '').includes('SF_INSTANCE_URL'));
  assert.ok(calls.length >= 6);
  for (const node of calls) {
    assert.equal(node.parameters.genericAuthType, 'oAuth2Api', node.name);
    assert.equal(node.credentials.oAuth2Api.id, 'salesforceOAuthCred01', node.name);
  }
});

test('a repeat submission stops before the AI call and Salesforce writes', () => {
  const process = workflows.find((item) => item.id === 'wfProcessInquiry');
  const [repeat, fresh] = process.connections['Repeat submission?'].main;
  assert.equal(repeat[0].node, 'Log repeat submission');
  assert.equal(fresh[0].node, 'Build qualify request');
  assert.equal(process.connections['Log repeat submission'].main[0][0].node, 'Write run log');
});

test('LLM_MODE=off skips the stored answers, sorts nothing and raises no AI alert', () => {
  const process = workflows.find((item) => item.id === 'wfProcessInquiry');
  const code = (name) => process.nodes.find((node) => node.name === name).parameters.jsCode;
  assert.match(code('Load mock qualification'), /if \(\$env\.LLM_MODE === 'off'\) return \[\{ json: \{\} \}\];/);
  assert.match(code('Apply qualification'), /\$env\.LLM_MODE === 'off' \? intakeOnlyQualification\(\)/);
  assert.match(code('Log without draft'), /ctx\.qualification\.ai === false \? \[\]/);
});

test('DRAFT_MODE=off sorts as usual but never drafts a reply', () => {
  const process = workflows.find((item) => item.id === 'wfProcessInquiry');
  const gate = process.nodes.find((node) => node.name === 'Draft a reply?');
  assert.match(JSON.stringify(gate.parameters), /\$env\.DRAFT_MODE !== 'off' && \$json\.qualification\.llm_ok/);
  // Every way to a draft goes through that gate.
  assert.deepEqual(Object.entries(process.connections).filter(([, out]) => JSON.stringify(out).includes('"Build draft request"')).map(([name]) => name), ['Draft a reply?']);
});

test('only the reply node sends email, and it uses the redirect-aware fields', () => {
  const process = workflows.find((item) => item.id === 'wfProcessInquiry');
  const senders = process.nodes.filter((node) => node.type === 'n8n-nodes-base.emailSend');
  assert.equal(senders.length, 1);
  assert.equal(senders[0].parameters.toEmail, '={{ $json.email.to }}');
  assert.equal(process.connections['Prepare email'].main[0][0].node, 'Send reply');
});

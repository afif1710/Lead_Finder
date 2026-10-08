import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leadKeys } from '../lib/leads.mjs';
import { openStore, writeJson } from '../lib/store.mjs';
import { sendAlternateTest, sendPilot } from '../lib/workflow.mjs';

const artifactRoot = fileURLToPath(new URL('../../artifacts/alternate-test-tests/', import.meta.url));
const sender = { name: 'Afif', email: 'craftedwebstudio@gmail.com', postalAddress: '123 Sample Street, Sample City', instagram: 'https://www.instagram.com/whitewo_lf404/' };
const email = 'alternate@example.test';
const priorAttemptId = 'original-test-id';

async function fixture(t) {
  await mkdir(artifactRoot, { recursive: true });
  const directory = await mkdtemp(join(artifactRoot, 'case-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const lead = { id: 'lead-original', businessName: 'Example Roofing', phone: '+1 212 555 1111', category: 'Roofing contractor', location: 'New York, NY, USA', mapsUrl: 'https://www.google.com/maps/place/Example/data=!1s0xabc:0xdef' };
  store.state.discovery[lead.id] = { status: 'matched', emails: [
    { email: 'original@example.test', status: 'unknown', source: 'Snov.io' },
    { email, status: 'unknown', source: 'Snov.io' }
  ], evidence: { phoneMatch: true } };
  store.state.sends.push({ id: priorAttemptId, leadId: lead.id, keys: leadKeys(lead), email: 'original@example.test',
    businessName: lead.businessName, status: 'sent', gmailMessageId: 'original-gmail-id',
    unverifiedTest: { email: 'original@example.test', originalStatus: 'unknown' } });
  store.state.pilot.closed = true;
  await store.save();
  await writeJson(join(directory, 'gmail-auth.json'), { fixture: true });
  return { leads: [lead], lead, store, directory, sender, email, priorAttemptId };
}

test('alternate test reserves exactly one different saved address while keeping the pilot closed and prior acceptance intact', async t => {
  const data = await fixture(t);
  let calls = 0;
  const result = await sendAlternateTest({ ...data, sendMessage: async ({ raw }) => {
    calls++;
    const saved = JSON.parse(await readFile(join(data.directory, 'history.json'), 'utf8'));
    assert.equal(saved.pilot.closed, true);
    assert.equal(saved.sends.length, 2);
    assert.equal(saved.sends[0].status, 'sent');
    assert.equal(saved.sends[0].deliveryReport.status, 'user_reported_invalid_recipient');
    assert.equal(saved.sends[1].status, 'reserved');
    assert.equal(saved.sends[1].unverifiedTest.originalStatus, 'unknown');
    assert.equal(saved.sends[1].alternateTest.priorAttemptId, priorAttemptId);
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    assert.match(mime, /To: <alternate@example\.test>/);
    assert.doesNotMatch(mime, /To: <original@example\.test>|\r\n(?:Cc|Bcc):/i);
    return { id: 'alternate-gmail-id' };
  } });
  assert.deepEqual(result, { accepted: 1, attemptedTotal: 2, closed: true });
  assert.equal(calls, 1);
  const reopened = await openStore(data.directory);
  await assert.rejects(sendAlternateTest({ ...data, store: reopened, sendMessage: async () => { calls++; } }), /already exists/);
  await assert.rejects(sendPilot({ ...data, store: reopened, sendMessage: async () => { calls++; } }), /closed/);
  assert.equal(calls, 1);
});

test('an ambiguous alternate test stops once, persists uncertainty and cannot repeat after restart', async t => {
  const data = await fixture(t);
  let calls = 0;
  await assert.rejects(sendAlternateTest({ ...data, sendMessage: async () => {
    calls++;
    throw Object.assign(new Error('timeout'), { code: 'send_unknown', sendOutcome: 'unknown' });
  } }), /one attempt/);
  const store = await openStore(data.directory);
  assert.equal(store.state.sends[1].status, 'unknown');
  assert.equal(store.state.pilot.closed, true);
  await assert.rejects(sendAlternateTest({ ...data, store, sendMessage: async () => { calls++; } }), /unresolved/);
  assert.equal(calls, 1);
});

test('alternate test refuses the original, guessed, wrong-source and invalid Snov addresses without reserving or sending', async t => {
  for (const mode of ['original', 'guessed', 'wrong-source', 'invalid-status', 'wrong-company']) {
    await t.test(mode, async t => {
      const data = await fixture(t);
      if (mode === 'original') data.email = 'original@example.test';
      if (mode === 'guessed') data.email = 'not-in-snov@example.test';
      if (mode === 'wrong-source') data.store.state.discovery[data.lead.id].emails[1].source = 'Guessed';
      if (mode === 'invalid-status') data.store.state.discovery[data.lead.id].emails[1].status = 'invalid';
      if (mode === 'wrong-company') data.store.state.discovery[data.lead.id].status = 'needs_review';
      let calls = 0;
      await assert.rejects(sendAlternateTest({ ...data, sendMessage: async () => { calls++; } }));
      assert.equal(calls, 0);
      assert.equal(data.store.state.sends.length, 1);
      assert.equal(data.store.state.pilot.closed, true);
    });
  }
});

test('suppression, unrelated prior-address use, unresolved attempts and the lifetime cap block alternate tests', async t => {
  for (const mode of ['suppressed-business', 'suppressed-email', 'other-business-email', 'other-business-key', 'reserved', 'unknown', 'limit', 'active-pilot', 'not-single-test', 'wrong-prior', 'failed-prior', 'missing-receipt', 'cancelled']) {
    await t.test(mode, async t => {
      const data = await fixture(t);
      const unrelated = { id: 'other', keys: ['phone:12125552222'], email: 'other@example.test', status: 'sent' };
      if (mode === 'suppressed-business') data.store.state.suppressions.push({ email: 'optedout@example.test', keys: leadKeys(data.lead) });
      if (mode === 'suppressed-email') data.store.state.suppressions.push({ email, keys: [] });
      if (mode === 'other-business-email') data.store.state.sends.push({ ...unrelated, email });
      if (mode === 'other-business-key') data.store.state.sends.push({ ...unrelated, keys: leadKeys(data.lead) });
      if (['reserved', 'unknown'].includes(mode)) data.store.state.sends.push({ ...unrelated, status: mode });
      if (mode === 'limit') for (let index = 0; index < 9; index++) data.store.state.sends.push({ ...unrelated, id: `other-${index}`, email: `other${index}@example.test` });
      if (mode === 'active-pilot') data.store.state.pilot.closed = false;
      if (mode === 'not-single-test') delete data.store.state.sends[0].unverifiedTest;
      if (mode === 'wrong-prior') data.priorAttemptId = 'not-the-original-test';
      if (mode === 'failed-prior') data.store.state.sends[0].status = 'failed';
      if (mode === 'missing-receipt') delete data.store.state.sends[0].gmailMessageId;
      if (mode === 'cancelled') data.signal = AbortSignal.abort();
      const count = data.store.state.sends.length;
      let calls = 0;
      await assert.rejects(sendAlternateTest({ ...data, sendMessage: async () => { calls++; } }));
      assert.equal(calls, 0);
      assert.equal(data.store.state.sends.length, count);
    });
  }
});

test('a missing Gmail receipt is ambiguous and preserves the original accepted test', async t => {
  const data = await fixture(t);
  let calls = 0;
  await assert.rejects(sendAlternateTest({ ...data, sendMessage: async () => { calls++; return {}; } }), /one attempt/);
  const saved = await openStore(data.directory);
  assert.equal(saved.state.sends[0].status, 'sent');
  assert.equal(saved.state.sends[0].gmailMessageId, 'original-gmail-id');
  assert.equal(saved.state.sends[1].status, 'unknown');
  assert.equal(saved.state.pilot.closed, true);
  assert.equal(calls, 1);
});

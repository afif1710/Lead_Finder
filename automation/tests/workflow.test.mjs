import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, unlink, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadLeads, leadKeys, parseCsv, validEmail } from '../lib/leads.mjs';
import { openStore, withLock, writeJson } from '../lib/store.mjs';
import { draftEmail, rawMessage } from '../lib/templates.mjs';
import { discover, eligibleContacts, preparePilot, sendPilot } from '../lib/workflow.mjs';

const sender = { name: 'Afif', email: 'craftedwebstudio@gmail.com', postalAddress: '123 Test Street, Test City, Bangladesh', instagram: 'https://www.instagram.com/whitewo_lf404/' };
const artifactRoot = fileURLToPath(new URL('../../artifacts/automation-tests/', import.meta.url));
await mkdir(artifactRoot, { recursive: true });
const tmpdir = () => artifactRoot;
const fixture = i => ({ id: `lead-${i}`, businessName: `Example Roofing ${i}`, phone: `+1 212 555 ${String(1000 + i)}`, category: 'Roofing contractor', location: 'New York, NY, USA', mapsUrl: `https://www.google.com/maps/place/example/data=!1splace${i}` });
async function setup(t, count = 15) {
  const directory = await mkdtemp(join(tmpdir(), 'lead-automation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const leads = Array.from({ length: count }, (_, i) => fixture(i));
  for (const lead of leads) store.state.discovery[lead.id] = { status: 'matched', emails: [{ email: `office${lead.id}@example.com`, status: 'valid', source: 'Snov.io' }], evidence: { phoneMatch: true } };
  await store.save(); await writeJson(join(directory, 'gmail-auth.json'), { fixture: true });
  return { directory, store, leads, sender };
}

test('CSV parses quotes, embedded newlines, BOM, CRLF and rejects broken quotes', () => {
  assert.deepEqual(parseCsv('\uFEFF"name","text"\r\n"A, B","a\n""b"""\r\n'), [['name', 'text'], ['A, B', 'a\n"b"']]);
  assert.throws(() => parseCsv('"unfinished'), /Unclosed/);
  assert.throws(() => parseCsv('"value"oops'), /Unexpected/);
  assert.equal(validEmail('good@example.com'), true); assert.equal(validEmail('x\nBCC:other@example.com'), false);
});

test('input rejects unconfirmed website status, invalid phones and foreign locations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'source.csv');
  const head = 'business name,phone number,category,location,Google Maps URL,website status\n';
  const line = status => `Example,+1 212 555 1111,Roofing contractor,USA,https://www.google.com/maps/place/test,${status}\n`;
  await writeFile(file, head + line('No website listed on Google Maps'));
  assert.equal((await loadLeads(file)).length, 1);
  await writeFile(file, head + line('Unknown')); await assert.rejects(loadLeads(file), /confirmed/);
  await writeFile(file, (head + line('No website listed on Google Maps')).replace('USA', 'UK')); await assert.rejects(loadLeads(file), /outside/);
});

test('contact selection excludes wrong sources, uncertain emails and shared duplicates', async t => {
  const data = await setup(t, 5);
  data.store.state.discovery['lead-1'].emails[0].status = 'unknown';
  data.store.state.discovery['lead-2'].emails[0].source = 'Guessed';
  data.store.state.discovery['lead-3'].emails[0].email = data.store.state.discovery['lead-0'].emails[0].email;
  data.store.state.discovery['lead-4'].status = 'needs_review';
  assert.equal(eligibleContacts(data.leads, data.store.state).length, 1);
});

test('different phones for the same Maps place or name/location are one business', async t => {
  const data = await setup(t, 2);
  data.leads[1].mapsUrl = data.leads[0].mapsUrl;
  assert.equal(eligibleContacts(data.leads, data.store.state).length, 1);
  data.leads[1].mapsUrl = fixture(1).mapsUrl;
  data.leads[1].businessName = data.leads[0].businessName;
  assert.equal(eligibleContacts(data.leads, data.store.state).length, 1);
});

test('suppression blocks the business across email changes and sent aliases cannot reenter', async t => {
  const data = await setup(t, 2);
  const keys = leadKeys(data.leads[0]);
  data.store.state.suppressions.push({ email: 'old@example.com', keys });
  assert.deepEqual(eligibleContacts(data.leads, data.store.state).map(l => l.id), ['lead-1']);
  data.store.state.sends.push({ email: 'old2@example.com', keys: leadKeys(data.leads[1]), status: 'unknown' });
  assert.equal(eligibleContacts(data.leads, data.store.state).length, 0);
});

test('pilot sends at most ten, persists reservations before sending, and cannot repeat', async t => {
  const data = await setup(t, 15); let calls = 0;
  assert.equal((await preparePilot(data)).count, 10);
  const receipt = await sendPilot({ ...data, pauseSeconds: 5, sleep: async () => {}, sendMessage: async ({ raw }) => {
    const saved = JSON.parse(await readFile(join(data.directory, 'history.json'), 'utf8'));
    assert.equal(saved.sends.at(-1).status, 'reserved');
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    assert.match(mime, /From: .*<craftedwebstudio@gmail.com>/); assert.ok(!/Bcc:|Cc:/.test(mime));
    calls++; return { id: `gmail-${calls}` };
  } });
  assert.equal(calls, 10); assert.equal(receipt.sent, 10); assert.equal(receipt.closed, true);
  const reopened = await openStore(data.directory);
  await assert.rejects(sendPilot({ ...data, store: reopened, sendMessage: async () => { throw new Error('must not call'); } }), /closed/);
});

test('uncertain send stops without retry and blocks the remaining batch', async t => {
  const data = await setup(t, 3); await preparePilot(data); let calls = 0;
  await assert.rejects(sendPilot({ ...data, sleep: async () => {}, sendMessage: async () => { calls++; throw Object.assign(new Error('timed out'), { code: 'send_unknown' }); } }), /No retry/);
  assert.equal(calls, 1); assert.equal(data.store.state.sends[0].status, 'unknown'); assert.equal(data.store.state.pilot.closed, true);
  assert.equal(eligibleContacts(data.leads, data.store.state).some(l => l.id === 'lead-0'), false);
});

test('small pilot stops after available emails and does not send later discoveries', async t => {
  const data = await setup(t, 2); await preparePilot(data);
  assert.equal((await sendPilot({ ...data, sleep: async () => {}, sendMessage: async () => ({ id: 'message' }) })).sent, 2);
  await assert.rejects(preparePilot(data), /stopped/);
});

test('edited preview, missing postal address and stale evidence block before API calls', async t => {
  const data = await setup(t, 2); await preparePilot(data);
  const file = join(data.directory, 'pilot-preview.json'); const preview = JSON.parse(await readFile(file, 'utf8'));
  preview.recipients[0].draft.to = 'other@example.com'; await writeJson(file, preview);
  await assert.rejects(sendPilot({ ...data, sendMessage: async () => { assert.fail('send forbidden'); } }), /batch.*changed/);
  await assert.rejects(preparePilot({ ...data, sender: { ...sender, postalAddress: '' } }), /postal/);
  await preparePilot(data); data.store.state.discovery['lead-0'].emails[0].status = 'unknown';
  await assert.rejects(sendPilot({ ...data, sendMessage: async () => assert.fail('send forbidden') }), /stale/);
});

test('broken or deleted history is not silently replaced and concurrent runs are blocked', async t => {
  const data = await setup(t, 1);
  await withLock(data.directory, async () => { await assert.rejects(withLock(data.directory, () => assert.fail()), /run.lock/); });
  await writeFile(join(data.directory, 'history.json'), '{'); await assert.rejects(openStore(data.directory), /cannot be read/);
  await unlink(join(data.directory, 'history.json')); await assert.rejects(openStore(data.directory), /History is missing/);
});

test('discovery resumes completed businesses and saves real partial results on quota failure', async t => {
  const data = await setup(t, 3); data.store.state.discovery = {}; let calls = 0;
  const provider = { stats: {}, findEmails: async () => {
    calls++; if (calls === 2) throw Object.assign(new Error('Quota reached'), { code: 'quota' });
    return { status: 'no_email', emails: [], reason: 'No email returned by Snov' };
  } };
  await assert.rejects(discover({ ...data, provider }), /Quota/);
  const reopened = await openStore(data.directory); assert.equal(reopened.state.discovery['lead-0'].status, 'no_email');
  assert.equal(reopened.state.discovery['lead-1'].status, 'interrupted');
  calls = 0; const visited = [];
  const resumed = { stats: {}, findEmails: async lead => { visited.push(lead.id); return { status: 'no_email', emails: [] }; } };
  await discover({ ...data, store: reopened, provider: resumed });
  assert.deepEqual(visited, ['lead-2']);
});

test('legacy domain-only no-results use only the new database route, never another paid name lookup', async t => {
  const data = await setup(t, 3);
  data.store.state.discovery['lead-0'] = { status: 'no_email', emails: [], reason: 'No domain returned' };
  data.store.state.discovery['lead-1'] = { status: 'interrupted', emails: [], errorCode: 'timeout' };
  data.store.state.discovery['lead-2'] = { status: 'needs_review', emails: [], evidence: { phoneConflict: true }, reason: 'Known phone conflict' };
  const provider = { stats: {}, findEmails: async () => assert.fail('Do not resubmit a paid domain task'),
    findDatabaseEmails: async (lead, { onCheckpoint }) => {
      assert.equal(lead.id, 'lead-0'); await onCheckpoint({ operation: 'database_search', phase: 'requested' });
      const saved = JSON.parse(await readFile(join(data.directory, 'history.json'), 'utf8'));
      assert.equal(saved.discovery['lead-0'].status, 'in_progress');
      return { status: 'no_email', emails: [], searchedRoutes: ['database'] };
    } };
  const summary = await discover({ ...data, provider });
  assert.equal(summary.checked, 2);
  assert.equal(summary.interrupted, 1);
  assert.deepEqual(data.store.state.discovery['lead-0'].searchedRoutes, ['domain', 'database']);
  assert.equal(data.store.state.discovery['lead-1'].status, 'interrupted');
  assert.equal(data.store.state.discovery['lead-2'].evidence.phoneConflict, true);
  await discover({ ...data, provider: { stats: {}, findEmails: async () => assert.fail('Completed results cannot repeat'), findDatabaseEmails: async () => assert.fail('Completed database route cannot repeat') } });
});

test('drafts use actual category, no price or backend promises, accurate footer and deterministic variation', () => {
  const roofing = { ...fixture(1), email: 'contact@example.com' };
  const fence = { ...fixture(2), category: 'Fence contractor', email: 'hello@example.com' };
  const a = draftEmail(roofing, sender), b = draftEmail(fence, sender);
  assert.match(a.body, /roofing/); assert.match(b.body, /fenc/); assert.match(a.body, /free demo/);
  assert.match(a.body, /reply "no"/); assert.match(a.body, /Website design offer/); assert.match(a.body, /Test Street/);
  assert.ok(!/upfront|payment|database|booking system|backend|\$\d/i.test(a.body));
  assert.deepEqual(a, draftEmail(roofing, sender));
  assert.notEqual(a.body, b.body);
  assert.throws(() => rawMessage({ ...a, subject: 'x\nBCC:y@example.com' }, sender, 'message@gmail.com'), /Unsafe/);
});

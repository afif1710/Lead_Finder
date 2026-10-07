import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runAutomation, parseRunOptions } from '../lib/pipeline.mjs';
import { openStore, writeJson } from '../lib/store.mjs';
import { preparePilot, sendPilot, eligibleContacts } from '../lib/workflow.mjs';
import { writeLeadCsv } from '../lib/maps.mjs';
import { leadId } from '../lib/leads.mjs';
const artifacts = fileURLToPath(new URL('../../artifacts/automation-tests/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const sender = { name: 'Afif', email: 'craftedwebstudio@gmail.com', postalAddress: '123 Test St, Test City, Bangladesh', instagram: 'https://www.instagram.com/whitewo_lf404/' };
const lead = index => { const value = { businessName: `Fixture Fence ${index}`, phone: `+1 212 555 ${1000 + index}`, category: 'Fence contractor', location: 'New York, NY, USA', address: '123 Example St, New York, NY 10001, United States', profession: 'fence contractors', mapsUrl: `https://www.google.com/maps/place/fixture/data=!1sfixture${index}`, checkedDate: '2026-10-08' }; return { ...value, id: leadId(value) }; };
async function fixture(t) {
  const root = await mkdtemp(join(artifacts, 'pipeline-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'automation', '.local'), store = await openStore(directory);
  await writeJson(join(directory, 'gmail-auth.json'), { fixture: true });
  return { root, directory, store, baseline: [], config: { sender, snovCredentialsFile: 'fixture-unused', limits: { maxSnovRequestsPerRun: 20, maxSnovCreditsPerRun: 5, discoveryMinutes: 1, pauseSeconds: 5 } } };
}

test('complete Maps-to-email workflow selects exactly one contact and closes after the first batch', async t => {
  const data = await fixture(t); const events = [], current = lead(1);
  const collect = async () => { events.push('maps'); const file = join(data.root, 'leads.csv'); await writeLeadCsv(file, [current]); return { leads: [current], file, stopReason: 'target_reached' }; };
  const providerFactory = async () => ({ stats: {}, findEmails: async () => { events.push('snov'); return { status: 'matched', evidence: { cityExact: true, stateExact: true }, emails: [{ email: 'office@example.com', source: 'Snov.io', status: 'valid' }] }; } });
  const result = await runAutomation({ ...data, collect, providerFactory, sendMessage: async ({ raw }) => {
    events.push('gmail'); const saved = JSON.parse(await readFile(join(data.directory, 'history.json'), 'utf8'));
    assert.equal(saved.sends[0].status, 'reserved'); assert.match(Buffer.from(raw, 'base64url').toString('utf8'), /To: <office@example.com>/); return { id: 'accepted-fixture' };
  } });
  assert.deepEqual(events, ['maps', 'snov', 'gmail']); assert.equal(result.sent, 1); assert.equal(result.newMapsLeads, 1);
  await assert.rejects(runAutomation({ ...data, collect: async () => assert.fail('No second collection') }), /closed/);
});

test('zero sendable contacts stops the workflow without attempting Gmail', async t => {
  const data = await fixture(t); const current = lead(1);
  const result = await runAutomation({ ...data, collect: async () => ({ leads: [current], file: 'unused.csv', stopReason: 'target_reached' }),
    providerFactory: async () => ({ stats: {}, findEmails: async () => ({ status: 'no_email', emails: [] }) }), sendMessage: async () => assert.fail('No email may be sent') });
  assert.equal(result.sent, 0); assert.equal(result.stopReason, 'no_verified_contacts'); assert.equal(data.store.state.pilot.closed, false);
});

test('dry run checkpoints a preview and resumes saved collection without repeating paid lookups', async t => {
  const data = await fixture(t); const current = lead(1); let maps = 0, paid = 0;
  const collect = async () => { maps++; const file = join(data.root, 'leads.csv'); await writeLeadCsv(file, [current]); return { leads: [current], file, stopReason: 'target_reached' }; };
  const providerFactory = async () => ({ stats: {}, findEmails: async () => { paid++; return { status: 'matched', emails: [{ email: 'contact@example.com', source: 'Snov.io', status: 'valid' }] }; } });
  const result = await runAutomation({ ...data, collect, providerFactory, runOptions: { dryRun: true }, sendMessage: async () => assert.fail('Dry run must not send') });
  assert.equal(result.stopReason, 'dry_run'); assert.equal(data.store.state.sends.length, 0);
  const resumed = await runAutomation({ ...data, collect, providerFactory, sendMessage: async () => ({ id: 'once' }) });
  assert.equal(resumed.sent, 1); assert.equal(maps, 1); assert.equal(paid, 1);
});

test('Snov interruption preserves progress and stops before preparation or sending', async t => {
  const data = await fixture(t); const current = lead(1);
  data.baseline = [lead(0)];
  await assert.rejects(runAutomation({ ...data, collect: async () => ({ leads: [current], file: 'unused.csv' }),
    providerFactory: async () => ({ stats: {}, findEmails: async () => { throw Object.assign(new Error('API quota exhausted'), { code: 'quota' }); } }), sendMessage: async () => assert.fail('No Gmail call') }), /quota/);
  assert.equal(data.store.state.discovery[current.id].status, 'interrupted'); assert.equal(data.store.state.workflow.stage, 'snov');
  const saved = JSON.parse(await readFile(join(data.directory, 'collected-emails.json'), 'utf8'));
  assert.deepEqual(saved.map(row => row.businessName), ['Fixture Fence 0', 'Fixture Fence 1']);
});

test('cancellation between collection and discovery stops before Snov or Gmail', async t => {
  const data = await fixture(t); const controller = new AbortController();
  await assert.rejects(runAutomation({ ...data, signal: controller.signal, collect: async () => { controller.abort(); return { leads: [lead(1)], file: 'unused.csv' }; },
    providerFactory: async () => assert.fail('No paid search after cancellation'), sendMessage: async () => assert.fail('No email after cancellation') }), /stopped/);
  assert.equal(data.store.state.sends.length, 0);
});

test('the user-authorized unverified test accepts one saved Snov recipient without relabelling it valid', async t => {
  const data = await fixture(t); const current = lead(1); data.baseline = [current];
  data.store.state.discovery[current.id] = { status: 'matched', emails: [{ email: 'saved@example.com', source: 'Snov.io', status: 'unknown' }, { email: 'other@example.com', source: 'Snov.io', status: 'unknown' }] };
  assert.equal(eligibleContacts(data.baseline, data.store.state).length, 0);
  const result = await runAutomation({ ...data, runOptions: { testEmail: 'saved@example.com' }, collect: async () => ({ leads: [], file: 'empty.csv', stopReason: 'search_limit' }),
    providerFactory: async () => assert.fail('Saved Snov contacts must be reused'), sendMessage: async () => ({ id: 'test-accepted' }) });
  assert.equal(result.sent, 1); assert.equal(data.store.state.sends[0].unverifiedTest.originalStatus, 'unknown');
  assert.equal(data.store.state.discovery[current.id].emails[0].status, 'unknown'); assert.equal(data.store.state.pilot.closed, true);
});

test('test selection cannot use a guessed, invalid, mismatched or second email', async t => {
  const data = await fixture(t); const current = lead(1); const leads = [current];
  data.store.state.discovery[current.id] = { status: 'matched', emails: [{ email: 'saved@example.com', source: 'Snov.io', status: 'unknown' }] };
  await assert.rejects(preparePilot({ ...data, leads, sender, testEmail: 'guessed@example.com' }), /No matched/);
  data.store.state.discovery[current.id].emails[0].status = 'not_valid';
  await assert.rejects(preparePilot({ ...data, leads, sender, testEmail: 'saved@example.com' }), /No matched/);
  data.store.state.discovery[current.id].emails[0].status = 'unknown'; data.store.state.discovery[current.id].status = 'needs_review';
  await assert.rejects(preparePilot({ ...data, leads, sender, testEmail: 'saved@example.com' }), /No matched/);
  data.store.state.discovery[current.id].status = 'matched'; await preparePilot({ ...data, leads, sender, testEmail: 'saved@example.com' });
  const file = join(data.directory, 'pilot-preview.json'), preview = JSON.parse(await readFile(file, 'utf8'));
  preview.testEmail = 'other@example.com'; await writeJson(file, preview);
  await assert.rejects(sendPilot({ ...data, leads, sender, sendMessage: async () => assert.fail('Edited preview must not send') }), /changed/);
});

test('unknown send outcome blocks every rerun including the single-email test', async t => {
  const data = await fixture(t); const current = lead(1); data.baseline = [current];
  data.store.state.discovery[current.id] = { status: 'matched', emails: [{ email: 'saved@example.com', source: 'Snov.io', status: 'unknown' }] };
  await assert.rejects(runAutomation({ ...data, runOptions: { testEmail: 'saved@example.com' }, collect: async () => ({ leads: [], file: 'empty.csv' }), sendMessage: async () => { throw Object.assign(new Error('Network timeout'), { code: 'send_unknown' }); } }), /No retry/);
  assert.equal(data.store.state.sends[0].status, 'unknown');
  await assert.rejects(runAutomation({ ...data, runOptions: { testEmail: 'saved@example.com' }, collect: async () => assert.fail('Do not repeat') }), /closed/);
});

test('workflow flags are bounded and malformed or repeated flags fail before side effects', () => {
  assert.deepEqual(parseRunOptions(['--target', '1', '--searches', '2', '--dry-run']), { target: 1, maxSearches: 2, dryRun: true });
  for (const args of [['--target', '101'], ['--minutes', '-1'], ['--target', '1', '--target', '2'], ['--test-email'], ['--unknown']]) assert.throws(() => parseRunOptions(args));
});

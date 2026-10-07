import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { collectMaps, MapsError, bounded, writeLeadCsv } from '../lib/maps.mjs';
import { openStore } from '../lib/store.mjs';
import { loadLeads, leadId } from '../lib/leads.mjs';
const artifacts = fileURLToPath(new URL('../../artifacts/automation-tests/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const queries = Array.from({ length: 4 }, (_, index) => ({ profession: 'fence contractors', city: `District ${index}, Texas, USA` }));
const lead = (index = 0) => ({ businessName: `Example Fence ${index}`, phone: `+1 212 555 ${1000 + index}`, category: 'Fence contractor', location: 'New York, NY, USA', address: '123 Example St, New York, NY 10001, United States', profession: 'fence contractors', mapsUrl: `https://www.google.com/maps/place/example/data=!1splace${index}`, websiteStatus: 'No website listed on Google Maps', checkedDate: '2026-10-08' });
const candidate = index => ({ name: lead(index).businessName, phone: lead(index).phone, link: lead(index).mapsUrl });
async function fixture(t) {
  const root = await mkdtemp(join(artifacts, 'maps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'automation', '.local');
  return { root, directory, store: await openStore(directory), queries };
}

test('Maps collection exports sorted unique US businesses and retains lifetime duplicate keys', async t => {
  const data = await fixture(t); let searches = 0, closes = 0;
  const prior = { ...lead(0), id: leadId(lead(0)) };
  const browserFactory = async () => ({ channel: 'fixture', search: async () => { searches++; return { candidates: [candidate(0), candidate(1), candidate(1), candidate(2)], status: 'finished', file: null }; }, verify: async row => lead(Number(row.name.at(-1))), close: async () => { closes++; } });
  const result = await collectMaps({ ...data, baseline: [prior], target: 2, browserFactory });
  assert.equal(result.leads.length, 2); assert.equal(searches, 1); assert.equal(closes, 1);
  assert.equal(result.stopReason, 'target_reached');
  const imported = await loadLeads(result.file);
  assert.deepEqual(imported.map(row => row.businessName), ['Example Fence 1', 'Example Fence 2']);
  const reopened = await openStore(data.directory);
  const again = await collectMaps({ ...data, store: reopened, baseline: [prior], target: 1, maxSearches: 1, browserFactory });
  assert.equal(again.leads.length, 0); assert.equal(again.stopReason, 'search_limit');
  assert.equal(reopened.state.maps.runs[result.runId].leads.length, 2);
});

test('zero-lead queries advance once and stop at the finite search limit', async t => {
  const data = await fixture(t); let calls = 0;
  const browserFactory = async () => ({ search: async () => { calls++; return { candidates: [], status: 'no results', file: null }; }, close: async () => {} });
  const result = await collectMaps({ ...data, maxSearches: 2, browserFactory });
  assert.equal(calls, 2); assert.equal(result.leads.length, 0); assert.equal(result.stopReason, 'search_limit');
  assert.equal(data.store.state.maps.searches.length, 2);
});

test('consent or CAPTCHA stops the browser and saves partial progress without looping', async t => {
  const data = await fixture(t); let closes = 0;
  const browserFactory = async () => ({ search: async () => { throw new MapsError('captcha', 'Human verification required'); }, close: async () => { closes++; } });
  await assert.rejects(collectMaps({ ...data, browserFactory }), error => error.code === 'captcha' && error.partialResult.leads.length === 0);
  assert.equal(closes, 1); assert.equal(data.store.state.maps.searches.length, 1);
  assert.equal(data.store.state.maps.runs[data.store.state.maps.activeRun].status, 'blocked');
});

test('individual website, location and category failures do not become accepted leads', async t => {
  const data = await fixture(t);
  const browserFactory = async () => ({ search: async () => ({ candidates: [candidate(1), candidate(2), candidate(3)], file: null }), verify: async row => {
    const index = Number(row.name.at(-1));
    if (index === 1) throw new MapsError('website_listed', 'Website exists');
    return { ...lead(index), ...(index === 2 ? { location: 'Toronto, Canada' } : { category: 'Restaurant' }) };
  }, close: async () => {} });
  const result = await collectMaps({ ...data, maxSearches: 1, browserFactory });
  assert.equal(result.leads.length, 0); assert.equal(result.profilesChecked, 3);
  assert.deepEqual(data.store.state.maps.searches[0].rejected, { website_listed: 1, unconfirmed: 1, category: 1 });
});

test('bounded browser operations reject a hung promise and a cancelled run', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 25), error => error.code === 'timeout');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bounded(Promise.resolve('ignored'), 100, controller.signal), error => error.code === 'cancelled');
  await assert.rejects(bounded(Promise.reject(new Error('Late browser close')), 100, controller.signal), error => error.code === 'cancelled');
});

test('a browser that launches after collection cancellation is closed without starting a search', async t => {
  const data = await fixture(t); const controller = new AbortController();
  let finishLaunch, startupSignal, closes = 0, finishedClosing;
  const closed = new Promise(resolve => { finishedClosing = resolve; });
  const browserFactory = ({ signal }) => {
    startupSignal = signal;
    const pending = new Promise(resolve => { finishLaunch = resolve; });
    setTimeout(() => controller.abort(), 5);
    return pending;
  };
  await assert.rejects(collectMaps({ ...data, signal: controller.signal, browserFactory }), error => error.code === 'cancelled');
  assert.equal(startupSignal.aborted, true);
  finishLaunch({ search: async () => assert.fail('An abandoned browser must not search'), close: async () => { closes++; finishedClosing(); } });
  await bounded(closed, 1000);
  assert.equal(closes, 1);
});

test('a completed CSV can be recovered unchanged but cannot overwrite different data', async t => {
  const data = await fixture(t); const file = join(data.root, 'processed.csv');
  await writeLeadCsv(file, [lead(1)]); await writeLeadCsv(file, [lead(1)]);
  assert.match(await readFile(file, 'utf8'), /Example Fence 1/);
  await assert.rejects(writeLeadCsv(file, [lead(2)]), error => error.code === 'EEXIST');
});

test('invalid or non-US search configuration stops before browser startup', async t => {
  const data = await fixture(t); const browserFactory = async () => assert.fail('No browser should start');
  await assert.rejects(collectMaps({ ...data, target: 101, browserFactory }), /limits/);
  await assert.rejects(collectMaps({ ...data, queries: [{ profession: 'fence', city: 'Dubai' }], browserFactory }), /United States/);
});

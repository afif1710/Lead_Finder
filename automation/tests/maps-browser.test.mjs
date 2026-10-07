import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { collectMaps, createMapsBrowser } from '../lib/maps.mjs';
import { openStore } from '../lib/store.mjs';
const project = fileURLToPath(new URL('../../', import.meta.url));
const artifactRoot = join(project, 'artifacts', 'automation-tests');
await mkdir(artifactRoot, { recursive: true });
const names = ['Fixture Fence With Site', 'Fixture Fence Without Site'];
const places = names.map((name, index) => `https://www.google.com/maps/place/fixture${index}/data=!1sfixture${index}`);
function fixture(url) {
  const index = url.includes('/place/fixture1/') ? 1 : 0;
  if (url.includes('/maps/place/')) return `<!doctype html><html><body><main role="main"><h1 class="fontHeadlineLarge">${names[index]}</h1><button data-item-id="phone:tel:+1212555123${index}">+1 212 555 123${index}</button><button data-item-id="address" aria-label="Address: ${120 + index} Test St, New York, NY 10001, United States">Address</button><button data-item-id="category">Fence contractor</button>${index === 0 ? '<a data-item-id="authority" href="https://example.com">Website</a>' : ''}</main></body></html>`;
  return `<!doctype html><html><body><input id="searchboxinput" value="fence contractors in Knoxville, Tennessee, USA"><main role="main"><div role="feed" style="height:600px;overflow:auto">${names.map((name, index) => `<div role="article"><a aria-label="${name}" href="${places[index]}">${name}</a><span data-category="Fence contractor">Fence contractor</span><span class="UsdlK">+1 212 555 123${index}</span></div>`).join('')}<div data-end-of-list="true">End of results</div></div></main></body></html>`;
}

test('actual MV3 browser stage downloads filtered CSV and rejects a profile whose website was hidden on its card', { timeout: 100000 }, async t => {
  const runRoot = await mkdtemp(join(artifactRoot, 'maps-browser-'));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const directory = join(runRoot, 'automation', '.local'), store = await openStore(directory);
  const result = await collectMaps({ store, root: runRoot, directory, target: 1, maxSearches: 1, maxMinutes: 1, scanSeconds: 15,
    queries: [{ profession: 'fence contractors', city: 'Knoxville, Tennessee, USA' }],
    browserFactory: async options => createMapsBrowser({ ...options, root: project,
      configureContext: context => context.route('https://www.google.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(route.request().url()) })) }) });
  assert.equal(result.leads.length, 1); assert.equal(result.leads[0].businessName, names[1]);
  assert.equal(result.leads[0].location, 'New York, NY, USA');
  assert.equal(result.leads[0].phone, '+1 212 555 1231');
  assert.equal(result.stopReason, 'target_reached');
  const report = store.state.maps.runs[result.runId].attempts[0];
  assert.equal(report.rawRows, 2); assert.equal(report.rejected.website_listed, 1);
  const csv = await readFile(report.rawFile, 'utf8');
  assert.ok(csv.startsWith('\uFEFF')); assert.match(csv, /business name/); assert.match(csv, /Fixture Fence Without Site/);
  const final = await readFile(result.file, 'utf8'); assert.match(final, /No website listed on Google Maps/); assert.ok(!final.includes(names[0]));
});

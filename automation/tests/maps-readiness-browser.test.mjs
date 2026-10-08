import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { createMapsBrowser } from '../lib/maps.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = join(project, 'artifacts', 'automation-tests');
await mkdir(artifacts, { recursive: true });
const query = profession => ({ profession, city: 'Knoxville, Tennessee, USA' });
const candidate = suffix => ({ name: 'Fixture Fence', phone: '+1 212 555 1231',
  link: `https://www.google.com/maps/place/${suffix}/data=!1s0x123:0xabc`,
  profession: 'fence contractors', searchArea: 'Knoxville, Tennessee, USA' });
const feed = '<div role="feed" style="height:600px;overflow:auto"><div role="article"><a href="https://www.google.com/maps/place/fixture/data=!1s0x123:0xabc" aria-label="Fixture Fence">Fixture Fence</a><span data-category="Fence contractor">Fence contractor</span><span class="UsdlK">+1 212 555 1231</span></div><div data-end-of-list="true">End</div></div>';

function fixture(url) {
  if (url.includes('/maps/place/')) {
    const busy = url.includes('/busy/') || url.includes('/late-site/');
    const lateSite = url.includes('/late-site/') ? '<script>setTimeout(()=>{const main=document.querySelector("main");const link=document.createElement("a");link.dataset.itemId="authority";link.href="https://example.com";link.textContent="Website";main.append(link);main.removeAttribute("aria-busy");},3500);</script>' : '';
    return `<!doctype html><html><body><main role="main" ${busy ? 'aria-busy="true"' : ''}><h1 class="fontHeadlineLarge">Fixture Fence</h1><button data-item-id="phone:tel:+12125551231">+1 212 555 1231</button><button data-item-id="address" aria-label="Address: 121 Test St, New York, NY 10001, United States">Address</button><button data-item-id="category">Fence contractor</button>${lateSite}</main></body></html>`;
  }
  const update = url.includes('delayed-feed') ? feed : url.includes('delayed-zero') ? '<p data-no-results="true">No results</p>'
    : url.includes('delayed-consent') ? '<form action="https://consent.google.com/save"></form>'
      : url.includes('delayed-challenge') ? '<div data-captcha-screen></div>' : '';
  const delay = url.includes('delayed-feed') ? 2500 : 500;
  return `<!doctype html><html><body><input id="searchboxinput" value="fence contractors in Knoxville, Tennessee, USA"><main role="main"></main><script>setTimeout(()=>{document.querySelector('main').innerHTML=${JSON.stringify(update)};},${delay});</script></body></html>`;
}

test('isolated MV3 Maps readiness waits for async results and rejects unsettled website absence', { timeout: 100000 }, async t => {
  const root = await mkdtemp(join(artifacts, 'maps-readiness-'));
  const controller = new AbortController();
  const browser = await createMapsBrowser({ root: project, directory: join(root, '.local'), signal: controller.signal,
    configureContext: context => context.route('https://www.google.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(route.request().url()) })) });
  t.after(async () => {
    await browser.close().catch(() => {});
    assert.ok(resolve(root).startsWith(resolve(artifacts) + sep));
    await rm(root, { recursive: true, force: true });
  });

  await t.test('a results list appearing after the extension is ready is collected', async () => {
    const result = await browser.search(query('delayed-feed'), { file: join(root, 'filtered.csv'), scanSeconds: 10 });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].name, 'Fixture Fence');
    assert.equal(result.rawRows, 1);
  });

  await t.test('an asynchronously rendered zero-result state stops without a download', async () => {
    const result = await browser.search(query('delayed-zero'), { file: join(root, 'zero.csv'), scanSeconds: 10 });
    assert.deepEqual(result, { candidates: [], status: 'zero_results', file: null });
  });

  await t.test('a consent or challenge inserted during result loading stops for manual attention', async () => {
    for (const [scenario, code] of [['delayed-consent', 'consent'], ['delayed-challenge', 'captcha']]) {
      await assert.rejects(browser.search(query(scenario), { file: join(root, `${scenario}.csv`), scanSeconds: 10 }), error => error.code === code);
    }
  });

  await t.test('a Website action that hydrates after the phone is rejected', async () => {
    await assert.rejects(browser.verify(candidate('late-site')), error => error.code === 'website_listed');
  });

  await t.test('a stable loaded profile without a Website action remains eligible', async () => {
    const result = await browser.verify(candidate('stable'));
    assert.equal(result.websiteStatus, 'No website listed on Google Maps');
    assert.equal(result.location, 'New York, NY, USA');
  });

  await t.test('a profile which never stops loading is unconfirmed within a finite bound', async () => {
    const started = Date.now();
    await assert.rejects(browser.verify(candidate('busy')), error => error.code === 'profile_unsettled');
    assert.ok(Date.now() - started < 14000, 'Busy-profile verification exceeded its loading bound');
  });

  await t.test('cancellation while waiting for a results list closes the browser promptly', async () => {
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      await assert.rejects(browser.search(query('never-ready'), { file: join(root, 'cancelled.csv'), scanSeconds: 10 }), error => error.code === 'cancelled' || /has been closed/.test(error.message));
    } finally { clearTimeout(timer); }
    assert.ok(Date.now() - started < 5000, 'Cancelled readiness wait did not stop promptly');
  });
});

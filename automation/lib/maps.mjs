import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import vm from 'node:vm';
import { leadId, leadKeys, normalizedName, phoneDigits, parseCsv } from './leads.mjs';
import { writeJson } from './store.mjs';

const TYPES = ['fence contractors', 'bathroom remodelers', 'deck builders', 'flooring contractors', 'landscape contractors', 'roofing contractors', 'concrete contractors', 'kitchen remodelers'];
const CITIES = ['Knoxville, Tennessee, USA', 'Greenville, South Carolina, USA', 'Columbus, Ohio, USA', 'Arlington, Texas, USA', 'Tulsa, Oklahoma, USA', 'Richmond, Virginia, USA', 'Charlotte, North Carolina, USA', 'Birmingham, Alabama, USA', 'Wichita, Kansas, USA', 'Grand Rapids, Michigan, USA', 'Kansas City, Missouri, USA', 'Orlando, Florida, USA', 'Cleveland, Ohio, USA', 'San Antonio, Texas, USA', 'Indianapolis, Indiana, USA', 'Tucson, Arizona, USA'];
export const DEFAULT_QUERIES = CITIES.flatMap((city, index) => TYPES.map((_, offset) => ({ profession: TYPES[(index + offset) % TYPES.length], city })));
const CSV_COLUMNS = ['business name', 'phone number', 'category', 'location', 'address', 'profession', 'Google Maps URL', 'website status', 'checked date'];

export class MapsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'MapsError'; }
}
const problem = (code, message) => new MapsError(code, message);
export function searchKey(query) { return createHash('sha256').update(`${query.profession.toLowerCase().trim()}|${query.city.toLowerCase().trim()}`).digest('hex').slice(0, 24); }

export function bounded(promise, milliseconds, signal, label = 'Maps operation') {
  return new Promise((resolvePromise, reject) => {
    const aborted = () => finish(reject, problem('cancelled', `${label} was stopped.`));
    const timer = setTimeout(() => finish(reject, problem('timeout', `${label} reached its time limit.`)), milliseconds);
    function finish(callback, value) { clearTimeout(timer); signal?.removeEventListener('abort', aborted); callback(value); }
    // Observe the operation even when cancellation happened just before this
    // wrapper, so a late browser rejection cannot become unhandled.
    Promise.resolve(promise).then(value => finish(resolvePromise, value), error => finish(reject, error));
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function csvCell(value, phone = false) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) && !(phone && /^\+1[\d ()-]+$/.test(text))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export async function writeLeadCsv(file, leads) {
  const rows = [CSV_COLUMNS, ...[...leads].sort((a, b) => a.category.localeCompare(b.category) || a.location.localeCompare(b.location) || a.businessName.localeCompare(b.businessName)).map(lead =>
    [lead.businessName, lead.phone, lead.category, lead.location, lead.address || '', lead.profession, lead.mapsUrl, 'No website listed on Google Maps', lead.checkedDate])];
  await mkdir(resolve(file, '..'), { recursive: true });
  // Every output has a unique run ID. Never overwrite an existing raw export.
  const contents = '\uFEFF' + rows.map(row => row.map((cell, index) => csvCell(cell, index === 1)).join(',')).join('\r\n') + '\r\n';
  try { await writeFile(file, contents, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== contents) throw error; }
}

function parseExport(text) {
  const [headers, ...rows] = parseCsv(text);
  const expected = ['business name', 'category', 'phone number', 'website', 'profession', 'city'];
  if (!headers || JSON.stringify(headers) !== JSON.stringify(expected)) throw problem('export_changed', 'The extension CSV columns changed; stop and review the export.');
  return rows.map(row => {
    if (row.length !== headers.length) throw problem('export_changed', 'The extension returned an incomplete CSV row.');
    const value = Object.fromEntries(headers.map((key, index) => [key, row[index]]));
    if (value.website) throw problem('website_filter', 'The no-website CSV unexpectedly contains a website.');
    return value;
  });
}

export async function loadMapSelectors(root) {
  const sandbox = {};
  vm.runInNewContext(await readFile(join(root, 'src', 'selectors.js'), 'utf8'), sandbox, { timeout: 1000 });
  return JSON.parse(JSON.stringify(sandbox.MapsLeadFinder.config.selectors));
}

async function extensionBridge(page) {
  const session = await page.context().newCDPSession(page);
  const contexts = new Map();
  session.on('Runtime.executionContextCreated', ({ context }) => contexts.set(context.id, context));
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  await session.send('Runtime.enable');
  let contextId;
  for (const context of contexts.values()) {
    if (context.auxData?.isDefault) continue;
    try {
      const check = await session.send('Runtime.evaluate', { contextId: context.id, expression: 'Boolean(globalThis.MapsLeadFinder?.runner)', returnByValue: true });
      if (check.result?.value === true) { contextId = context.id; break; }
    } catch { /* A replaced frame cannot be used. */ }
  }
  if (!contextId) { await session.detach(); throw problem('extension_missing', 'The actual Lead Finder extension did not initialize in the isolated browser.'); }
  return {
    async snapshot() {
      const result = await session.send('Runtime.evaluate', { contextId, returnByValue: true, expression: `(() => {
        const runner = globalThis.MapsLeadFinder.runner;
        return { running: runner.running, options: runner.options, checkedDetails: [...runner.results.values()].filter(record => record.detailChecked).length,
          records: runner.records().records.map(record => ({ ...record, link: runner.results.get(record.key)?.link || '' })) };
      })()` });
      if (result.exceptionDetails || !result.result?.value) throw problem('extension_missing', 'Extension state became unavailable.');
      return result.result.value;
    },
    async stop() { await session.send('Runtime.evaluate', { contextId, expression: 'globalThis.MapsLeadFinder.runner.stop()' }); },
    async close() { await session.detach().catch(() => {}); }
  };
}

/** Own headless profiles only. Never attaches to the user's logged-in browser. */
export async function createMapsBrowser({ root, directory, signal, channel = 'msedge', configureContext }) {
  if (!['msedge', 'chromium'].includes(channel)) throw problem('config', 'Use isolated Edge or Playwright Chromium for Maps collection.');
  if (signal?.aborted) throw problem('cancelled', 'Browser startup was stopped.');
  const { chromium } = await import('playwright');
  const selectors = await loadMapSelectors(root);
  const profile = join(directory, '..', 'browser-profiles', `maps-${randomUUID()}`);
  await mkdir(profile, { recursive: true });
  let context;
  let selectedChannel = channel;
  const options = { headless: true, acceptDownloads: true, viewport: { width: 1500, height: 1000 }, timeout: 45000,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] };
  try {
    context = await chromium.launchPersistentContext(profile, { ...options, channel });
    if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker', { timeout: 12000 });
  } catch {
    if (context) await bounded(context.close(), 15000, undefined, 'Browser shutdown').catch(() => {});
    if (signal?.aborted) throw problem('cancelled', 'Browser startup was stopped.');
    if (channel === 'chromium') throw problem('browser_unavailable', 'Playwright Chromium could not load the extension. Check the browser dependency.');
    selectedChannel = 'chromium';
    try {
      context = await chromium.launchPersistentContext(join(profile, 'chromium-fallback'), { ...options, channel: 'chromium' });
      if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker', { timeout: 12000 });
    } catch { if (context) await bounded(context.close(), 15000, undefined, 'Browser shutdown').catch(() => {}); throw problem('browser_unavailable', 'Neither isolated Edge nor Playwright Chromium could load the extension. Install the documented browser dependency.'); }
  }
  context.setDefaultTimeout(10000);
  let closing;
  const closeContext = () => closing ||= bounded(context.close(), 15000, undefined, 'Browser shutdown');
  const closeOnAbort = () => { closeContext().catch(() => {}); };
  signal?.addEventListener('abort', closeOnAbort, { once: true });
  let page, detailPage;
  try {
    if (signal?.aborted) throw problem('cancelled', 'Browser startup was stopped.');
    if (configureContext) await configureContext(context);
    page = await context.newPage(); detailPage = await context.newPage();
    if (signal?.aborted) throw problem('cancelled', 'Browser startup was stopped.');
  } catch (error) {
    signal?.removeEventListener('abort', closeOnAbort);
    await closeContext().catch(() => {});
    throw error;
  }
  async function gate(target) {
    if (target.url().includes('/sorry') || await target.locator(selectors.challenge).count()) throw problem('captcha', 'Google requested human verification. The run stopped; no challenge was bypassed.');
    if (new URL(target.url()).hostname.startsWith('consent.') || await target.locator(selectors.consent).count()) throw problem('consent', 'Google requires cookie consent. The run stopped for manual attention.');
  }
  return {
    channel: selectedChannel,
    async search(query, { file, scanSeconds, onProgress }) {
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(`${query.profession} in ${query.city}`)}?hl=en`, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await gate(page);
      const ui = page.locator('maps-lead-finder');
      await ui.waitFor({ timeout: 15000 });
      if (!await page.locator(selectors.feed).count()) {
        if (await page.locator(selectors.noResults).count()) return { candidates: [], status: 'zero_results', file: null };
        throw problem('layout_changed', 'Maps did not show a usable results list for this query.');
      }
      await ui.locator('#profession').fill(query.profession); await ui.locator('#city').fill(query.city);
      await ui.locator('#code').fill('+1'); await ui.locator('#filter').check();
      if (!await ui.locator('#filter').isChecked()) throw problem('website_filter', 'The no-website filter did not activate.');
      const bridge = await extensionBridge(page);
      let state;
      try {
        await ui.locator('#start').click();
        const end = Date.now() + scanSeconds * 1000;
        let previous = '', lastGrowth = Date.now(), nextNotice = Date.now();
        while (Date.now() < end) {
          await gate(page); state = await bridge.snapshot();
          const progress = `${state.records.length}|${state.checkedDetails}`;
          if (progress !== previous) { previous = progress; lastGrowth = Date.now(); }
          if (!state.running) break;
          if (Date.now() >= nextNotice) { onProgress?.(`Maps scan: ${state.records.length} listings loaded.`); nextNotice = Date.now() + 15000; }
          if (Date.now() - lastGrowth >= 45000) { await bridge.stop(); break; }
          await page.waitForTimeout(800);
        }
        state = await bridge.snapshot();
        if (state.running) await bridge.stop();
        await ui.locator('#stop').waitFor({ state: 'hidden', timeout: 10000 });
        state = await bridge.snapshot();
        if (!state.options?.onlyWithoutWebsite) throw problem('website_filter', 'The extension run did not retain the no-website filter.');
        if (!await ui.locator('#download').isVisible()) return { candidates: [], status: await ui.locator('.status').innerText(), file: null };
        const pending = page.waitForEvent('download', { timeout: 12000 });
        await ui.locator('#download').click();
        const download = await pending; await download.saveAs(file);
        const rows = parseExport(await readFile(file, 'utf8'));
        const candidates = rows.map(row => {
          const matching = state.records.filter(record => !record.website && !record.websiteAmbiguous && normalizedName(record.name) === normalizedName(row['business name']) && phoneDigits(record.phone) === phoneDigits(row['phone number']));
          return matching.length === 1 ? { ...matching[0], profession: query.profession, searchArea: query.city } : null;
        }).filter(Boolean);
        return { candidates, file, rawRows: rows.length, status: await ui.locator('.status').innerText(), warning: await ui.locator('.warning').innerText() };
      } finally { await bridge.close(); }
    },
    async verify(candidate) {
      const url = new URL(candidate.link);
      if (url.protocol !== 'https:' || url.hostname !== 'www.google.com' || !url.pathname.startsWith('/maps/place/')) throw problem('profile_mismatch', 'The candidate has no exact Google Maps place URL.');
      await detailPage.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await gate(detailPage);
      await detailPage.locator(selectors.detailPhone).first().waitFor({ timeout: 10000 });
      await detailPage.waitForTimeout(1500);
      const details = await detailPage.evaluate(({ selectors }) => {
        const headings = [...document.querySelectorAll(selectors.detailHeading)].filter(node => node.getClientRects().length);
        const heading = headings.find(node => !node.closest(selectors.card));
        const main = heading?.closest(selectors.main);
        if (!main) return null;
        const phone = main.querySelector(selectors.detailPhone), address = main.querySelector(selectors.detailAddress), category = main.querySelector(selectors.detailCategory);
        return { businessName: heading.textContent.trim(), rawPhone: phone?.getAttribute('data-item-id')?.replace(/^phone:tel:/, '') || phone?.getAttribute('href')?.replace(/^tel:/, '') || '',
          address: address?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '') || address?.textContent.trim() || '',
          category: category?.textContent.trim() || '', websiteListed: Boolean(main.querySelector(selectors.websiteAction)),
          permanentlyClosed: /Permanently closed/i.test(main.innerText), mapsUrl: location.href };
      }, { selectors });
      if (!details || normalizedName(details.businessName) !== normalizedName(candidate.name) || phoneDigits(details.rawPhone) !== phoneDigits(candidate.phone)) throw problem('profile_mismatch', 'The Maps profile name or phone did not match the exported business.');
      if (details.websiteListed) throw problem('website_listed', 'The individual Maps profile has a website.');
      if (details.permanentlyClosed) throw problem('closed', 'The business is permanently closed.');
      const { parsePhoneNumberFromString } = await import('libphonenumber-js');
      const phone = parsePhoneNumberFromString(details.rawPhone, 'US');
      if (!phone?.isValid() || phone.country !== 'US') throw problem('non_us_phone', 'A valid United States phone was not confirmed.');
      const city = details.address.match(/,\s*([^,]+),\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?(?:,\s*United States)?\s*$/i);
      return { businessName: details.businessName, phone: phone.formatInternational(), category: details.category || candidate.category,
        location: city ? `${city[1].trim()}, ${city[2].toUpperCase()}, USA` : `Search area: ${candidate.searchArea}`,
        address: details.address, profession: candidate.profession, mapsUrl: details.mapsUrl, websiteStatus: 'No website listed on Google Maps' };
    },
    async close() { signal?.removeEventListener('abort', closeOnAbort); await closeContext(); }
  };
}

export async function collectMaps({ store, baseline = [], root, directory, target = 100, maxSearches = 12, maxMinutes = 45,
  scanSeconds = 180, maxProfiles = 300, queries = DEFAULT_QUERIES, signal, onProgress = () => {}, browserFactory = createMapsBrowser, channel = 'msedge' }) {
  for (const [value, upper] of [[target, 100], [maxSearches, 24], [maxMinutes, 60], [scanSeconds, 600], [maxProfiles, 500]]) if (!Number.isInteger(value) || value < 1 || value > upper) throw problem('config', 'Maps limits must be positive integers within their documented caps.');
  if (!Array.isArray(queries) || !queries.length || queries.length > 256 || queries.some(query => !query.profession?.trim() || !query.city?.trim() || !/\b(?:USA|United States)\b/i.test(query.city) || /[\r\n\u0000-\u001f]/.test(query.profession + query.city))) throw problem('config', 'Provide a finite United States profession/city search plan.');
  const state = store.state;
  if (!state.maps) state.maps = { version: 1, seenKeys: [], searches: [], runs: {} };
  if (state.maps.version !== 1 || !Array.isArray(state.maps.seenKeys) || !Array.isArray(state.maps.searches) || !state.maps.runs) throw problem('history_invalid', 'Maps history is invalid; restore it before collecting new leads.');
  const seen = new Set([...state.maps.seenKeys, ...baseline.flatMap(leadKeys), ...state.sends.flatMap(send => send.keys)]);
  let run = state.maps.activeRun && state.maps.runs[state.maps.activeRun];
  if (!run || run.status !== 'collecting') {
    const id = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date())}_${randomUUID().slice(0, 8)}`;
    run = { id, status: 'collecting', startedAt: new Date().toISOString(), leads: [], attempts: [], profilesChecked: 0 };
    state.maps.activeRun = id; state.maps.runs[id] = run;
  }
  for (const lead of run.leads) leadKeys(lead).forEach(key => seen.add(key));
  state.maps.seenKeys = [...seen]; await store.save();
  const rawDirectory = join(root, 'csv_exports', 'raw', run.id);
  await mkdir(rawDirectory, { recursive: true });
  const deadline = Date.parse(run.startedAt) + maxMinutes * 60000;
  const attemptedQueries = new Set(state.maps.searches.map(search => search.key));
  let browser, fatal, abandonedStartup = false;
  const browserAbort = new AbortController();
  const browserSignal = signal ? AbortSignal.any([signal, browserAbort.signal]) : browserAbort.signal;
  const stopCode = (betweenSearches = true) => signal?.aborted ? 'cancelled' : Date.now() >= deadline ? 'time_limit' : run.leads.length >= target ? 'target_reached'
    : betweenSearches && run.attempts.length >= maxSearches ? 'search_limit' : run.profilesChecked >= maxProfiles ? 'profile_limit' : null;
  try {
    if (!stopCode()) {
      const startup = Promise.resolve(browserFactory({ root, directory, signal: browserSignal, channel })).then(async created => {
        // A launch can resolve after its deadline. Close that late browser as
        // well; it must never outlive an already stopped collection.
        if (abandonedStartup) {
          await created.close().catch(() => {});
          throw problem('cancelled', 'Browser startup finished after the run stopped.');
        }
        return created;
      });
      browser = await bounded(startup, Math.min(100000, Math.max(1, deadline - Date.now())), signal, 'Isolated browser startup');
    }
    for (const query of queries) {
      if (stopCode()) break;
      const key = searchKey(query);
      if (attemptedQueries.has(key)) continue;
      const attempt = { key, ...query, status: 'started', startedAt: new Date().toISOString(), accepted: 0 };
      state.maps.searches.push(attempt); run.attempts.push(attempt); attemptedQueries.add(key); await store.save();
      onProgress(`Maps search ${run.attempts.length}/${maxSearches}: ${query.profession} in ${query.city}. ${run.leads.length}/${target} new leads.`);
      try {
        const file = join(rawDirectory, `${String(run.attempts.length).padStart(2, '0')}.csv`);
        const result = await bounded(browser.search(query, { file, scanSeconds, onProgress }), Math.min((scanSeconds + 70) * 1000, Math.max(1, deadline - Date.now())), signal, 'Maps search');
        attempt.rawFile = result.file; attempt.rawRows = result.rawRows || 0; attempt.scanStatus = result.status; attempt.warning = result.warning || '';
        for (const candidate of result.candidates) {
          if (stopCode(false)) break;
          const preliminary = { businessName: candidate.name, phone: candidate.phone, location: query.city, mapsUrl: candidate.link };
          if (!/^1[2-9]\d{2}[2-9]\d{6}$/.test(phoneDigits(candidate.phone))) continue;
          if (leadKeys(preliminary).some(value => seen.has(value))) continue;
          run.profilesChecked++; await store.save();
          try {
            const lead = await bounded(browser.verify(candidate), Math.min(40000, Math.max(1, deadline - Date.now())), signal, 'Individual business verification');
            if (lead.websiteStatus !== 'No website listed on Google Maps' || !/^1[2-9]\d{2}[2-9]\d{6}$/.test(phoneDigits(lead.phone)) || !/\b(?:USA|United States)\b/i.test(lead.location)) throw problem('unconfirmed', 'The verified lead lacks required US or no-website evidence.');
            if (!lead.category || !/contractor|remodel|landscap|floor|fence|deck|roof|concrete|construction|builder|masonry|kitchen|bathroom/i.test(lead.category)) throw problem('category', 'The business is outside the selected website-service niches.');
            const keys = leadKeys(lead);
            if (keys.some(value => seen.has(value))) continue;
            lead.id = leadId(lead); lead.checkedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
            lead.sourceCsv = result.file; run.leads.push(lead); keys.forEach(value => seen.add(value));
            state.maps.seenKeys = [...seen]; attempt.accepted++; await store.save();
            onProgress(`Verified ${run.leads.length}/${target} new US leads: ${lead.businessName}`);
          } catch (error) {
            if (['captcha', 'consent', 'browser_unavailable', 'cancelled', 'timeout'].includes(error.code) || /has been closed/i.test(error.message)) throw error;
            attempt.rejected ||= {}; attempt.rejected[error.code || 'verification_failed'] = (attempt.rejected[error.code || 'verification_failed'] || 0) + 1;
          }
        }
        attempt.status = 'completed';
      } catch (error) {
        attempt.status = 'interrupted'; attempt.errorCode = error.code || 'search_failed';
        if (['captcha', 'consent', 'extension_missing', 'website_filter', 'export_changed', 'cancelled', 'timeout'].includes(error.code) || /has been closed/i.test(error.message)) { fatal = error; break; }
        onProgress(`Search stopped (${attempt.errorCode}); moving to the next finite query.`);
      } finally { attempt.finishedAt = new Date().toISOString(); await store.save(); }
    }
  } catch (error) { fatal = error; }
  finally {
    abandonedStartup = !browser;
    if (browser) await browser.close().catch(error => { fatal ||= error; });
    browserAbort.abort();
  }
  run.status = fatal ? 'blocked' : 'completed'; run.stopReason = fatal?.code || stopCode() || 'search_plan_exhausted'; run.finishedAt = new Date().toISOString();
  run.file = join(root, 'csv_exports', 'processed', `usa_${run.id}_no_website.csv`);
  await writeLeadCsv(run.file, run.leads); await store.save();
  await writeJson(join(directory, 'maps-last-run.json'), { ...run, browser: browser?.channel || null });
  const result = { leads: run.leads, file: run.file, runId: run.id, stopReason: run.stopReason, searches: run.attempts.length, profilesChecked: run.profilesChecked };
  if (fatal) { fatal.partialResult = result; throw fatal; }
  return result;
}

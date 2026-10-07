import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startSetup } from '../lib/setup.mjs';
import { writeJson } from '../lib/store.mjs';

const artifactRoot = fileURLToPath(new URL('../../artifacts/automation-tests/', import.meta.url));
const fixtureAddress = '123 Fixture Street, Fixture City, Bangladesh';
const fixtureId = 'fixture-snov-client';
const fixtureSecret = 'fixture-snov-secret';
let browser;
let skipReason;
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  skipReason = 'Install the optional Playwright development dependency to run setup browser regressions.';
}

before(async () => {
  if (skipReason) return;
  await mkdir(artifactRoot, { recursive: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
});
after(async () => { await browser?.close(); });

async function fixture(t, { timeoutMs = 10_000 } = {}) {
  const directory = await mkdtemp(join(artifactRoot, 'setup-browser-'));
  const configFile = join(directory, 'config.json');
  const config = { sender: {
    name: 'Afif', email: 'craftedwebstudio@gmail.com', postalAddress: '',
    instagram: 'https://www.instagram.com/whitewo_lf404/'
  } };
  await writeJson(configFile, config);
  const controller = new AbortController();
  let announceUrl;
  const ready = new Promise(resolve => { announceUrl = resolve; });
  const stopped = startSetup({ directory, configFile, config, signal: controller.signal, onUrl: announceUrl, timeoutMs });
  const context = await browser.newContext();
  const page = await context.newPage();
  t.after(async () => {
    controller.abort();
    await stopped;
    await context.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = await ready;
  await page.goto(url);
  await page.locator('#postal').fill(fixtureAddress);
  await page.locator('#clientId').fill(fixtureId);
  await page.locator('#clientSecret').fill(fixtureSecret);
  return { page, directory, configFile, config, stopped, url, controller };
}

async function submit(page) {
  await page.getByRole('button', { name: 'Save local settings' }).click();
  await page.waitForFunction(() => {
    const status = document.getElementById('result').textContent;
    return status.length > 0 && status !== 'Saving…';
  });
  return page.locator('#result').textContent();
}

test('setup browser saves postal address and Snov credentials with optional Google upload empty', async t => {
  if (skipReason) { t.skip(skipReason); return; }
  const { page, directory, configFile, stopped } = await fixture(t);
  assert.equal(await page.locator('#google').evaluate(input => input.files.length), 0);
  assert.match(await submit(page), /Saved locally.*No emails were sent/s);
  assert.equal(await stopped, 'saved');
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).sender.postalAddress, fixtureAddress);
  const credentials = JSON.parse(await readFile(join(directory, 'snov-credentials.json'), 'utf8'));
  assert.equal(credentials.clientId, fixtureId);
  assert.equal(credentials.clientSecret, fixtureSecret);
  assert.equal(await page.locator('#clientId').inputValue(), '');
  assert.equal(await page.locator('#clientSecret').inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Save local settings' }).isDisabled(), true);
  await assert.rejects(readFile(join(directory, 'google-desktop-client.json')), { code: 'ENOENT' });
});

test('setup browser explains expired listener and keeps entries for retry', async t => {
  if (skipReason) { t.skip(skipReason); return; }
  const { page, directory, configFile, config, stopped } = await fixture(t, { timeoutMs: 3000 });
  assert.equal(await stopped, 'timeout');
  const message = await submit(page);
  assert.match(message, /expired|reachable/i);
  assert.doesNotMatch(message, /Check the JSON file/i);
  assert.equal(await page.locator('#postal').inputValue(), fixtureAddress);
  assert.equal(await page.locator('#clientId').inputValue(), fixtureId);
  assert.equal(await page.locator('#clientSecret').inputValue(), fixtureSecret);
  assert.equal(await page.getByRole('button', { name: 'Save local settings' }).isDisabled(), false);
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), config);
  await assert.rejects(readFile(join(directory, 'snov-credentials.json')), { code: 'ENOENT' });
});

test('setup browser explains malformed Google JSON before any POST or settings write', async t => {
  if (skipReason) { t.skip(skipReason); return; }
  const { page, directory, configFile, config } = await fixture(t);
  const posts = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.locator('#google').setInputFiles({
    name: 'invalid-google-client.json', mimeType: 'application/json', buffer: Buffer.from('{invalid-json')
  });
  assert.match(await submit(page), /Google.*valid JSON/i);
  assert.deepEqual(posts, []);
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), config);
  assert.equal(await page.locator('#clientSecret').inputValue(), fixtureSecret);
  assert.equal(await page.getByRole('button', { name: 'Save local settings' }).isDisabled(), false);
  await assert.rejects(readFile(join(directory, 'snov-credentials.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'google-desktop-client.json')), { code: 'ENOENT' });
});

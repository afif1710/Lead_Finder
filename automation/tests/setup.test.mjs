import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startSetup } from '../lib/setup.mjs';
import { writeJson } from '../lib/store.mjs';
const artifactRoot = fileURLToPath(new URL('../../artifacts/automation-tests/', import.meta.url));
await mkdir(artifactRoot, { recursive: true });
const tmpdir = () => artifactRoot;

test('setup is local, rejects forged posts, saves secret locally and never sends', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = join(directory, 'config.json');
  const config = { sender: { name: 'Afif', email: 'craftedwebstudio@gmail.com', postalAddress: '', instagram: 'https://www.instagram.com/whitewo_lf404/' }, snovCredentialsFile: 'snov-credentials.json' };
  await writeJson(configFile, config);
  let resolveUrl; const ready = new Promise(resolve => { resolveUrl = resolve; });
  const stopped = startSetup({ directory, configFile, config, onUrl: resolveUrl, timeoutMs: 5000 });
  const url = new URL(await ready); const origin = url.origin;
  const html = await fetch(url).then(r => r.text()); assert.match(html, /craftedwebstudio@gmail.com/);
  assert.equal((await fetch(origin)).status, 403);
  assert.equal((await fetch(`${origin}/save`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(`${origin}/save`, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json', 'X-Setup-Token': url.searchParams.get('token') }, body: '{}' })).status, 403);
  const response = await fetch(`${origin}/save`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Setup-Token': url.searchParams.get('token') }, body: JSON.stringify({ postalAddress: '123 Test Street, Test City, Bangladesh', clientId: 'test-client', clientSecret: 'test-secret' }) });
  assert.equal(response.status, 200); assert.match((await response.json()).message, /No emails were sent/);
  assert.equal(await stopped, 'saved');
  assert.equal(JSON.parse(await readFile(join(directory, 'snov-credentials.json'), 'utf8')).clientSecret, 'test-secret');
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).sender.postalAddress, '123 Test Street, Test City, Bangladesh');
});

test('setup exits on timeout without mutating settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-setup-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = join(directory, 'config.json'); const config = { fixture: true };
  await writeJson(configFile, config);
  assert.equal(await startSetup({ directory, configFile, config, onUrl: () => {}, timeoutMs: 50 }), 'timeout');
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), config);
});

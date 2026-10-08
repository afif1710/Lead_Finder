import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSnovProvider } from '../lib/snov.mjs';
import { openStore } from '../lib/store.mjs';
import { discover, eligibleContacts } from '../lib/workflow.mjs';

const artifactRoot = fileURLToPath(new URL('../../artifacts/snov-checkpoint-tests/', import.meta.url));
const lead = { id: 'checkpoint-lead', businessName: 'Checkpoint Fence LLC', phone: '+1 512 555 0100',
  address: '123 Main St, Austin, TX 78701, United States', location: 'Austin, TX, USA', category: 'Fence contractor',
  mapsUrl: 'https://www.google.com/maps/place/fixture/data=!1scheckpoint-fixture' };
const foundEmail = 'owner@checkpoint.test';

async function fixture(t) {
  await mkdir(artifactRoot, { recursive: true });
  const directory = await mkdtemp(join(artifactRoot, 'run-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialsFile = join(directory, 'fixture-credentials.json');
  await writeFile(credentialsFile, JSON.stringify({ clientId: 'fixture-id', clientSecret: 'fixture-secret' }));
  return { directory, credentialsFile, store: await openStore(directory), leads: [lead] };
}

test('database contacts survive a hard process crash and restart never repeats a paid reveal', { timeout: 30_000 }, async t => {
  const data = await fixture(t);
  const script = join(data.directory, 'fixture-worker.mjs');
  const moduleURL = name => new URL(`../lib/${name}.mjs`, import.meta.url).href;
  await writeFile(script, `
    import { readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { createSnovProvider } from ${JSON.stringify(moduleURL('snov'))};
    import { openStore } from ${JSON.stringify(moduleURL('store'))};
    import { discover } from ${JSON.stringify(moduleURL('workflow'))};
    const directory = process.argv[2], credentialsFile = process.argv[3];
    const lead = ${JSON.stringify(lead)};
    let reveals = 0;
    const fetchImpl = async (url, init) => {
      const path = new URL(url).pathname;
      let body;
      if (path === '/v1/oauth/access_token') body = { access_token: 'fixture-token', expires_in: 3600 };
      else if (path === '/v1/get-balance') body = { data: { balance: 50 } };
      else if (path === '/v2/database-search/prospects/start') body = { meta: { task_hash: 'fixturesearch123' } };
      else if (path === '/v2/database-search/prospects/result/fixturesearch123') body = {
        status: 'completed', data: { total: 2, page: 1, total_pages: 1, prospects: [1, 2].map(index => ({
          job_title: 'Owner', company: { name: lead.businessName, domain: 'checkpoint.test', location: 'Austin, Texas, United States' },
          email_and_hidden_info_reveal: 'https://api.snov.io/v2/database-search/prospects/search-emails/start/fixtureprospect' + index,
        })) },
      };
      else if (path.includes('/search-emails/start/')) {
        reveals++;
        if (reveals === 2) {
          const saved = JSON.parse(await readFile(join(directory, 'history.json'), 'utf8'));
          process.send({ type: 'second-reveal', savedCount: saved.discovery[lead.id].emails.length, reveals });
          return new Promise(() => {});
        }
        body = { meta: { task_hash: 'fixturereveal123' } };
      } else if (path === '/v2/database-search/prospects/search-emails/result/fixturereveal123') body = {
        status: 'completed', data: { emails: [{ email: ${JSON.stringify(foundEmail)}, smtp_status: 'unknown' }] },
      };
      else throw new Error('Unexpected fixture route');
      return Response.json(body);
    };
    const store = await openStore(directory);
    const provider = await createSnovProvider({ credentialsFile, fetchImpl });
    await discover({ leads: [lead], store, directory, provider: { stats: provider.stats,
      findEmails: (value, options) => provider.findDatabaseEmails(value, options) } });
    throw new Error('The fixture must be killed before discovery completes');
  `);
  const worker = spawn(process.execPath, [script, data.directory, data.credentialsFile], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const exited = once(worker, 'exit');
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); });
  const ready = await Promise.race([
    once(worker, 'message').then(([message]) => message),
    exited.then(() => { throw new Error('Fixture exited before the durable checkpoint'); }),
  ]);
  assert.deepEqual(ready, { type: 'second-reveal', savedCount: 1, reveals: 2 });
  worker.kill('SIGKILL');
  await exited;

  const reopened = await openStore(data.directory);
  const saved = reopened.state.discovery[lead.id];
  assert.equal(saved.status, 'in_progress');
  assert.equal(saved.company.domain, 'checkpoint.test');
  assert.equal(saved.evidence.cityExact, true);
  assert.equal(saved.emails[0].email, foundEmail);
  assert.equal(saved.emails[0].status, 'unknown');
  assert.equal(saved.checkpoint.phase, 'reveal_reserved');
  assert.equal('partialResult' in saved.checkpoint, false);
  assert.equal(reopened.state.contacts[lead.id].emails[0].email, foundEmail);
  const output = JSON.parse(await readFile(join(data.directory, 'collected-emails.json'), 'utf8'));
  assert.equal(output[0].result.emails[0].email, foundEmail);
  let repeated = 0;
  const summary = await discover({ ...data, store: reopened, provider: { stats: {},
    findEmails: async () => { repeated++; assert.fail('Interrupted paid reveals must not repeat'); },
    findDatabaseEmails: async () => { repeated++; assert.fail('Interrupted database lookup must not repeat'); } } });
  assert.equal(repeated, 0);
  assert.equal(summary.interrupted, 1);
  assert.equal(summary.ready, 0);
  assert.equal(eligibleContacts(data.leads, reopened.state, { testEmail: foundEmail }).length, 0);
});

test('domain contacts are durable before verification and remain blocked after an interrupted task', { timeout: 25_000 }, async t => {
  const data = await fixture(t);
  let verificationStarts = 0;
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    let body;
    if (path === '/v1/oauth/access_token') body = { access_token: 'fixture-token', expires_in: 3600 };
    else if (path === '/v1/get-balance') body = { data: { balance: 50 } };
    else if (path === '/v2/company-domain-by-name/start') body = { data: { task_hash: 'fixturename123' } };
    else if (path === '/v2/company-domain-by-name/result') body = { status: 'completed', data: [{ name: lead.businessName, result: { domain: 'checkpoint.test' } }] };
    else if (path === '/v2/domain-search/start') body = { meta: { task_hash: 'fixturecompany123' } };
    else if (path === '/v2/domain-search/result/fixturecompany123') body = { status: 'completed', data: { company_name: lead.businessName, city: 'Austin', hq_phone: '15125550100', website: 'checkpoint.test' } };
    else if (path === '/v2/domain-search/generic-contacts/start') body = { meta: { task_hash: 'fixturecontacts123' } };
    else if (path === '/v2/domain-search/generic-contacts/result/fixturecontacts123') body = { status: 'completed', data: [{ email: foundEmail }] };
    else if (path === '/v2/email-verification/start') {
      verificationStarts++;
      const saved = JSON.parse(await readFile(join(data.directory, 'history.json'), 'utf8')).discovery[lead.id];
      assert.equal(saved.status, 'in_progress');
      assert.equal(saved.emails[0].email, foundEmail);
      assert.equal(saved.emails[0].verificationReason, 'not_checked');
      assert.equal(saved.evidence.phoneExact, true);
      assert.equal(saved.checkpoint.phase, 'verification_reserved');
      throw new Error('Fixture interrupted verification');
    } else assert.fail('Unexpected fixture route');
    return Response.json(body);
  };
  const provider = await createSnovProvider({ credentialsFile: data.credentialsFile, fetchImpl });
  await assert.rejects(discover({ ...data, provider }), { code: 'api_error' });
  const reopened = await openStore(data.directory);
  assert.equal(verificationStarts, 1);
  assert.equal(reopened.state.discovery[lead.id].status, 'interrupted');
  assert.equal(reopened.state.discovery[lead.id].emails[0].email, foundEmail);
  assert.equal(reopened.state.discovery[lead.id].emails[0].status, 'unknown');
  await discover({ ...data, store: reopened, provider: { stats: {}, findEmails: async () => assert.fail('Paid verification cannot repeat') } });
  assert.equal(eligibleContacts(data.leads, reopened.state).length, 0);
});

test('unclassified provider failure keeps the last saved contact snapshot and does not mutate it', async t => {
  const data = await fixture(t);
  const provider = { stats: {}, findEmails: async (_lead, { onCheckpoint }) => {
    const partialResult = { status: 'matched', company: { domain: 'checkpoint.test' }, evidence: { phoneExact: true },
      searchedRoutes: ['domain'], emails: [{ email: foundEmail, source: 'Snov.io', status: 'unknown' }] };
    await onCheckpoint({ operation: 'domain_search', phase: 'contacts_found', foundEmails: 1, partialResult });
    partialResult.emails[0].email = 'mutated@checkpoint.test';
    assert.equal(data.store.state.discovery[lead.id].emails[0].email, foundEmail);
    throw new Error('Fixture stopped without attaching a partial result');
  } };
  await assert.rejects(discover({ ...data, provider }), /Fixture stopped/);
  const reopened = await openStore(data.directory);
  assert.equal(reopened.state.discovery[lead.id].status, 'interrupted');
  assert.equal(reopened.state.discovery[lead.id].emails[0].email, foundEmail);
  assert.equal(reopened.state.discovery[lead.id].emails[0].status, 'unknown');
  assert.equal(reopened.state.contacts[lead.id].emails[0].email, foundEmail);
  assert.equal(eligibleContacts(data.leads, reopened.state).length, 0);
});

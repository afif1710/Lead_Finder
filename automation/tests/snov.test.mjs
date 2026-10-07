import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnovProvider } from '../lib/snov.mjs';

const artifactRoot = fileURLToPath(new URL('../../artifacts/', import.meta.url));
const lead = { id: 'lead1', businessName: 'Example Fence LLC', phone: '+1 512 555 0100', location: 'Austin, TX, USA', address: '123 Main St, Austin, TX 78701, United States', category: 'Fence contractor' };
const hashes = { name: 'nametask123', company: 'companytask123', contacts: 'contactstask123', domain: 'domaintask123', verification: 'verificationtask123' };

async function fixture(t, options = {}) {
  await mkdir(artifactRoot, { recursive: true });
  const directory = await mkdtemp(join(artifactRoot, 'snov-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialsFile = join(directory, 'credentials.json');
  await writeFile(credentialsFile, JSON.stringify({ client_id: 'secret-client-id', client_secret: 'secret-client-value' }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.snov.io');
    assert.equal(init.redirect, 'error');
    const fields = new URLSearchParams(init.body);
    const path = parsed.pathname;
    const changed = options.change?.({ url, parsed, path, init, fields, calls });
    if (changed !== undefined) return changed;
    let body;
    if (path === '/v1/oauth/access_token') {
      assert.equal(fields.get('grant_type'), 'client_credentials');
      body = { access_token: 'secret-access-token', expires_in: 3600 };
    } else {
      assert.equal(init.headers.Authorization, 'Bearer secret-access-token');
      if (path === '/v1/get-balance') body = { success: true, data: { balance: String(options.balance ?? 50) } };
      else if (path === '/v2/company-domain-by-name/start') {
        assert.deepEqual(fields.getAll('names[]'), [lead.businessName]);
        body = { data: { task_hash: hashes.name } };
      } else if (path === '/v2/company-domain-by-name/result') {
        assert.equal(parsed.searchParams.get('task_hash'), hashes.name);
        body = { status: 'completed', data: [{ name: lead.businessName, result: { domain: 'examplefence.test' } }] };
      } else if (path === '/v2/domain-search/start') body = { meta: { task_hash: hashes.company }, links: { result: `https://api.snov.io/v2/domain-search/result/${hashes.company}` } };
      else if (path === `/v2/domain-search/result/${hashes.company}`) body = {
        status: 'completed', data: { company_name: options.companyName ?? lead.businessName, city: options.companyCity ?? 'Austin', hq_phone: options.companyPhone ?? '15125550100', website: 'examplefence.test', country: options.companyCountry, state: options.companyState },
      };
      else if (path === '/v2/domain-search/generic-contacts/start') body = { meta: { task_hash: hashes.contacts } };
      else if (path === `/v2/domain-search/generic-contacts/result/${hashes.contacts}`) body = { status: 'completed', data: (options.emails ?? ['hello@examplefence.test']).map(email => ({ email })) };
      else if (path === '/v2/domain-search/domain-emails/start') body = { meta: { task_hash: hashes.domain } };
      else if (path === `/v2/domain-search/domain-emails/result/${hashes.domain}`) body = { status: 'completed', data: (options.domainEmails ?? []).map(email => ({ email })) };
      else if (path === '/v2/email-verification/start') {
        assert.ok(fields.getAll('emails[]').length <= 10);
        body = { data: { task_hash: hashes.verification } };
      } else if (path === '/v2/email-verification/result') body = {
        status: 'completed', data: (options.verifiedEmails ?? (options.emails ?? ['hello@examplefence.test'])).map(email => ({ email, result: { smtp_status: options.verificationStatus ?? 'valid', unknown_status_reason: options.verificationStatus === 'unknown' ? 'catchall' : undefined } })),
      };
      else assert.fail(`Unexpected API path: ${path}`);
    }
    return Response.json(body);
  };
  return { credentialsFile, fetchImpl, calls };
}

test('Snov public API provider', { concurrency: true }, async t => {
  await Promise.all([
    t.test('matches exact name and US phone, verifies emails, records the domain', async t => {
      const f = await fixture(t, { companyCity: 'Different City' });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'matched');
      assert.equal(result.evidence.phoneExact, true);
      assert.equal(result.evidence.cityExact, false);
      assert.equal(result.emails[0].status, 'valid');
      assert.equal(result.evidence.observedWebsite, 'examplefence.test');
      assert.equal(result.evidence.websiteFunctionality, 'not_checked');
      assert.equal(provider.stats.creditsReserved, 4);
      assert.equal(provider.stats.requests, 10);
    }),
    t.test('does not spend email credits on ambiguous or different companies', async t => {
      const f = await fixture(t, { companyName: 'Example Fence LLC Northern' });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'needs_review');
      assert.deepEqual(result.emails, []);
      assert.equal(f.calls.some(call => call.url.includes('generic-contacts')), false);
      assert.equal(provider.stats.creditsReserved, 2);
    }),
    t.test('search area alone cannot establish business-city identity', async t => {
      const f = await fixture(t, { companyPhone: '15125550999' });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails({ ...lead, address: '', location: 'Search area: Austin, Texas, USA' });
      assert.equal(result.status, 'needs_review');
      assert.equal(result.evidence.reliableUSCity, false);
      assert.deepEqual(result.emails, []);
    }),
    t.test('exact city and state with explicit US country can match without a headquarters phone', async t => {
      const f = await fixture(t, { companyPhone: '', companyCountry: 'United States', companyState: 'Texas' });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails({ ...lead, address: '' });
      assert.equal(result.status, 'matched');
      assert.equal(result.evidence.cityExact, true);
      assert.equal(result.evidence.phoneExact, false);
      assert.equal(result.evidence.stateExact, true);
    }),
    t.test('unknown verification stays unknown and does not spend verification credit', async t => {
      const f = await fixture(t, { verificationStatus: 'unknown' });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.emails[0].status, 'unknown');
      assert.equal(provider.stats.creditsReserved, 3);
    }),
    t.test('domain email fallback only uses returned emails and verifies them', async t => {
      const email = 'owner@examplefence.test';
      const f = await fixture(t, { emails: [], domainEmails: [email], verifiedEmails: [email] });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.deepEqual(result.emails.map(row => row.email), [email]);
      assert.equal(result.emails[0].status, 'valid');
      assert.equal(provider.stats.creditsReserved, 4);
    }),
    t.test('rejects foreign result URLs before any bearer token can be sent there', async t => {
      const f = await fixture(t, { change: ({ path }) => path === '/v2/domain-search/start' ? Response.json({ meta: { task_hash: hashes.company }, links: { result: 'https://attacker.test/result' } }) : undefined });
      const provider = await createSnovProvider(f);
      await assert.rejects(provider.findEmails(lead), { code: 'api_error' });
      assert.ok(f.calls.every(call => new URL(call.url).hostname === 'api.snov.io'));
    }),
    t.test('preserves found emails at the credit budget and stops before verification', async t => {
      const f = await fixture(t, { balance: 3 });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'matched');
      assert.equal(result.emails[0].status, 'unknown');
      assert.equal(result.emails[0].verificationReason, 'not_checked');
      assert.equal(provider.stats.stoppedCode, 'budget');
      assert.equal(f.calls.some(call => call.url.includes('email-verification')), false);
      const count = f.calls.length;
      await assert.rejects(provider.findEmails(lead), { code: 'budget' });
      assert.equal(f.calls.length, count);
    }),
    t.test('no-result name search releases its reservation and returns no emails', async t => {
      const f = await fixture(t, { change: ({ path }) => path === '/v2/company-domain-by-name/result' ? Response.json({ status: 'completed', data: [] }) : undefined });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'no_email');
      assert.equal(provider.stats.creditsReserved, 0);
    }),
    t.test('authentication errors redact response bodies and credentials', async t => {
      const f = await fixture(t, { change: () => new Response('secret-client-id secret-client-value secret-access-token', { status: 403 }) });
      await assert.rejects(createSnovProvider(f), problem => {
        assert.equal(problem.code, 'auth');
        assert.equal(/secret-client|secret-access/.test(problem.message), false);
        return true;
      });
      assert.equal(f.calls.length, 1);
    }),
    t.test('rate limit fails once without retrying a paid POST', async t => {
      const f = await fixture(t, { change: ({ path }) => path === '/v2/company-domain-by-name/start' ? new Response('rate limited', { status: 429 }) : undefined });
      const provider = await createSnovProvider(f);
      await assert.rejects(provider.findEmails(lead), { code: 'rate_limit' });
      assert.equal(f.calls.filter(call => call.url.includes('company-domain-by-name/start')).length, 1);
    }),
    t.test('deadline bounds a fetch implementation that ignores abort signals', async t => {
      const f = await fixture(t, { change: () => new Promise(() => {}) });
      const started = Date.now();
      await assert.rejects(createSnovProvider({ ...f, deadlineMs: 30 }), { code: 'timeout' });
      assert.ok(Date.now() - started < 1500);
    }),
    t.test('request budget fails before a paid name search', async t => {
      const f = await fixture(t);
      const provider = await createSnovProvider({ ...f, maxRequests: 2 });
      await assert.rejects(provider.findEmails(lead), { code: 'budget' });
      assert.equal(f.calls.length, 2);
    }),
    t.test('polling stops after six pending responses', async t => {
      const f = await fixture(t, { change: ({ path }) => path === '/v2/company-domain-by-name/result' ? Response.json({ status: 'in_progress', data: [] }) : undefined });
      const provider = await createSnovProvider(f);
      await assert.rejects(provider.findEmails(lead), { code: 'timeout' });
      assert.equal(f.calls.filter(call => new URL(call.url).pathname === '/v2/company-domain-by-name/result').length, 6);
      assert.equal(f.calls.filter(call => call.url.includes('company-domain-by-name/start')).length, 1);
    }),
    t.test('provider quota response stops all subsequent searches', async t => {
      const f = await fixture(t, { change: ({ path }) => path === '/v2/company-domain-by-name/start' ? Response.json({ status: 'not_enough_credits' }) : undefined });
      const provider = await createSnovProvider(f);
      await assert.rejects(provider.findEmails(lead), { code: 'quota' });
      const count = f.calls.length;
      await assert.rejects(provider.findEmails(lead), { code: 'quota' });
      assert.equal(f.calls.length, count);
    }),
    t.test('missing verification results never become valid', async t => {
      const f = await fixture(t, { verifiedEmails: [] });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.emails[0].status, 'unknown');
      assert.equal(result.emails[0].verificationReason, 'No verification result returned.');
    }),
    t.test('public stats cannot be changed to bypass a budget', async t => {
      const f = await fixture(t, { balance: 2 });
      const provider = await createSnovProvider(f);
      assert.throws(() => { provider.stats.creditLimit = 100; }, TypeError);
      assert.throws(() => { provider.stats.requests = 0; }, TypeError);
      await assert.rejects(provider.findEmails(lead), { code: 'budget' });
      assert.equal(provider.stats.creditLimit, 2);
    }),
    t.test('common city names without US country evidence need review', async t => {
      const f = await fixture(t, { companyPhone: '' });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'needs_review');
      assert.equal(result.evidence.cityExact, true);
      assert.equal(result.evidence.countryUS, false);
      assert.deepEqual(result.emails, []);
    }),
    t.test('company legal suffix variation preserves exact entity-name matching', async t => {
      const f = await fixture(t, { companyName: 'Example Fence, Inc.' });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'matched');
      assert.equal(result.evidence.nameExact, true);
    }),
    t.test('keeps all discovered contacts but verifies only until one valid office address', async t => {
      const contacts = ['person@examplefence.test', 'sales@examplefence.test', 'info@examplefence.test'];
      const f = await fixture(t, { emails: contacts });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.emails.length, 3);
      assert.equal(result.emails[0].email, 'info@examplefence.test');
      assert.equal(result.emails[0].status, 'valid');
      assert.equal(result.emails[1].status, 'unknown');
      assert.equal(result.emails[1].verificationReason, 'not_checked');
      const starts = f.calls.filter(call => call.url.includes('/email-verification/start'));
      assert.equal(starts.length, 1);
      assert.deepEqual(new URLSearchParams(starts[0].init.body).getAll('emails[]'), ['info@examplefence.test']);
      assert.equal(provider.stats.creditsReserved, 4);
    }),
    t.test('an uncertain paid verification preserves the contacts on the classified error', async t => {
      const f = await fixture(t, { change: ({ path }) => {
        if (path === '/v2/email-verification/start') throw new Error('secret-access-token');
        return undefined;
      } });
      const provider = await createSnovProvider(f);
      await assert.rejects(provider.findEmails(lead), problem => {
        assert.equal(problem.code, 'api_error');
        assert.equal(problem.partialResult.status, 'needs_review');
        assert.equal(problem.partialResult.emails[0].email, 'hello@examplefence.test');
        assert.equal(problem.partialResult.emails[0].status, 'unknown');
        assert.equal(problem.message.includes('secret-access-token'), false);
        return true;
      });
      assert.equal(f.calls.filter(call => call.url.includes('/email-verification/start')).length, 1);
    }),
    t.test('same-name and same-city company with a conflicting phone needs review', async t => {
      const f = await fixture(t, { companyPhone: '15125550999', companyCountry: 'USA', companyState: 'TX' });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'needs_review');
      assert.equal(result.evidence.phoneConflict, true);
      assert.deepEqual(result.emails, []);
    }),
    t.test('city-only matches require explicit matching US state', async t => {
      const f = await fixture(t, { companyPhone: '', companyCountry: 'USA', companyState: 'Ohio' });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'needs_review');
      assert.equal(result.evidence.countryUS, true);
      assert.equal(result.evidence.stateExact, false);
    }),
    t.test('retains the first fifty contacts and prioritizes an office inbox after the first ten', async t => {
      const contacts = Array.from({ length: 55 }, (_, index) => `person${index}@examplefence.test`);
      contacts.splice(15, 0, 'info@examplefence.test');
      const f = await fixture(t, { emails: contacts });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.emails.length, 50);
      assert.equal(result.emails[0].email, 'info@examplefence.test');
      assert.equal(result.emails[0].status, 'valid');
      assert.equal(f.calls.filter(call => call.url.includes('/email-verification/start')).length, 1);
    }),
    t.test('verifies at most three candidates while preserving other returned addresses', async t => {
      const contacts = ['one@examplefence.test', 'two@examplefence.test', 'three@examplefence.test', 'four@examplefence.test'];
      const f = await fixture(t, { emails: contacts, verificationStatus: 'not_valid' });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.emails.length, 4);
      assert.deepEqual(result.emails.slice(0, 3).map(candidate => candidate.status), ['not_valid', 'not_valid', 'not_valid']);
      assert.equal(result.emails[3].verificationReason, 'not_checked');
      assert.equal(f.calls.filter(call => call.url.includes('/email-verification/start')).length, 3);
      assert.equal(provider.stats.creditsReserved, 6);
    }),
  ]);
});

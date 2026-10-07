import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnovProvider } from '../lib/snov.mjs';

const artifactRoot = fileURLToPath(new URL('../../artifacts/', import.meta.url));
const lead = { id: 'lead1', businessName: 'Example Fence LLC', phone: '+1 512 555 0100', location: 'Austin, TX, USA', address: '123 Main St, Austin, TX 78701, United States', category: 'Fence contractor' };
const hashes = { name: 'nametask123', company: 'companytask123', contacts: 'contactstask123', domain: 'domaintask123', verification: 'verificationtask123', database: 'databasetask123' };

function databaseProspect(overrides = {}) {
  return { first_name: 'Owner', job_title: 'Founder', company: { name: lead.businessName, domain: 'examplefence.test', location: 'Austin, Texas, United States' }, email_and_hidden_info_reveal: 'https://api.snov.io/v2/database-search/prospects/search-emails/start/prospecttask123', ...overrides };
}

async function fixture(t, options = {}) {
  await mkdir(artifactRoot, { recursive: true });
  const directory = await mkdtemp(join(artifactRoot, 'snov-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialsFile = join(directory, 'credentials.json');
  await writeFile(credentialsFile, JSON.stringify({ client_id: 'secret-client-id', client_secret: 'secret-client-value' }));
  const calls = [];
  let revealCount = 0;
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
      else if (path === '/v2/database-search/prospects/start') {
        assert.equal(init.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(init.body), { page: 1, filters: { company: { name: { include: [lead.businessName] } } } });
        body = { meta: { task_hash: hashes.database }, links: { result: `https://api.snov.io/v2/database-search/prospects/result/${hashes.database}` } };
      }
      else if (path === `/v2/database-search/prospects/result/${hashes.database}`) body = {
        status: 'completed', data: { total: (options.databaseProspects || []).length, page: 1, total_pages: options.databaseProspects?.length ? 1 : 0, prospects: options.databaseProspects || [] },
      };
      else if (/^\/v2\/database-search\/prospects\/search-emails\/start\//.test(path)) {
        revealCount += 1;
        body = { meta: { task_hash: `databaseemailtask${revealCount}` } };
      }
      else if (/^\/v2\/database-search\/prospects\/search-emails\/result\//.test(path)) body = {
        status: 'completed', data: { emails: options.databaseEmailRowsByReveal?.[revealCount - 1] ?? options.databaseEmailRows ?? [{ email: 'owner@examplefence.test', smtp_status: 'valid' }] },
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
      assert.deepEqual(result.searchedRoutes, ['domain', 'database']);
      assert.equal(f.calls.filter(call => call.url.includes('/database-search/prospects/start')).length, 1);
    }),
    t.test('missing domain uses company-name database search and returned location to identify the actual business', async t => {
      const f = await fixture(t, { databaseProspects: [databaseProspect()], change: ({ path }) => path === '/v2/company-domain-by-name/result' ? Response.json({ status: 'completed', data: [] }) : undefined });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'matched');
      assert.deepEqual(result.searchedRoutes, ['domain', 'database']);
      assert.equal(result.evidence.cityExact, true);
      assert.equal(result.evidence.stateExact, true);
      assert.equal(result.evidence.countryUS, true);
      assert.equal(result.evidence.phoneExact, false);
      assert.deepEqual(result.emails.map(row => [row.email, row.status]), [['owner@examplefence.test', 'valid']]);
      assert.equal(provider.stats.creditsReserved, 1);
      assert.equal(f.calls.some(call => call.url.includes('/email-verification/start')), false);
    }),
    t.test('legacy domain-only no-result can run database fallback without repeating a paid name lookup', async t => {
      const checkpoints = [];
      const f = await fixture(t, { databaseProspects: [databaseProspect()] });
      const provider = await createSnovProvider(f);
      const result = await provider.findDatabaseEmails(lead, { onCheckpoint: event => {
        checkpoints.push(event);
        if (event.phase === 'reveal_reserved') assert.equal(f.calls.some(call => call.url.includes('/search-emails/start/')), false);
      } });
      assert.equal(result.status, 'matched');
      assert.deepEqual(result.searchedRoutes, ['database']);
      assert.equal(f.calls.some(call => call.url.includes('/company-domain-by-name/')), false);
      assert.deepEqual(checkpoints.map(row => row.phase), ['started', 'searched', 'reveal_reserved', 'reveal_completed', 'completed']);
      assert.equal(JSON.stringify(checkpoints).includes('secret-'), false);
    }),
    t.test('insufficient domain metadata falls back to reliable database company location', async t => {
      const f = await fixture(t, { companyPhone: '', databaseProspects: [databaseProspect()] });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'matched');
      assert.deepEqual(result.searchedRoutes, ['domain', 'database']);
      assert.equal(result.evidence.databaseLocation, 'Austin, Texas, United States');
      assert.equal(result.evidence.observedWebsite, 'examplefence.test');
      assert.equal(f.calls.some(call => call.url.includes('/generic-contacts/')), false);
    }),
    t.test('confirmed domain identity with no generic/domain emails can reveal a database prospect email', async t => {
      const f = await fixture(t, { emails: [], domainEmails: [], databaseProspects: [databaseProspect()] });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'matched');
      assert.deepEqual(result.searchedRoutes, ['domain', 'database']);
      assert.equal(result.emails[0].status, 'valid');
      assert.equal(provider.stats.creditsReserved, 3);
    }),
    t.test('database prospects for the wrong company are set aside without any paid reveal', async t => {
      const f = await fixture(t, { databaseProspects: [databaseProspect({ company: { name: 'Different Fence', domain: 'different.test', location: 'Austin, Texas, United States' } })] });
      const provider = await createSnovProvider(f);
      const result = await provider.findDatabaseEmails(lead);
      assert.equal(result.status, 'needs_review');
      assert.deepEqual(result.emails, []);
      assert.equal(provider.stats.creditsReserved, 0);
      assert.equal(f.calls.some(call => call.url.includes('/search-emails/start/')), false);
    }),
    t.test('database location cannot match a search-area-only Maps location', async t => {
      const f = await fixture(t, { databaseProspects: [databaseProspect()] });
      const provider = await createSnovProvider(f);
      const result = await provider.findDatabaseEmails({ ...lead, address: '', location: 'Search area: Austin, Texas, USA' });
      assert.equal(result.status, 'needs_review');
      assert.equal(f.calls.some(call => call.url.includes('/search-emails/start/')), false);
    }),
    t.test('database fallback cannot override a conflicting phone already observed for the same domain', async t => {
      const f = await fixture(t, { companyPhone: '15125550999', companyCountry: 'USA', companyState: 'TX', databaseProspects: [databaseProspect()] });
      const provider = await createSnovProvider(f);
      const result = await provider.findEmails(lead);
      assert.equal(result.status, 'needs_review');
      assert.equal(result.evidence.phoneConflict, true);
      assert.equal(f.calls.some(call => call.url.includes('/search-emails/start/')), false);
    }),
    t.test('multiple company domains with matching names and locations require review before reveal', async t => {
      const f = await fixture(t, { databaseProspects: [databaseProspect(), databaseProspect({ company: { name: lead.businessName, domain: 'another.test', location: 'Austin, Texas, United States' } })] });
      const provider = await createSnovProvider(f);
      const result = await provider.findDatabaseEmails(lead);
      assert.equal(result.status, 'needs_review');
      assert.equal(provider.stats.creditsReserved, 0);
      assert.equal(f.calls.some(call => call.url.includes('/search-emails/start/')), false);
    }),
    t.test('unknown database emails are preserved, charge reveal credits, and stop after three prospects', async t => {
      const prospects = Array.from({ length: 5 }, (_, index) => databaseProspect({ email_and_hidden_info_reveal: `https://api.snov.io/v2/database-search/prospects/search-emails/start/prospecttask${index}` }));
      const f = await fixture(t, { databaseProspects: prospects, databaseEmailRowsByReveal: [0, 1, 2].map(index => [{ email: `owner${index}@examplefence.test`, smtp_status: 'unknown' }]) });
      const provider = await createSnovProvider(f);
      const result = await provider.findDatabaseEmails(lead);
      assert.equal(result.status, 'matched');
      assert.equal(result.emails.length, 3);
      assert.ok(result.emails.every(row => row.status === 'unknown'));
      assert.equal(provider.stats.creditsReserved, 3);
      assert.equal(f.calls.filter(call => call.url.includes('/search-emails/start/')).length, 3);
    }),
    t.test('empty database reveal releases its reservation without guessing an email', async t => {
      const f = await fixture(t, { databaseProspects: [databaseProspect()], databaseEmailRows: [] });
      const provider = await createSnovProvider(f);
      const result = await provider.findDatabaseEmails(lead);
      assert.equal(result.status, 'no_email');
      assert.deepEqual(result.emails, []);
      assert.equal(provider.stats.creditsReserved, 0);
    }),
    t.test('database feature denial is permission, not bad credentials or no matches', async t => {
      const f = await fixture(t, { change: ({ path }) => path === '/v2/database-search/prospects/start' ? new Response('secret permission details', { status: 403 }) : undefined });
      const provider = await createSnovProvider(f);
      await assert.rejects(provider.findDatabaseEmails(lead), problem => {
        assert.equal(problem.code, 'permission');
        assert.equal(problem.message.includes('secret'), false);
        return true;
      });
      assert.equal(provider.stats.stoppedCode, 'permission');
      assert.equal(f.calls.filter(call => call.url.includes('/database-search/prospects/start')).length, 1);
    }),
    t.test('malformed database response is an API failure, not no matches', async t => {
      const f = await fixture(t, { change: ({ path }) => path === `/v2/database-search/prospects/result/${hashes.database}` ? Response.json({ status: 'completed', data: { prospects: [] } }) : undefined });
      const provider = await createSnovProvider(f);
      await assert.rejects(provider.findDatabaseEmails(lead), { code: 'api_error' });
      assert.equal(provider.stats.stoppedCode, 'api_error');
    }),
    t.test('foreign reveal URLs are rejected before any paid request or token disclosure', async t => {
      const f = await fixture(t, { databaseProspects: [databaseProspect({ email_and_hidden_info_reveal: 'https://attacker.test/v2/database-search/prospects/search-emails/start/prospecttask123' })] });
      const provider = await createSnovProvider(f);
      await assert.rejects(provider.findDatabaseEmails(lead), { code: 'api_error' });
      assert.ok(f.calls.every(call => new URL(call.url).hostname === 'api.snov.io'));
      assert.equal(provider.stats.creditsReserved, 0);
    }),
    t.test('request diagnostics are awaited and contain no credentials, query names, hashes, or response bodies', async t => {
      const events = [];
      const f = await fixture(t);
      const provider = await createSnovProvider({ ...f, onRequest: async event => {
        await Promise.resolve();
        assert.deepEqual(Object.keys(event), ['method', 'operation', 'status', 'durationMs']);
        events.push(event);
      } });
      await provider.findDatabaseEmails(lead);
      assert.equal(events.length, 4);
      assert.equal(events[0].operation, 'authenticate');
      assert.equal(events.at(-1).operation, 'database_search_result');
      assert.equal(/secret-|Example|databasetask/.test(JSON.stringify(events)), false);
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

test('later malformed reveal preserves an earlier returned unknown database email', async t => {
  const f = await fixture(t, { databaseProspects: [databaseProspect(), databaseProspect({ email_and_hidden_info_reveal: 'https://attacker.test/reveal' })], databaseEmailRows: [{ email: 'owner@examplefence.test', smtp_status: 'unknown' }] });
  const provider = await createSnovProvider(f);
  await assert.rejects(provider.findDatabaseEmails(lead), problem => {
    assert.equal(problem.code, 'api_error');
    assert.equal(problem.partialResult.status, 'needs_review');
    assert.equal(problem.partialResult.emails[0].email, 'owner@examplefence.test');
    assert.equal(problem.partialResult.emails[0].status, 'unknown');
    return true;
  });
  assert.equal(f.calls.filter(call => call.url.includes('/search-emails/start/')).length, 1);
  assert.equal(provider.stats.creditsReserved, 1);
});

test('Snov nullable company metadata', { concurrency: true }, async t => {
  await Promise.all([
    t.test('live-style unrelated company with a null domain is reviewed without a reveal', async t => {
      const checkpoints = [];
      const f = await fixture(t, { databaseProspects: [databaseProspect({ company: { name: 'Other Concrete Company', domain: null, location: 'Lodi, California, United States' } })] });
      const provider = await createSnovProvider(f);
      const result = await provider.findDatabaseEmails(lead, { onCheckpoint: event => checkpoints.push(event) });
      assert.equal(result.status, 'needs_review');
      assert.equal(provider.stats.stoppedCode, null);
      assert.equal(provider.stats.creditsReserved, 0);
      assert.equal(f.calls.some(call => call.url.includes('/search-emails/start/')), false);
      assert.deepEqual(checkpoints.map(row => row.phase), ['started', 'searched', 'completed']);
    }),
    t.test('matched company with a null domain uses its actual location and returned Snov email', async t => {
      const f = await fixture(t, { databaseProspects: [databaseProspect({ company: { name: lead.businessName, domain: null, location: 'Austin, Texas, United States' } })], databaseEmailRows: [{ email: 'actualsnovcontact@gmail.com', smtp_status: 'valid' }] });
      const provider = await createSnovProvider(f);
      const result = await provider.findDatabaseEmails(lead);
      assert.equal(result.status, 'matched');
      assert.equal(result.company.domain, '');
      assert.equal(result.evidence.cityExact, true);
      assert.equal(result.evidence.stateExact, true);
      assert.equal(result.evidence.countryUS, true);
      assert.equal(result.emails[0].email, 'actualsnovcontact@gmail.com');
      assert.equal(result.emails[0].status, 'valid');
      assert.equal(provider.stats.creditsReserved, 1);
    }),
    t.test('missing location and an empty domain cannot establish identity and do not stop discovery', async t => {
      const f = await fixture(t, { databaseProspects: [databaseProspect({ company: { name: lead.businessName, domain: '   ', location: null } })] });
      const provider = await createSnovProvider(f);
      const result = await provider.findDatabaseEmails(lead);
      assert.equal(result.status, 'needs_review');
      assert.equal(provider.stats.stoppedCode, null);
      assert.equal(provider.stats.creditsReserved, 0);
      assert.equal(f.calls.some(call => call.url.includes('/search-emails/start/')), false);
    }),
    t.test('malformed nonempty real domain remains an API error after the free-search checkpoint', async t => {
      const checkpoints = [];
      const f = await fixture(t, { databaseProspects: [databaseProspect({ company: { name: lead.businessName, domain: 'https://examplefence.test/', location: 'Austin, Texas, United States' } })] });
      const provider = await createSnovProvider(f);
      await assert.rejects(provider.findDatabaseEmails(lead, { onCheckpoint: event => checkpoints.push(event) }), { code: 'api_error' });
      assert.equal(provider.stats.stoppedCode, 'api_error');
      assert.deepEqual(checkpoints.map(row => row.phase), ['started', 'searched']);
      assert.equal(provider.stats.creditsReserved, 0);
      assert.equal(f.calls.some(call => call.url.includes('/search-emails/start/')), false);
    }),
  ]);
});

test('null database domain preserves a known phone conflict for the same named company', async t => {
  const f = await fixture(t, { companyPhone: '15125550999', companyCountry: 'USA', companyState: 'TX', databaseProspects: [databaseProspect({ company: { name: lead.businessName, domain: null, location: 'Austin, Texas, United States' } })] });
  const provider = await createSnovProvider(f);
  const result = await provider.findEmails(lead);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.evidence.phoneConflict, true);
  assert.deepEqual(result.emails, []);
  assert.equal(f.calls.some(call => call.url.includes('/search-emails/start/')), false);
  assert.equal(provider.stats.creditsReserved, 2);
});

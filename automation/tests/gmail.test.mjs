import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { authorizeGmail, GMAIL_AUTH_SCOPES, GMAIL_SEND_SCOPE, GmailError, sendGmailMessage } from '../lib/gmail.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactRoot = join(projectRoot, 'artifacts');
const client = { client_id: '123456-test.apps.googleusercontent.com', client_secret: 'fake-client-secret' };
const raw = Buffer.from('From: Afif <craftedwebstudio@gmail.com>\r\nTo: business@example.com\r\nSubject: Website idea\r\n\r\nHello.').toString('base64url');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, { auth = true, expired = false, scope = GMAIL_AUTH_SCOPES, email = 'craftedwebstudio@gmail.com' } = {}) {
  await mkdir(artifactRoot, { recursive: true });
  const directory = await mkdtemp(join(artifactRoot, 'gmail-test-'));
  assert.ok(directory.startsWith(`${artifactRoot}${sep}`));
  t.after(async () => {
    assert.ok(directory.startsWith(`${artifactRoot}${sep}gmail-test-`));
    await rm(directory, { recursive: true, force: true });
  });
  const privateDir = join(directory, 'private');
  await mkdir(privateDir);
  const clientFile = join(directory, 'client.json');
  await writeFile(clientFile, JSON.stringify({ installed: client }));
  if (auth) await writeFile(join(privateDir, 'gmail-auth.json'), JSON.stringify({
    version: 1, client, account: { email, email_verified: true, sub: '123456789012345678901' }, tokens: {
      access_token: 'fake-access-token', refresh_token: 'fake-refresh-token',
      expiry_date: Date.now() + (expired ? -1000 : 3_600_000), scope,
    },
  }));
  return { privateDir, clientFile };
}

test('a successful send submits exactly one message using the stored token', async t => {
  const { privateDir } = await fixture(t);
  let calls = 0;
  const result = await sendGmailMessage({ raw, privateDir, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer fake-access-token');
    assert.deepEqual(JSON.parse(options.body), { raw });
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal.aborted, false);
    return json({ id: 'abc123', threadId: 'thread123' });
  } });
  assert.deepEqual(result, { id: 'abc123', threadId: 'thread123' });
  assert.equal(calls, 1);
});

test('an expired token refreshes once before the sole send and is saved atomically', async t => {
  const { privateDir } = await fixture(t, { expired: true });
  const calls = [];
  const result = await sendGmailMessage({ raw, privateDir, fetchImpl: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/token')) {
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.equal(options.body.get('refresh_token'), 'fake-refresh-token');
      return json({ access_token: 'new-fake-access', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.endsWith('/userinfo')) return json({ email: 'craftedwebstudio@gmail.com', email_verified: true, sub: '123456789012345678901' });
    assert.equal(options.headers.Authorization, 'Bearer new-fake-access');
    return json({ id: 'one123' });
  } });
  assert.deepEqual(result, { id: 'one123' });
  assert.equal(calls.length, 3);
  const saved = JSON.parse(await readFile(join(privateDir, 'gmail-auth.json'), 'utf8'));
  assert.equal(saved.tokens.access_token, 'new-fake-access');
  assert.equal(saved.tokens.refresh_token, 'fake-refresh-token');
  assert.equal(saved.tokens.scope, GMAIL_AUTH_SCOPES);
  assert.deepEqual(await readdir(privateDir), ['gmail-auth.json']);
  if (process.platform !== 'win32') assert.equal((await stat(join(privateDir, 'gmail-auth.json'))).mode & 0o777, 0o600);
});

test('missing authorization stops before network access', async t => {
  const { privateDir } = await fixture(t, { auth: false });
  let calls = 0;
  await assert.rejects(sendGmailMessage({ raw, privateDir, fetchImpl: async () => { calls++; } }),
    { name: 'GmailError', code: 'auth_required', sendOutcome: 'not_sent' });
  assert.equal(calls, 0);
});

test('stored inbox reading scopes are rejected instead of silently used', async t => {
  const { privateDir } = await fixture(t, { scope: `${GMAIL_AUTH_SCOPES} https://www.googleapis.com/auth/gmail.readonly` });
  let calls = 0;
  await assert.rejects(sendGmailMessage({ raw, privateDir, fetchImpl: async () => { calls++; } }), { code: 'scope_mismatch' });
  assert.equal(calls, 0);
});

test('a network failure is ambiguous, sanitized and never retried', async t => {
  const { privateDir } = await fixture(t);
  let calls = 0;
  await assert.rejects(sendGmailMessage({ raw, privateDir, fetchImpl: async () => {
    calls++;
    throw new Error('fake-access-token secret-provider-body');
  } }), cause => {
    assert.ok(cause instanceof GmailError);
    assert.equal(cause.code, 'send_unknown');
    assert.equal(cause.sendOutcome, 'unknown');
    assert.doesNotMatch(cause.message, /fake-access|secret-provider/);
    return true;
  });
  assert.equal(calls, 1);
});

test('5xx and malformed successful responses are ambiguous and never retried', async t => {
  for (const [label, response] of [['server error', json({ error: 'sensitive' }, 503)], ['missing message ID', json({})]]) {
    await t.test(label, async child => {
      const { privateDir } = await fixture(child);
      let calls = 0;
      await assert.rejects(sendGmailMessage({ raw, privateDir, fetchImpl: async () => { calls++; return response; } }),
        { code: 'send_unknown', sendOutcome: 'unknown' });
      assert.equal(calls, 1);
    });
  }
});

test('a rejected send is classified without refresh or automatic retry', async t => {
  const examples = [
    [401, {}, 'auth_required'],
    [429, {}, 'rate_limited'],
    [403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 'rate_limited'],
    [403, {}, 'permission_denied'],
    [400, { error: { message: 'private raw email' } }, 'send_rejected'],
  ];
  for (const [status, body, code] of examples) {
    await t.test(`${status}: ${code}`, async child => {
      const { privateDir } = await fixture(child);
      let calls = 0;
      await assert.rejects(sendGmailMessage({ raw, privateDir, fetchImpl: async () => { calls++; return json(body, status); } }),
        { code, status, sendOutcome: 'not_sent' });
      assert.equal(calls, 1);
    });
  }
});

test('revoked refresh authorization stops before the send endpoint', async t => {
  const { privateDir } = await fixture(t, { expired: true });
  let calls = 0;
  await assert.rejects(sendGmailMessage({ raw, privateDir, fetchImpl: async url => {
    calls++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    return json({ error: 'invalid_grant', error_description: 'fake-refresh-token' }, 400);
  } }), { code: 'auth_required', sendOutcome: 'not_sent' });
  assert.equal(calls, 1);
});

test('pre-cancelled sends and invalid message input do not touch the network', async t => {
  const { privateDir } = await fixture(t);
  let calls = 0;
  const fetchImpl = async () => { calls++; };
  await assert.rejects(sendGmailMessage({ raw, privateDir, fetchImpl, signal: AbortSignal.abort() }), { code: 'send_cancelled' });
  await assert.rejects(sendGmailMessage({ raw: 'bad+base64/raw', privateDir, fetchImpl }), { code: 'message_invalid' });
  assert.equal(calls, 0);
});

test('manual authorization uses loopback, state, PKCE and send plus email identification scopes', async t => {
  const { privateDir, clientFile } = await fixture(t, { auth: false });
  let authorizationUrl;
  let calls = 0;
  const result = await authorizeGmail({
    privateDir, clientFile, timeoutMs: 5000, loginHint: 'craftedwebstudio@gmail.com',
    onAuthorizationUrl: async value => {
      authorizationUrl = new URL(value);
      assert.equal(authorizationUrl.origin, 'https://accounts.google.com');
      const params = authorizationUrl.searchParams;
      assert.equal(params.get('scope'), GMAIL_AUTH_SCOPES);
      assert.equal(params.get('login_hint'), 'craftedwebstudio@gmail.com');
      assert.equal(params.get('access_type'), 'offline');
      assert.equal(params.get('prompt'), 'consent select_account');
      assert.equal(params.get('code_challenge_method'), 'S256');
      const redirect = new URL(params.get('redirect_uri'));
      assert.equal(redirect.hostname, '127.0.0.1');
      assert.ok(Number(redirect.port) > 0);
      redirect.search = new URLSearchParams({ state: 'wrong-state', code: 'fake-code' }).toString();
      assert.equal((await fetch(redirect)).status, 400);
      redirect.search = new URLSearchParams({ state: '\u00e9'.repeat(43), code: 'fake-code' }).toString();
      assert.equal((await fetch(redirect)).status, 400);
      redirect.search = new URLSearchParams({ state: params.get('state'), code: 'fake-authorization-code' }).toString();
      assert.equal((await fetch(redirect)).status, 200);
    },
    fetchImpl: async (url, options) => {
      calls++;
      if (url.endsWith('/userinfo')) {
        assert.equal(options.headers.Authorization, 'Bearer authorized-fake-access');
        return json({ email: 'craftedwebstudio@gmail.com', email_verified: true, sub: '123456789012345678901' });
      }
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.body.get('grant_type'), 'authorization_code');
      assert.equal(options.body.get('code'), 'fake-authorization-code');
      const verifier = options.body.get('code_verifier');
      assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorizationUrl.searchParams.get('code_challenge'));
      return json({ access_token: 'authorized-fake-access', refresh_token: 'authorized-fake-refresh', scope: GMAIL_AUTH_SCOPES, expires_in: 3600, token_type: 'Bearer' });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.authorized, true);
  assert.equal(result.accountIdentityVerified, true);
  assert.equal(result.email, 'craftedwebstudio@gmail.com');
  const stored = await readFile(result.tokenFile, 'utf8');
  assert.match(stored, /authorized-fake-refresh/);
  assert.doesNotMatch(stored, /fake-authorization-code|code_verifier|code_challenge/);
});

test('authorization denial creates no stored token and never calls Google token exchange', async t => {
  const { privateDir, clientFile } = await fixture(t, { auth: false });
  let calls = 0;
  await assert.rejects(authorizeGmail({ privateDir, clientFile, timeoutMs: 5000,
    onAuthorizationUrl: async value => {
      const auth = new URL(value);
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), error: 'access_denied' }).toString();
      await fetch(callback);
    }, fetchImpl: async () => { calls++; },
  }), { code: 'auth_denied' });
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(privateDir), []);
});

test('authorization timeout closes the loopback listener and creates no token', async t => {
  const { privateDir, clientFile } = await fixture(t, { auth: false });
  let redirect;
  let calls = 0;
  await assert.rejects(authorizeGmail({ privateDir, clientFile, timeoutMs: 100,
    onAuthorizationUrl: value => { redirect = new URL(value).searchParams.get('redirect_uri'); },
    fetchImpl: async () => { calls++; },
  }), { code: 'auth_timeout' });
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(privateDir), []);
  await assert.rejects(fetch(redirect, { signal: AbortSignal.timeout(1000) }));
});

test('invalid client type and excessive authorization timeout are rejected before presenting a URL', async t => {
  const { privateDir, clientFile } = await fixture(t, { auth: false });
  await writeFile(clientFile, JSON.stringify({ web: client }));
  let announcements = 0;
  const onAuthorizationUrl = () => { announcements++; };
  await assert.rejects(authorizeGmail({ privateDir, clientFile, onAuthorizationUrl }), { code: 'credentials_invalid' });
  await assert.rejects(authorizeGmail({ privateDir, clientFile, onAuthorizationUrl, timeoutMs: 180_001 }), { code: 'configuration_invalid' });
  assert.equal(announcements, 0);
});

test('a broader token grant is rejected without storing it', async t => {
  const { privateDir, clientFile } = await fixture(t, { auth: false });
  await assert.rejects(authorizeGmail({ privateDir, clientFile, timeoutMs: 5000,
    onAuthorizationUrl: async value => {
      const auth = new URL(value);
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fake-code' }).toString();
      await fetch(callback);
    },
    fetchImpl: async () => json({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600,
      scope: `${GMAIL_AUTH_SCOPES} https://www.googleapis.com/auth/gmail.readonly` }),
  }), { code: 'scope_mismatch' });
  assert.deepEqual(await readdir(privateDir), []);
});

test('a stored account mismatch prevents all network access', async t => {
  const { privateDir } = await fixture(t, { email: 'different-account@gmail.com' });
  let calls = 0;
  await assert.rejects(sendGmailMessage({ raw, privateDir, fetchImpl: async () => { calls++; } }),
    { code: 'account_mismatch', sendOutcome: 'not_sent' });
  assert.equal(calls, 0);
});

test('the old misspelled sender address is rejected before network access', async t => {
  const { privateDir } = await fixture(t);
  let calls = 0;
  const wrongRaw = Buffer.from('From: Afif <craftedwestudio@gmail.com>\r\nTo: business@example.com\r\n\r\nHello.').toString('base64url');
  await assert.rejects(sendGmailMessage({ raw: wrongRaw, privateDir, fetchImpl: async () => { calls++; } }),
    { code: 'message_sender_mismatch', sendOutcome: 'not_sent' });
  assert.equal(calls, 0);
});

test('selecting a different or unverified account creates no stored authorization', async t => {
  for (const [email, email_verified, code] of [
    ['different-account@gmail.com', true, 'account_mismatch'],
    ['craftedwebstudio@gmail.com', false, 'account_unverified'],
  ]) {
    await t.test(code, async child => {
      const { privateDir, clientFile } = await fixture(child, { auth: false });
      await assert.rejects(authorizeGmail({ privateDir, clientFile, timeoutMs: 5000,
        onAuthorizationUrl: async value => {
          const auth = new URL(value);
          const callback = new URL(auth.searchParams.get('redirect_uri'));
          callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fake-code' }).toString();
          await fetch(callback);
        },
        fetchImpl: async url => url.endsWith('/userinfo')
          ? json({ email, email_verified, sub: '123456789012345678901' })
          : json({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600,
            scope: `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_SEND_SCOPE}` }),
      }), { code });
      assert.deepEqual(await readdir(privateDir), []);
    });
  }
});

test('a refreshed token is checked for account identity before any send', async t => {
  const { privateDir } = await fixture(t, { expired: true });
  let calls = 0;
  await assert.rejects(sendGmailMessage({ raw, privateDir, fetchImpl: async url => {
    calls++;
    if (url.endsWith('/token')) return json({ access_token: 'fake-new-access', expires_in: 3600 });
    assert.ok(url.endsWith('/userinfo'));
    return json({ email: 'different-account@gmail.com', email_verified: true, sub: 'different-subject' });
  } }), { code: 'account_mismatch' });
  assert.equal(calls, 2);
});

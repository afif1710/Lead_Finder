import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, lstat, writeFile, chmod } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_AUTH_SCOPES = `openid email ${GMAIL_SEND_SCOPE}`;
const DEFAULT_SENDER = 'craftedwebstudio@gmail.com';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const TOKEN_FILE = 'gmail-auth.json';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_AUTH_TIMEOUT_MS = 180_000;

/** Error messages deliberately exclude provider responses, tokens and recipient data. */
export class GmailError extends Error {
  constructor(code, message, { status, sendOutcome = 'not_sent' } = {}) {
    super(message);
    this.name = 'GmailError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.sendOutcome = sendOutcome;
  }
}

function error(code, message, options) { return new GmailError(code, message, options); }

function privatePath(privateDir) {
  if (typeof privateDir !== 'string' || !privateDir.trim()) {
    throw error('configuration_invalid', 'A local private directory is required.');
  }
  const dir = resolve(privateDir);
  if (dir === parse(dir).root) throw error('configuration_invalid', 'Use a dedicated private directory.');
  return { dir, file: join(dir, TOKEN_FILE) };
}

function validateClient(client) {
  if (!client || typeof client !== 'object' ||
      typeof client.client_id !== 'string' || client.client_id.length > 512 ||
      !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(client.client_id) ||
      (client.client_secret !== undefined &&
        (typeof client.client_secret !== 'string' || !client.client_secret || client.client_secret.length > 512))) {
    throw error('credentials_invalid', 'Use the downloaded Google Desktop app OAuth client JSON.');
  }
  return { client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) };
}

async function readJsonFile(file, missingCode) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) {
      throw error('credentials_invalid', 'The local authorization file is invalid.');
    }
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    if (cause instanceof GmailError) throw cause;
    if (cause?.code === 'ENOENT') throw error(missingCode, 'The required local authorization file was not found.');
    throw error('credentials_invalid', 'The local authorization file could not be read.');
  }
}

function validateScope(scope) {
  const values = typeof scope === 'string' ? new Set(scope.trim().split(/\s+/).map(value =>
    value === 'https://www.googleapis.com/auth/userinfo.email' ? 'email' : value)) : new Set();
  if (values.size !== 3 || !values.has('openid') || !values.has('email') || !values.has(GMAIL_SEND_SCOPE)) {
    throw error('scope_mismatch', 'Authorization must grant only Gmail send access and account email identification. Reconnect with the intended permissions.');
  }
  return GMAIL_AUTH_SCOPES;
}

function normalizeEmail(email) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw error('configuration_invalid', 'The configured sender email address is invalid.');
  }
  return email.toLowerCase();
}

function validateAccount(account, expectedEmail) {
  if (!account || account.email_verified !== true || typeof account.sub !== 'string' ||
      !/^[\x21-\x7e]{1,255}$/.test(account.sub) || typeof account.email !== 'string') {
    throw error('account_unverified', 'Google account identity could not be verified; reconnect before sending.');
  }
  if (normalizeEmail(account.email) !== expectedEmail) {
    throw error('account_mismatch', 'The authorized Google account differs from the configured sender. Reconnect using the correct account.');
  }
  return { email: expectedEmail, sub: account.sub, email_verified: true };
}

function nonemptyToken(value) { return typeof value === 'string' && value.length > 0 && value.length <= 16_384; }

function validateAuth(record, expectedEmail) {
  if (!record || record.version !== 1 || !record.tokens ||
      !nonemptyToken(record.tokens.access_token) || !nonemptyToken(record.tokens.refresh_token) ||
      !Number.isFinite(record.tokens.expiry_date) || record.tokens.expiry_date <= 0) {
    throw error('auth_invalid', 'Stored Gmail authorization is invalid; reconnect before sending.');
  }
  return { version: 1, client: validateClient(record.client), account: validateAccount(record.account, expectedEmail), tokens: {
    access_token: record.tokens.access_token,
    refresh_token: record.tokens.refresh_token,
    expiry_date: record.tokens.expiry_date,
    scope: validateScope(record.tokens.scope),
  } };
}

async function saveAuth(privateDir, record) {
  const { dir, file } = privatePath(privateDir);
  let temporary;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid private directory');
    // POSIX modes are restrictive. On Windows the directory inherits its owner's ACL.
    if (process.platform !== 'win32') await chmod(dir, 0o700);
    temporary = join(dir, `.gmail-auth-${randomBytes(12).toString('hex')}.tmp`);
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
    temporary = undefined;
    if (process.platform !== 'win32') await chmod(file, 0o600);
    return file;
  } catch {
    throw error('storage_failed', 'Gmail authorization could not be saved securely in the local private directory.');
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

function requestSignal(signal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responseJson(response) {
  try {
    const text = await response.text();
    if (text.length > 131_072) return null;
    return JSON.parse(text);
  } catch { return null; }
}

async function requestTokens(parameters, { fetchImpl, signal, priorTokens } = {}) {
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters), signal: requestSignal(signal), redirect: 'error',
    });
  } catch {
    throw error('auth_network_failed', 'Google authorization could not be completed. Check the connection and try authorization again.');
  }
  const data = await responseJson(response);
  if (!response.ok) {
    if (data?.error === 'invalid_grant' || response.status === 401) {
      throw error('auth_required', 'Google authorization expired or was revoked; reconnect before sending.', { status: response.status });
    }
    if (data?.error === 'invalid_client') {
      throw error('credentials_invalid', 'Google rejected the OAuth client; check the Desktop app credentials.', { status: response.status });
    }
    if (response.status === 429 || response.status >= 500) {
      throw error('auth_temporarily_unavailable', 'Google authorization is temporarily unavailable; no email was attempted.', { status: response.status });
    }
    throw error('auth_rejected', 'Google rejected authorization; check client setup and send-only consent.', { status: response.status });
  }
  if (!data || !nonemptyToken(data.access_token) ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86_400 ||
      (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'))) {
    throw error('auth_invalid', 'Google returned an invalid authorization response; no email was attempted.');
  }
  const refreshToken = data.refresh_token ?? priorTokens?.refresh_token;
  if (!nonemptyToken(refreshToken)) throw error('auth_required', 'Google did not grant offline access; authorize again before sending.');
  return {
    access_token: data.access_token,
    refresh_token: refreshToken,
    expiry_date: Date.now() + data.expires_in * 1000,
    scope: validateScope(data.scope ?? priorTokens?.scope ?? GMAIL_AUTH_SCOPES),
  };
}

async function identifyAccount(accessToken, expectedEmail, { fetchImpl, signal }) {
  let response;
  try {
    response = await fetchImpl(USERINFO_URL, {
      method: 'GET', headers: { Authorization: `Bearer ${accessToken}` },
      signal: requestSignal(signal), redirect: 'error',
    });
  } catch {
    throw error('account_unverified', 'Google account identity could not be checked; no email was attempted.');
  }
  if (!response.ok) throw error('account_unverified', 'Google account identity was not available; no email was attempted.', { status: response.status });
  // Trust only Google's HTTPS UserInfo response, never an unverified decoded ID token.
  return validateAccount(await responseJson(response), expectedEmail);
}

function matchingState(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

/**
 * Starts a bounded manual Desktop OAuth flow. The callback receives a URL for the
 * user to open; this module never opens a browser or enters Google credentials.
 * Requests Gmail send and minimal account email identification, with no inbox access.
 */
export async function authorizeGmail({
  clientFile, privateDir, onAuthorizationUrl, timeoutMs = MAX_AUTH_TIMEOUT_MS,
  expectedEmail = DEFAULT_SENDER, loginHint = expectedEmail, fetchImpl = globalThis.fetch, signal,
} = {}) {
  privatePath(privateDir);
  expectedEmail = normalizeEmail(expectedEmail);
  if (typeof onAuthorizationUrl !== 'function' || typeof fetchImpl !== 'function') {
    throw error('configuration_invalid', 'An authorization URL callback and fetch implementation are required.');
  }
  if (typeof clientFile !== 'string' || !clientFile.trim()) {
    throw error('credentials_missing', 'Provide the downloaded Desktop app OAuth client JSON path.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_AUTH_TIMEOUT_MS) {
    throw error('configuration_invalid', 'Authorization timeout must be between 1 ms and 3 minutes.');
  }
  if (loginHint !== undefined && normalizeEmail(loginHint) !== expectedEmail) {
    throw error('configuration_invalid', 'The Google account hint must match the configured sender.');
  }
  const downloaded = await readJsonFile(resolve(clientFile), 'credentials_missing');
  const client = validateClient(downloaded.installed);
  if (signal?.aborted) throw error('auth_cancelled', 'Google authorization was cancelled.');
  const deadline = new AbortController();
  const totalSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolveCallback, rejectCallback) => {
    resolveCode = resolveCallback;
    rejectCode = rejectCallback;
  });
  // The promise may reject before the listener is ready; attach a handler immediately.
  codePromise.catch(() => {});
  let callbackConsumed = false;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    let url;
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1'); }
    catch { response.writeHead(400).end('Invalid request.'); return; }
    if (request.method !== 'GET' || url.pathname !== '/oauth2callback') {
      response.writeHead(404).end('Not found.');
      return;
    }
    if (callbackConsumed || !matchingState(url.searchParams.get('state'), state)) {
      response.writeHead(400).end('Authorization response rejected. Return to the original authorization link.');
      return;
    }
    callbackConsumed = true;
    if (url.searchParams.has('error')) {
      response.writeHead(400).end('Authorization was not completed. You can return to Lead Finder.');
      rejectCode(error('auth_denied', 'Google authorization was declined or interrupted.'));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) {
      response.writeHead(400).end('Authorization response was incomplete.');
      rejectCode(error('auth_invalid', 'Google authorization response was incomplete.'));
      return;
    }
    response.writeHead(200).end('Authorization response received. Return to Lead Finder to check completion.');
    resolveCode(code);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1;
  server.maxHeadersCount = 20;
  const onAbort = () => rejectCode(error(signal?.aborted ? 'auth_cancelled' : 'auth_timeout',
    signal?.aborted ? 'Google authorization was cancelled.' : 'Google authorization timed out after the bounded waiting period.'));
  totalSignal.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    if (totalSignal.aborted) onAbort();
    const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
      scope: GMAIL_AUTH_SCOPES, access_type: 'offline', prompt: 'consent select_account',
      state, code_challenge: challenge, code_challenge_method: 'S256',
      ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();
    // A callback rejection also terminates waiting without logging its contents.
    const announcement = Promise.resolve().then(() => onAuthorizationUrl(url.toString()));
    announcement.catch(() => rejectCode(error('auth_cancelled', 'The authorization link could not be presented.')));
    const code = await codePromise;
    const tokens = await requestTokens({
      ...client, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
    }, { fetchImpl, signal: totalSignal });
    const account = await identifyAccount(tokens.access_token, expectedEmail, { fetchImpl, signal: totalSignal });
    if (totalSignal.aborted) throw error('auth_timeout', 'Google authorization exceeded its bounded waiting period.');
    const tokenFile = await saveAuth(privateDir, { version: 1, client, tokens, account });
    return { authorized: true, scope: GMAIL_AUTH_SCOPES, accountIdentityVerified: true, email: account.email, tokenFile };
  } catch (cause) {
    if (cause instanceof GmailError) throw cause;
    throw error('auth_failed', 'The local Google authorization flow could not be completed.');
  } finally {
    clearTimeout(timer);
    totalSignal.removeEventListener('abort', onAbort);
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(() => resolveClose()));
  }
}

/**
 * raw is a base64url-encoded RFC 2822 message. A send request is NEVER retried here.
 * Network errors, 5xx errors and malformed successes are ambiguous; callers must
 * reserve history before calling and must not automatically resend those messages.
 */
export async function sendGmailMessage({ raw, privateDir, expectedEmail = DEFAULT_SENDER, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > 1_048_576 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) {
    throw error('message_invalid', 'A valid base64url message is required.');
  }
  if (typeof fetchImpl !== 'function') throw error('configuration_invalid', 'A fetch implementation is required.');
  expectedEmail = normalizeEmail(expectedEmail);
  const decoded = Buffer.from(raw, 'base64url');
  if (decoded.toString('base64url') !== raw.replace(/=+$/, '')) {
    throw error('message_invalid', 'The message encoding is invalid.');
  }
  const headers = decoded.toString('utf8').split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ');
  const fromHeaders = headers.split(/\r?\n/).filter(line => /^from:/i.test(line));
  const fromValue = fromHeaders[0]?.replace(/^from:\s*/i, '').trim();
  const fromAddress = fromValue?.match(/<([^<>\s]+)>\s*$/)?.[1] ?? fromValue;
  if (fromHeaders.length !== 1 || typeof fromAddress !== 'string' || fromAddress.toLowerCase() !== expectedEmail) {
    throw error('message_sender_mismatch', 'The message From address must match the verified configured sender.');
  }
  if (signal?.aborted) throw error('send_cancelled', 'Sending was cancelled before an email was attempted.');
  const { file } = privatePath(privateDir);
  const record = validateAuth(await readJsonFile(file, 'auth_required'), expectedEmail);
  if (record.tokens.expiry_date <= Date.now() + 60_000) {
    record.tokens = await requestTokens({ ...record.client, grant_type: 'refresh_token', refresh_token: record.tokens.refresh_token },
      { fetchImpl, signal, priorTokens: record.tokens });
    record.account = await identifyAccount(record.tokens.access_token, expectedEmail, { fetchImpl, signal });
    await saveAuth(privateDir, record);
  }
  if (signal?.aborted) throw error('send_cancelled', 'Sending was cancelled before an email was attempted.');
  let response;
  try {
    response = await fetchImpl(SEND_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${record.tokens.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }), signal: requestSignal(signal), redirect: 'error',
    });
  } catch {
    throw error('send_unknown', 'Google may have received the email. Check Sent manually; this message must not be retried automatically.', { sendOutcome: 'unknown' });
  }
  const data = await responseJson(response);
  if (response.ok) {
    if (!data || typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)) {
      throw error('send_unknown', 'Google returned no valid message ID. Check Sent manually; this message must not be retried automatically.', { sendOutcome: 'unknown' });
    }
    return { id: data.id, ...(typeof data.threadId === 'string' ? { threadId: data.threadId } : {}) };
  }
  const status = response.status;
  if (status >= 500 || status < 400) {
    throw error('send_unknown', 'Google returned an ambiguous send response. Check Sent manually; this message must not be retried automatically.', { status, sendOutcome: 'unknown' });
  }
  if (status === 401) throw error('auth_required', 'Google rejected send authorization. Reconnect before any further sending.', { status });
  const reasons = Array.isArray(data?.error?.errors) ? data.error.errors.map(item => item?.reason) : [];
  if (status === 429 || reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded'].includes(reason))) {
    throw error('rate_limited', 'Google rejected sending because a limit was reached. Stop the batch and review the account.', { status });
  }
  if (status === 403) throw error('permission_denied', 'Google denied permission to send. Check Gmail API setup and authorization.', { status });
  throw error('send_rejected', 'Google rejected the email. Review the message and account before any further sending.', { status });
}

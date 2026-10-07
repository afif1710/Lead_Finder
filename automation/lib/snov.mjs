import { lstat, readFile } from 'node:fs/promises';

// Public contracts only: https://snov.io/api
// Free test access: https://snov.io/knowledgebase/how-to-get-api-credentials/
// Verification costs: https://snov.io/knowledgebase/email-verification-credits/
const API = 'https://api.snov.io';
const REQUEST_TIMEOUT = 15_000;
const RATE_INTERVAL = 1_300; // At most 47 requests/minute, including polls.
const POLL_DELAY = 3_000;
const POLL_ATTEMPTS = 6;
const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const STATE_NAMES = new Set('alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia'.split('|'));
const STATE_CODES_BY_NAME = new Map([...STATE_NAMES].map((name, index) => [name, [...STATES][index]]));

export class SnovError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnovError';
    this.code = code;
  }
}

function error(code) {
  const messages = {
    auth: 'Snov authentication or API permission failed. Check the local credentials and account access.',
    quota: 'Snov has insufficient credits or has denied the account quota. Discovery stopped.',
    timeout: 'Snov discovery was cancelled or exceeded a time limit. Discovery stopped.',
    rate_limit: 'Snov rate limit reached. Discovery stopped without retrying paid requests.',
    budget: 'The configured Snov request or credit budget has been reached. Discovery stopped.',
    api_error: 'Snov returned an unexpected response or a request could not be confirmed. Discovery stopped.',
  };
  return new SnovError(code, messages[code] || messages.api_error);
}

function normalizeName(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(?:llc|inc|incorporated|ltd|limited|corp|corporation)\b/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function usPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^1\d{10}$/.test(digits) ? digits.slice(1) : /^\d{10}$/.test(digits) ? digits : '';
}

function usState(value) {
  const state = String(value || '').trim();
  return STATES.has(state.toUpperCase()) ? state.toUpperCase() : STATE_CODES_BY_NAME.get(state.toLowerCase()) || '';
}

function reliableUSLocation(lead) {
  // A search-area label describes the query, not the business's physical city.
  const address = String(lead.address || '').trim();
  const addressMatch = address.match(/,\s*([^,]+),\s*([A-Za-z]{2})\s+\d{5}(?:-\d{4})?(?:,\s*(?:United States(?: of America)?|USA))?\s*$/i);
  if (addressMatch && STATES.has(addressMatch[2].toUpperCase())) return { city: addressMatch[1].trim(), state: addressMatch[2].toUpperCase() };
  const location = String(lead.location || '').trim();
  if (/^search\s+area\s*:/i.test(location)) return null;
  const locationMatch = location.match(/^([^,]+),\s*([^,]+),\s*(?:USA|United States(?: of America)?)$/i);
  if (!locationMatch) return null;
  const state = usState(locationMatch[2]);
  return state ? { city: locationMatch[1].trim(), state } : null;
}

function checkedDomain(value) {
  const domain = String(value || '').trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw error('api_error');
  return domain;
}

function hashOf(response) {
  const hash = response?.data?.task_hash || response?.meta?.task_hash;
  if (typeof hash !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(hash)) throw error('api_error');
  return hash;
}

function emailCandidates(data) {
  if (!Array.isArray(data)) throw error('api_error');
  const emails = new Set();
  for (const row of data.slice(0, 50)) {
    const email = String(row?.email || '').trim().toLowerCase();
    if (email.length <= 254 && !email.includes('..') && /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(email)) emails.add(email);
  }
  const preferred = ['info', 'contact', 'office', 'hello', 'sales', 'enquiries', 'inquiries', 'admin', 'support'];
  return [...emails].sort((a, b) => {
    const priority = email => {
      const index = preferred.indexOf(email.split('@')[0]);
      return index < 0 ? preferred.length : index;
    };
    return priority(a) - priority(b);
  }).slice(0, 50);
}

/** Use only after Snov has granted API access. No login cookies are read. */
export async function createSnovProvider({
  credentialsFile,
  maxRequests = 250,
  maxCredits = 50,
  deadlineMs = 1_800_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || !Number.isInteger(maxCredits) || maxCredits < 1 || !Number.isFinite(deadlineMs) || deadlineMs < 1 || typeof fetchImpl !== 'function') throw error('budget');
  const requestLimit = Math.min(maxRequests, 250);
  const configuredCreditLimit = Math.min(maxCredits, 50);
  const started = Date.now();
  const deadline = started + Math.min(deadlineMs, 1_800_000);
  const metrics = { requests: 0, requestCount: 0, creditsReserved: 0, initialBalance: null, creditLimit: 0, stoppedCode: null };
  const stats = Object.freeze(Object.defineProperties({}, Object.fromEntries(Object.keys(metrics).map(key => [key, { enumerable: true, get: () => metrics[key] }]))));
  let clientId;
  let clientSecret;
  try {
    const info = await lstat(credentialsFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) throw new Error();
    const credentials = JSON.parse((await readFile(credentialsFile, 'utf8')).replace(/^\uFEFF/, ''));
    clientId = credentials.clientId || credentials.client_id;
    clientSecret = credentials.clientSecret || credentials.client_secret;
    if (typeof clientId !== 'string' || !clientId.trim() || typeof clientSecret !== 'string' || !clientSecret.trim()) throw new Error();
  } catch {
    // Never echo parse errors, paths, credentials, request headers or response bodies.
    throw error('auth');
  }
  let token = '';
  let tokenExpires = 0;
  let nextSlot = started;
  let stopped = null;

  function stop(problem) {
    if (!stopped) {
      stopped = problem instanceof SnovError ? problem : error('api_error');
      metrics.stoppedCode = stopped.code;
    }
    throw stopped;
  }

  function check(signal) {
    if (stopped) throw stopped;
    if (signal?.aborted || Date.now() >= deadline) stop(error('timeout'));
  }

  async function pause(ms, signal) {
    check(signal);
    if (Date.now() + ms >= deadline) stop(error('timeout'));
    if (ms <= 0) return;
    await new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error('timeout'));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }).catch(stop);
    check(signal);
  }

  function reserveCredits(amount) {
    if (metrics.creditsReserved + amount > metrics.creditLimit) stop(error('budget'));
    // Reserve the worst-case cost. Never retry an uncertain paid POST, or assume it was free.
    metrics.creditsReserved += amount;
  }

  async function request(method, path, params, signal, authenticating = false) {
    check(signal);
    if (metrics.requests >= requestLimit) stop(error('budget'));
    const slot = Math.max(Date.now(), nextSlot);
    nextSlot = slot + RATE_INTERVAL;
    await pause(slot - Date.now(), signal);
    check(signal);
    if (metrics.requests >= requestLimit) stop(error('budget'));
    let url;
    try {
      url = new URL(path, API);
      if (url.origin !== API || url.username || url.password || url.hash) throw new Error();
    } catch { stop(error('api_error')); }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT, deadline - Date.now()));
    let onTimeout;
    const aborted = new Promise((_, reject) => {
      onTimeout = () => reject(error('timeout'));
      controller.signal.addEventListener('abort', onTimeout, { once: true });
    });
    metrics.requests += 1;
    metrics.requestCount = metrics.requests;
    try {
      const response = await Promise.race([fetchImpl(url.href, {
        method,
        headers: authenticating ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {
          Authorization: `Bearer ${token}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(method === 'POST' ? { body: new URLSearchParams(params) } : {}),
        redirect: 'error',
        signal: controller.signal,
      }), aborted]);
      if (response.status === 401 || response.status === 403) throw error('auth');
      if (response.status === 402) throw error('quota');
      if (response.status === 429) throw error('rate_limit');
      if (!response.ok) throw error('api_error');
      const bodyText = await Promise.race([response.text(), aborted]);
      if (bodyText.length > 1_000_000) throw error('api_error');
      let body;
      try { body = JSON.parse(bodyText); } catch { throw error('api_error'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw error('api_error');
      if (body.status === 'not_enough_credits') throw error('quota');
      if (body.success === false || body.status === 'error' || body.status === 'failed') throw error('api_error');
      return body;
    } catch (problem) {
      stop(controller.signal.aborted || signal?.aborted ? error('timeout') : problem);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onTimeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function ensureToken(signal) {
    if (token && Date.now() + REQUEST_TIMEOUT < tokenExpires) return;
    const result = await request('POST', '/v1/oauth/access_token', {
      grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
    }, signal, true);
    if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in < 1) stop(error('auth'));
    token = result.access_token;
    tokenExpires = Date.now() + Math.min(result.expires_in, 3600) * 1000;
  }

  async function api(method, path, params, signal) {
    await ensureToken(signal);
    return request(method, path, params, signal);
  }

  function safeResultPath(response, expectedPath) {
    const supplied = response?.links?.result;
    if (supplied !== undefined) {
      let result;
      try { result = new URL(supplied); } catch { stop(error('api_error')); }
      const expected = new URL(expectedPath, API);
      if (result.origin !== API || result.username || result.password || result.hash || result.pathname !== expected.pathname || result.search !== expected.search) stop(error('api_error'));
    }
    return expectedPath;
  }

  async function poll(path, signal) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      if (attempt) await pause(POLL_DELAY, signal);
      const result = await api('GET', path, undefined, signal);
      if (result.status === 'completed') return result;
      if (result.status !== 'in_progress' && result.status !== 'in progress') stop(error('api_error'));
    }
    stop(error('timeout'));
  }

  async function domainTask(part, domain, signal) {
    reserveCredits(1);
    const startPath = part ? `/v2/domain-search/${part}/start` : '/v2/domain-search/start';
    const response = await api('POST', startPath, { domain }, signal);
    const hash = hashOf(response);
    const resultPath = part ? `/v2/domain-search/${part}/result/${hash}` : `/v2/domain-search/result/${hash}`;
    const result = await poll(safeResultPath(response, resultPath), signal);
    const noResults = Array.isArray(result.data) ? result.data.length === 0 : result.data && typeof result.data === 'object' && Object.keys(result.data).length === 0;
    if (noResults) metrics.creditsReserved -= 1;
    return result;
  }

  await ensureToken();
  const balance = await api('GET', '/v1/get-balance');
  const initialBalance = Number(balance?.data?.balance);
  if (balance?.data?.balance === undefined || !Number.isFinite(initialBalance) || initialBalance < 0) stop(error('api_error'));
  metrics.initialBalance = initialBalance;
  metrics.creditLimit = Math.min(configuredCreditLimit, Math.floor(initialBalance));
  if (metrics.creditLimit < 1) stop(error('quota'));

  return {
    stats,
    async findEmails(lead, { signal } = {}) {
      check(signal);
      const requestedName = String(lead?.businessName || '').trim();
      if (!normalizeName(requestedName)) return { status: 'needs_review', reason: 'Missing business name.', company: null, emails: [], evidence: {} };
      reserveCredits(1);
      const start = await api('POST', '/v2/company-domain-by-name/start', [['names[]', requestedName]], signal);
      const hash = hashOf(start);
      const found = await poll(safeResultPath(start, `/v2/company-domain-by-name/result?task_hash=${hash}`), signal);
      if (!Array.isArray(found.data)) stop(error('api_error'));
      // The documented name in this response is the submitted query, not identity evidence.
      const rows = found.data.filter(row => row?.name === requestedName);
      const domains = [...new Set(rows.map(row => row?.result?.domain).filter(Boolean))];
      if (!domains.length) {
        if (!found.data.length || rows.length === found.data.length) metrics.creditsReserved -= 1;
        return { status: 'no_email', reason: 'Snov returned no domain for this business name.', company: null, emails: [], evidence: { requestedName, source: 'Snov.io' } };
      }
      if (domains.length !== 1) return { status: 'needs_review', reason: 'Snov returned multiple company domains.', company: null, emails: [], evidence: { requestedName, domains, source: 'Snov.io' } };
      let domain;
      try { domain = checkedDomain(domains[0]); } catch (problem) { stop(problem); }
      const companyResult = await domainTask('', domain, signal);
      const data = companyResult.data;
      if ((Array.isArray(data) && !data.length) || (data && typeof data === 'object' && !Object.keys(data).length)) return {
        status: 'needs_review', reason: 'Snov returned no company metadata to confirm identity.', company: null, emails: [], evidence: { requestedName, domain, source: 'Snov.io' },
      };
      if (!data || typeof data !== 'object' || Array.isArray(data)) stop(error('api_error'));
      const company = {
        name: typeof data.company_name === 'string' ? data.company_name : '',
        city: typeof data.city === 'string' ? data.city : '',
        phone: String(data.hq_phone || ''),
        country: typeof data.country === 'string' ? data.country : '',
        state: typeof data.state === 'string' ? data.state : typeof data.region === 'string' ? data.region : '',
        website: typeof data.website === 'string' ? data.website : '',
        domain,
      };
      const leadLocation = reliableUSLocation(lead);
      const leadCity = leadLocation?.city || '';
      const nameExact = normalizeName(company.name) !== '' && normalizeName(company.name) === normalizeName(requestedName);
      const phoneExact = usPhone(lead.phone) !== '' && usPhone(lead.phone) === usPhone(company.phone);
      const cityExact = leadCity !== '' && normalizeName(leadCity) === normalizeName(company.city);
      // Country is not guaranteed by Snov's documented company-info schema.
      // If absent, a common city name is insufficient to identify a US company.
      const countryUS = /^(?:US|USA|United States(?: of America)?)$/i.test(company.country.trim());
      const stateExact = Boolean(leadLocation?.state) && leadLocation.state === usState(company.state);
      const phoneConflict = Boolean(company.phone.trim()) && !phoneExact;
      const evidence = {
        source: 'Snov.io', requestedName, nameExact, phoneExact, phoneConflict, cityExact, stateExact, countryUS,
        leadState: leadLocation?.state || '', companyState: company.state,
        leadCity, reliableUSCity: Boolean(leadCity), domain, observedWebsite: company.website,
        websiteFunctionality: 'not_checked', checkedAt: new Date().toISOString(),
      };
      if (!nameExact || phoneConflict || (!phoneExact && !(cityExact && stateExact && countryUS))) return {
        status: 'needs_review', reason: 'Company identity requires an exact name and non-conflicting phone match, or exact city and state with explicit US country evidence.', company, emails: [], evidence,
      };
      let contacts = emailCandidates((await domainTask('generic-contacts', domain, signal)).data);
      if (!contacts.length) contacts = emailCandidates((await domainTask('domain-emails', domain, signal)).data);
      if (!contacts.length) return { status: 'no_email', reason: 'The matched Snov company has no returned email addresses.', company, emails: [], evidence };
      const result = {
        status: 'matched', reason: 'Company identity matched; only emails actually returned by Snov are included.', company,
        emails: contacts.map(email => ({ email, status: 'unknown', source: 'Snov.io', verificationReason: 'not_checked', checkedAt: evidence.checkedAt })), evidence,
      };
      // The sender contacts one business once: verify at most three candidates,
      // stop at the first valid address, and retain every other found address.
      for (const candidate of result.emails.slice(0, 3)) {
        try {
          reserveCredits(1);
          const verifyStart = await api('POST', '/v2/email-verification/start', [['emails[]', candidate.email]], signal);
          const verifyHash = hashOf(verifyStart);
          const verified = await poll(safeResultPath(verifyStart, `/v2/email-verification/result?task_hash=${verifyHash}`), signal);
          if (!Array.isArray(verified.data)) stop(error('api_error'));
          const row = verified.data.find(item => String(item?.email || '').toLowerCase() === candidate.email);
          const status = row?.result?.smtp_status;
          if (row && !['valid', 'not_valid', 'unknown'].includes(status)) stop(error('api_error'));
          candidate.status = status || 'unknown';
          candidate.verificationReason = !row ? 'No verification result returned.' : String(row.result.unknown_status_reason || '');
          candidate.checkedAt = new Date().toISOString();
          if (row && candidate.status === 'unknown') metrics.creditsReserved -= 1;
          if (candidate.status === 'valid') break;
        } catch (problem) {
          if (problem?.code === 'budget') {
            result.reason = 'Snov verification stopped at the configured budget; found emails were preserved and unchecked emails cannot be sent.';
            return result;
          }
          const classified = problem instanceof SnovError ? problem : error('api_error');
          classified.partialResult = { ...result, status: 'needs_review', reason: 'Verification was interrupted; found emails were preserved for review.' };
          if (!stopped) { stopped = classified; metrics.stoppedCode = classified.code; }
          throw classified;
        }
      }
      return result;
    },
  };
}

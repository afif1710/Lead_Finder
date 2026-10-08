import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { leadKeys, validEmail } from './leads.mjs';

export async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function openStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'history.json');
  const marker = join(directory, 'history-initialized.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('History cannot be read. Restore it before sending; do not delete or reset it.');
    const initialized = await readFile(marker, 'utf8').then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false; });
    if (initialized) throw new Error('History is missing after a previous run. Restore your history backup; sending is blocked to prevent duplicate emails.');
    state = { version: 1, discovery: {}, contacts: {}, sends: [], suppressions: [], pilot: { limit: 10, closed: false } };
    await writeJson(file, state);
    await writeJson(marker, { initializedAt: new Date().toISOString() });
  }
  if (state.version !== 1 || !state.discovery || !state.contacts || !Array.isArray(state.sends) || !Array.isArray(state.suppressions) || state.pilot?.limit !== 10 || typeof state.pilot.closed !== 'boolean') throw new Error('History format is invalid; sending is blocked.');
  for (const send of state.sends) if (!send || !Array.isArray(send.keys) || typeof send.email !== 'string' || !['reserved', 'sent', 'failed', 'unknown'].includes(send.status)) throw new Error('Send history is invalid; sending is blocked.');
  return { state, save: () => writeJson(file, state) };
}

export async function withLock(directory, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'run.lock'); let handle;
  try { handle = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another run or a leftover run.lock blocks this run. Check the recorded PID before removing a stale lock; do not run two copies.');
    throw error;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try { return await action(); }
  finally { await handle.close(); await unlink(lockPath); }
}

export function isSuppressed(state, lead, email) {
  const normalized = email.toLowerCase();
  return state.suppressions.some(s => s.email === normalized || (s.keys || []).some(k => lead.keys.includes(k)));
}
export function alreadyAttempted(state, lead, email) {
  const normalized = email.toLowerCase();
  return state.sends.some(s => s.email === normalized || (s.keys || []).some(k => lead.keys.includes(k)));
}

/** Keep every known business association when a shared mailbox opts out. */
export function suppressEmail(state, email) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!validEmail(normalized)) throw new Error('Supply a valid email to suppress.');
  const keys = new Set();
  const addKeys = values => {
    for (const key of values || []) if (typeof key === 'string' && key) keys.add(key);
  };
  const sameEmail = value => typeof value === 'string' && value.trim().toLowerCase() === normalized;
  for (const contact of Object.values(state.contacts)) {
    if (Array.isArray(contact?.emails) && contact.emails.some(candidate => sameEmail(candidate?.email))) addKeys(leadKeys(contact));
  }
  // An attempt may be checkpointed before its contact entry is available.
  for (const send of state.sends) if (sameEmail(send.email)) addKeys(send.keys);
  const existing = state.suppressions.filter(item => sameEmail(item.email));
  for (const item of existing) addKeys(item.keys);
  if (existing.length) {
    for (const item of existing) { item.email = normalized; item.keys = [...keys]; }
    return existing[0];
  }
  const suppression = { email: normalized, keys: [...keys], date: new Date().toISOString() };
  state.suppressions.push(suppression);
  return suppression;
}

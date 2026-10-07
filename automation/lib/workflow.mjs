import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { leadKeys, validEmail } from './leads.mjs';
import { alreadyAttempted, isSuppressed, writeJson } from './store.mjs';
import { draftEmail, rawMessage, validateSender } from './templates.mjs';

const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(finish, ms);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  function finish() { signal?.removeEventListener('abort', abort); resolve(); }
  signal?.addEventListener('abort', abort, { once: true });
});

export function eligibleContacts(leads, state) {
  const result = [], selectedEmails = new Set(), selectedKeys = new Set();
  for (const original of leads) {
    const lead = { ...original, keys: leadKeys(original) };
    if (lead.keys.some(key => selectedKeys.has(key))) continue;
    const found = state.discovery[lead.id];
    if (found?.status !== 'matched') continue;
    const emails = (found.emails || []).filter(e => e.source === 'Snov.io' && e.status === 'valid' && validEmail(e.email));
    // One address per business; shared mailboxes never receive multiple pitches.
    emails.sort((a, b) => {
      const role = email => /^(?:info|contact|hello|office|admin|enquiries|inquiries)@/i.test(email) ? 0 : 1;
      return role(a.email) - role(b.email) || a.email.localeCompare(b.email);
    });
    if (emails.some(e => alreadyAttempted(state, lead, e.email))) continue;
    for (const foundEmail of emails) {
      const email = foundEmail.email.toLowerCase();
      if (selectedEmails.has(email) || isSuppressed(state, lead, email)) continue;
      selectedEmails.add(email);
      lead.keys.forEach(key => selectedKeys.add(key));
      result.push({ ...lead, email, emailEvidence: foundEmail, companyEvidence: found.evidence });
      break;
    }
  }
  return result;
}

export async function discover({ leads, store, provider, directory, signal, onProgress = () => {} }) {
  const { state } = store;
  let processed = 0;
  for (const lead of leads) {
    if (signal?.aborted) break;
    if (provider.stats?.stoppedCode) break;
    const previous = state.discovery[lead.id];
    const databaseOnly = previous && ['no_email', 'needs_review'].includes(previous.status)
      && !(previous.searchedRoutes || []).includes('database') && !(previous.emails || []).length
      && !previous.evidence?.phoneConflict
      && typeof provider.findDatabaseEmails === 'function';
    if (previous && !databaseOnly) continue;
    onProgress(`Checking ${processed + 1} remaining business: ${lead.businessName}`);
    // A paid task with an uncertain outcome must not be resubmitted on restart.
    state.discovery[lead.id] = { status: 'in_progress', businessName: lead.businessName, emails: [], startedAt: new Date().toISOString(),
      ...(databaseOnly ? { previousResult: previous, searchedRoutes: previous.searchedRoutes || ['domain'] } : {}) };
    await store.save();
    let found;
    const onCheckpoint = async checkpoint => {
      state.discovery[lead.id].checkpoint = checkpoint;
      await store.save();
    };
    try {
      found = databaseOnly ? await provider.findDatabaseEmails(lead, { signal, onCheckpoint })
        : await provider.findEmails(lead, { signal, onCheckpoint });
    }
    catch (error) {
      state.discovery[lead.id] = { ...(error.partialResult || {}), status: 'interrupted', businessName: lead.businessName,
        emails: error.partialResult?.emails || [], errorCode: error.code || 'api_error', checkedAt: new Date().toISOString(),
        checkpoint: state.discovery[lead.id].checkpoint || null,
        ...(databaseOnly ? { previousResult: previous, searchedRoutes: previous.searchedRoutes || ['domain'] } : {}) };
      if (error.partialResult) state.contacts[lead.id] = { ...lead, emails: error.partialResult.emails || [] };
      await store.save();
      await writeJson(join(directory, 'collected-emails.json'), leads.map(l => ({ ...l, result: state.discovery[l.id] || { status: 'not_checked' } })));
      throw error;
    }
    if (!['matched', 'no_email', 'needs_review'].includes(found?.status) || !Array.isArray(found.emails)) throw new Error('Snov returned an unexpected result; this business was not marked complete.');
    state.discovery[lead.id] = { ...found, checkedAt: new Date().toISOString(), businessName: lead.businessName,
      ...(databaseOnly ? { previousResult: previous, searchedRoutes: [...new Set([...(previous.searchedRoutes || ['domain']), ...(found.searchedRoutes || ['database'])])] } : {}) };
    state.contacts[lead.id] = { ...lead, emails: found.emails };
    await store.save(); processed++;
    await writeJson(join(directory, 'collected-emails.json'), leads.map(l => ({ ...l, result: state.discovery[l.id] || { status: 'not_checked' } })));
  }
  return { processed, checked: leads.filter(l => ['matched', 'no_email', 'needs_review'].includes(state.discovery[l.id]?.status)).length,
    interrupted: leads.filter(l => ['interrupted', 'in_progress'].includes(state.discovery[l.id]?.status)).length,
    ready: eligibleContacts(leads, state).length, stats: provider.stats };
}

export async function preparePilot({ leads, store, sender, directory }) {
  validateSender(sender);
  const used = store.state.sends.length;
  if (store.state.pilot.closed || used >= 10) throw new Error('The first 10-email pilot has stopped for review. No further sends are enabled.');
  const recipients = eligibleContacts(leads, store.state).slice(0, 10 - used);
  if (!recipients.length) throw new Error('No matched, Snov-verified, unsent business emails are available. Nothing was sent.');
  const batch = { version: 1, id: randomUUID(), preparedAt: new Date().toISOString(), sender: { ...sender },
    recipients: recipients.map(lead => ({ lead, draft: draftEmail(lead, sender) })) };
  batch.digest = batchDigest(batch);
  await writeJson(join(directory, 'pilot-preview.json'), batch);
  return { count: recipients.length, file: join(directory, 'pilot-preview.json') };
}

export function batchDigest(batch) {
  return createHash('sha256').update(JSON.stringify({ version: batch.version, id: batch.id, sender: batch.sender, recipients: batch.recipients })).digest('hex');
}

export async function sendPilot({ leads, store, sender, directory, sendMessage, signal, pauseSeconds = 8, sleep = pause, onProgress = () => {} }) {
  validateSender(sender);
  const { state } = store;
  if (state.pilot.closed || state.sends.length >= 10) throw new Error('The 10-email pilot is closed for review. Sending is stopped.');
  await access(join(directory, 'gmail-auth.json')).catch(() => { throw new Error('Gmail is not authorized. Complete the Google setup first.'); });
  const batch = JSON.parse(await readFile(join(directory, 'pilot-preview.json'), 'utf8'));
  if (batch.version !== 1 || batch.digest !== batchDigest(batch) || JSON.stringify(batch.sender) !== JSON.stringify(sender)) throw new Error('The prepared batch or sender changed. Run prepare again before sending.');
  if (!Array.isArray(batch.recipients) || !batch.recipients.length || batch.recipients.length > 10) throw new Error('Prepared pilot is invalid.');
  const current = new Map(eligibleContacts(leads, state).map(l => [l.id, l]));
  const stale = batch.recipients.some(({ lead, draft }) => {
    const now = current.get(lead.id);
    return !now || now.email !== lead.email || JSON.stringify(now.keys) !== JSON.stringify(lead.keys) || JSON.stringify(draftEmail(now, sender)) !== JSON.stringify(draft);
  });
  if (stale) throw new Error('Prepared contacts are stale, suppressed, already attempted, or edited. Run prepare again.');
  const available = 10 - state.sends.length;
  if (batch.recipients.length > available) throw new Error('The prepared batch would exceed the remaining pilot limit.');
  let sent = 0;
  for (const { lead, draft } of batch.recipients) {
    if (signal?.aborted) break;
    if (alreadyAttempted(state, lead, lead.email) || isSuppressed(state, lead, lead.email)) {
      state.pilot.closed = true; state.pilot.reason = 'duplicate_or_suppressed_requires_review'; await store.save();
      throw new Error('A business was already attempted or suppressed. The batch has stopped without another send.');
    }
    const attempt = { id: randomUUID(), batchId: batch.id, leadId: lead.id, keys: lead.keys, email: lead.email,
      businessName: lead.businessName, status: 'reserved', startedAt: new Date().toISOString(), messageId: `${randomUUID()}@gmail.com` };
    // Write reservation BEFORE the irreversible send. Every outcome consumes a pilot slot.
    state.sends.push(attempt);
    await store.save();
    try {
      const receipt = await sendMessage({ raw: rawMessage(draft, sender, attempt.messageId), privateDir: directory, signal });
      if (!receipt?.id) throw Object.assign(new Error('Gmail response has no message ID.'), { code: 'send_unknown' });
      attempt.status = 'sent'; attempt.gmailMessageId = receipt.id; attempt.completedAt = new Date().toISOString();
      await store.save(); sent++;
      onProgress(`Sent ${sent}/${batch.recipients.length}: ${lead.businessName}`);
    } catch (error) {
      // A timeout may mean Gmail accepted it. Never resend automatically, even after restarting.
      attempt.status = error.code === 'send_unknown' || error.name === 'AbortError' ? 'unknown' : 'failed';
      attempt.errorCode = error.code || 'send_error'; attempt.completedAt = new Date().toISOString();
      state.pilot.closed = true; state.pilot.reason = 'send_failure_requires_review';
      await store.save();
      throw new Error(`Sending stopped after ${sent} confirmed emails. ${lead.businessName}: ${attempt.status}; check Gmail Sent before any manual recovery. No retry was made.`);
    }
    if (sent < batch.recipients.length) await sleep(Math.max(5, Math.min(60, pauseSeconds)) * 1000, signal).catch(() => {});
  }
  // Close after this first batch even if there were fewer than ten available emails.
  state.pilot.closed = true; state.pilot.reason = signal?.aborted ? 'interrupted_requires_review' : 'first_batch_complete';
  await store.save();
  await writeJson(join(directory, 'pilot-results.json'), { sentThisRun: sent, attemptedTotal: state.sends.length, closed: true, sends: state.sends });
  return { sent, attemptedTotal: state.sends.length, closed: true };
}

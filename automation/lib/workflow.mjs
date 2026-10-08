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

export function eligibleContacts(leads, state, { testEmail } = {}) {
  if (testEmail && !validEmail(testEmail)) throw new Error('The single test requires an exact, valid email address returned by Snov.');
  const result = [], selectedEmails = new Set(), selectedKeys = new Set();
  for (const original of leads) {
    const lead = { ...original, keys: leadKeys(original) };
    if (lead.keys.some(key => selectedKeys.has(key))) continue;
    const found = state.discovery[lead.id];
    if (found?.status !== 'matched') continue;
    const emails = (found.emails || []).filter(e => e.source === 'Snov.io' && validEmail(e.email)
      && (testEmail ? e.email.toLowerCase() === testEmail.toLowerCase() && ['valid', 'unknown'].includes(e.status) : e.status === 'valid'));
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
      if (testEmail) return result;
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
      const { partialResult, ...metadata } = checkpoint;
      if (partialResult) {
        if (!['matched', 'no_email', 'needs_review'].includes(partialResult.status) || !Array.isArray(partialResult.emails)) throw new Error('Snov returned an invalid partial checkpoint.');
        const snapshot = structuredClone(partialResult);
        // Completed provider results survive a hard interruption, but the
        // unfinished lookup remains ineligible and cannot be paid for again.
        state.discovery[lead.id] = { ...state.discovery[lead.id], ...snapshot, status: 'in_progress', businessName: lead.businessName, checkpoint: metadata };
        state.contacts[lead.id] = { ...lead, emails: snapshot.emails };
      } else state.discovery[lead.id].checkpoint = metadata;
      await store.save();
      if (partialResult) await writeJson(join(directory, 'collected-emails.json'), leads.map(l => ({ ...l, result: state.discovery[l.id] || { status: 'not_checked' } })));
    };
    try {
      found = databaseOnly ? await provider.findDatabaseEmails(lead, { signal, onCheckpoint })
        : await provider.findEmails(lead, { signal, onCheckpoint });
    }
    catch (error) {
      const saved = state.discovery[lead.id];
      state.discovery[lead.id] = { ...saved, ...(error.partialResult || {}), status: 'interrupted', businessName: lead.businessName,
        emails: error.partialResult?.emails || saved.emails || [], errorCode: error.code || 'api_error', checkedAt: new Date().toISOString(),
        checkpoint: saved.checkpoint || null,
        ...(databaseOnly ? { previousResult: previous, searchedRoutes: previous.searchedRoutes || ['domain'] } : {}) };
      state.contacts[lead.id] = { ...lead, emails: state.discovery[lead.id].emails };
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

export async function preparePilot({ leads, store, sender, directory, testEmail }) {
  validateSender(sender);
  if (store.state.sends.some(send => send.status === 'reserved')) throw new Error('An earlier send has an uncertain outcome. Check Gmail Sent before preparing another batch.');
  const used = store.state.sends.length;
  if (store.state.pilot.closed || used >= 10) throw new Error('The first 10-email pilot has stopped for review. No further sends are enabled.');
  const recipients = eligibleContacts(leads, store.state, { testEmail }).slice(0, testEmail ? 1 : 10 - used);
  if (!recipients.length) throw new Error('No matched, Snov-verified, unsent business emails are available. Nothing was sent.');
  const batch = { version: 1, id: randomUUID(), preparedAt: new Date().toISOString(), sender: { ...sender }, testEmail: testEmail || null,
    recipients: recipients.map(lead => ({ lead, draft: draftEmail(lead, sender) })) };
  batch.digest = batchDigest(batch);
  await writeJson(join(directory, 'pilot-preview.json'), batch);
  return { count: recipients.length, file: join(directory, 'pilot-preview.json') };
}

export function batchDigest(batch) {
  return createHash('sha256').update(JSON.stringify({ version: batch.version, id: batch.id, sender: batch.sender, recipients: batch.recipients, ...(batch.testEmail !== undefined ? { testEmail: batch.testEmail } : {}) })).digest('hex');
}

export async function sendPilot({ leads, store, sender, directory, sendMessage, signal, pauseSeconds = 8, sleep = pause, onProgress = () => {} }) {
  validateSender(sender);
  const { state } = store;
  if (state.pilot.closed || state.sends.length >= 10) throw new Error('The 10-email pilot is closed for review. Sending is stopped.');
  await access(join(directory, 'gmail-auth.json')).catch(() => { throw new Error('Gmail is not authorized. Complete the Google setup first.'); });
  const batch = JSON.parse(await readFile(join(directory, 'pilot-preview.json'), 'utf8'));
  if (batch.version !== 1 || batch.digest !== batchDigest(batch) || JSON.stringify(batch.sender) !== JSON.stringify(sender)) throw new Error('The prepared batch or sender changed. Run prepare again before sending.');
  if (!Array.isArray(batch.recipients) || !batch.recipients.length || batch.recipients.length > 10) throw new Error('Prepared pilot is invalid.');
  if (batch.testEmail && (batch.recipients.length !== 1 || batch.recipients[0].lead.email !== batch.testEmail.toLowerCase())) throw new Error('The authorized unverified test permits exactly one saved recipient.');
  const current = new Map(eligibleContacts(leads, state, { testEmail: batch.testEmail }).map(l => [l.id, l]));
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
    if (batch.testEmail) attempt.unverifiedTest = { email: batch.testEmail, originalStatus: lead.emailEvidence.status, scope: 'One explicitly requested test; regular outreach still requires verified contacts.' };
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

/** Manual exception for one newly requested alternate-address test; never reopens a batch. */
export async function sendAlternateTest({ leads, store, sender, directory, email, priorAttemptId, sendMessage, signal, onProgress = () => {} }) {
  validateSender(sender);
  const { state } = store;
  if (!validEmail(email) || typeof priorAttemptId !== 'string' || !priorAttemptId || typeof sendMessage !== 'function') throw new Error('Supply one exact saved Snov address and the original accepted test attempt ID.');
  email = email.toLowerCase();
  if (!state.pilot.closed || state.sends.length >= 10) throw new Error('The alternate test requires a closed pilot with an unused attempt slot.');
  if (state.sends.some(send => ['reserved', 'unknown'].includes(send.status))) throw new Error('An unresolved email attempt blocks any alternate test. Review Gmail Sent first.');
  if (signal?.aborted) throw new Error('The alternate test was cancelled before any email was attempted.');
  const prior = state.sends.find(send => send.id === priorAttemptId);
  if (!prior || prior.status !== 'sent' || !prior.gmailMessageId || !prior.unverifiedTest || prior.alternateTest) throw new Error('The original attempt must be a previously accepted single Snov test.');
  const original = leads.find(lead => lead.id === prior.leadId);
  if (!original) throw new Error('The original test business is not present in the saved input.');
  const lead = { ...original, keys: leadKeys(original) };
  if (!prior.keys.some(key => lead.keys.includes(key)) || prior.businessName !== lead.businessName) throw new Error('The original test business identity changed.');
  if (email === prior.email.toLowerCase()) throw new Error('The original recipient cannot be retried.');
  const found = state.discovery[lead.id];
  const evidence = found?.status === 'matched' && found.emails?.find(item => item.source === 'Snov.io'
    && item.email.toLowerCase() === email && ['valid', 'unknown'].includes(item.status));
  if (!evidence) throw new Error('The alternate address must already be a matched Snov contact for this same business.');
  if (isSuppressed(state, lead, email)) throw new Error('The business or address is suppressed; no alternate test is permitted.');
  // Only the explicitly identified original attempt is exempt from the business-repeat guard.
  const otherHistory = { ...state, sends: state.sends.filter(send => send.id !== priorAttemptId) };
  if (alreadyAttempted(otherHistory, lead, email)) throw new Error('An alternate or another attempt already exists for this business or address. No repeat is permitted.');
  await access(join(directory, 'gmail-auth.json')).catch(() => { throw new Error('Gmail is not authorized.'); });
  const recipient = { ...lead, email, emailEvidence: evidence, companyEvidence: found.evidence };
  const draft = draftEmail(recipient, sender);
  const attempt = { id: randomUUID(), batchId: randomUUID(), leadId: lead.id, keys: lead.keys, email,
    businessName: lead.businessName, status: 'reserved', startedAt: new Date().toISOString(), messageId: `${randomUUID()}@gmail.com`,
    unverifiedTest: { email, originalStatus: evidence.status, scope: 'One newly requested alternate-address test; regular outreach requires verified contacts.' },
    alternateTest: { priorAttemptId, reason: 'User reported the original recipient address was wrong and explicitly requested this other saved address.' } };
  await writeJson(join(directory, 'alternate-test-preview.json'), { preparedAt: new Date().toISOString(), recipient, draft, priorAttemptId });
  if (signal?.aborted) throw new Error('The alternate test was cancelled before any email was attempted.');
  prior.deliveryReport = { status: 'user_reported_invalid_recipient', reportedAt: new Date().toISOString() };
  // Keep the previous API acceptance intact; the user report does not confirm a provider bounce.
  state.sends.push(attempt);
  state.pilot.closed = true;
  await store.save();
  try {
    const receipt = await sendMessage({ raw: rawMessage(draft, sender, attempt.messageId), privateDir: directory, signal });
    if (!receipt?.id) throw Object.assign(new Error('Gmail response has no message ID.'), { code: 'send_unknown' });
    attempt.status = 'sent'; attempt.gmailMessageId = receipt.id; attempt.completedAt = new Date().toISOString();
    state.pilot.reason = 'alternate_test_complete_requires_review';
    await store.save();
    onProgress('Gmail accepted the one alternate-address test. Delivery still requires manual confirmation.');
  } catch (error) {
    attempt.status = error.code === 'send_unknown' || error.sendOutcome === 'unknown' || error.name === 'AbortError' ? 'unknown' : 'failed';
    attempt.errorCode = error.code || 'send_error'; attempt.completedAt = new Date().toISOString();
    state.pilot.closed = true; state.pilot.reason = 'alternate_test_failure_requires_review';
    await store.save();
    throw new Error('The alternate test stopped after one attempt. Inspect Gmail Sent; it will not be retried automatically.');
  }
  const result = { sentThisRun: 1, attemptedTotal: state.sends.length, closed: true, sends: state.sends };
  await writeJson(join(directory, 'alternate-test-results.json'), result);
  await writeJson(join(directory, 'pilot-results.json'), result);
  return { accepted: 1, attemptedTotal: state.sends.length, closed: true };
}

import { access, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { collectMaps } from './maps.mjs';
import { loadLeads } from './leads.mjs';
import { createSnovProvider } from './snov.mjs';
import { eligibleContacts, discover, preparePilot, sendPilot } from './workflow.mjs';
import { sendGmailMessage } from './gmail.mjs';
import { writeJson } from './store.mjs';

export function parseRunOptions(args) {
  const result = {};
  const numeric = { '--target': ['target', 100], '--searches': ['maxSearches', 24], '--minutes': ['maxMinutes', 60], '--scan-seconds': ['scanSeconds', 600] };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error(`Repeated option: ${argument}`);
    seen.add(argument);
    if (argument === '--dry-run') { result.dryRun = true; continue; }
    if (argument === '--test-email') {
      const email = args[++index];
      if (!email || email.startsWith('--')) throw new Error('Supply the exact saved Snov address for the single authorized test.');
      result.testEmail = email.toLowerCase(); continue;
    }
    if (!numeric[argument]) throw new Error(`Unknown workflow option: ${argument}`);
    const [key, upper] = numeric[argument], text = args[++index];
    if (!/^\d+$/.test(text || '') || Number(text) < 1 || Number(text) > upper) throw new Error(`${argument} must be an integer between 1 and ${upper}.`);
    result[key] = Number(text);
  }
  return result;
}

export function mergeLeads(...sources) {
  const seen = new Set();
  return sources.flat().filter(lead => { if (seen.has(lead.id)) return false; seen.add(lead.id); return true; });
}

/** One bounded run; no scheduler, automatic next batch, or automatic auth prompt. */
export async function runAutomation({ config, root, directory, store, baseline, runOptions = {}, signal, onProgress = () => {},
  collect = collectMaps, providerFactory = createSnovProvider, sendMessage = sendGmailMessage }) {
  if (store.state.pilot.closed || store.state.sends.length >= 10) throw new Error('The initial email pilot is closed for review. This command will not collect or send another batch until the user explicitly requests it.');
  if (store.state.sends.some(send => send.status === 'reserved')) throw new Error('An earlier email attempt has an uncertain outcome. Inspect Gmail Sent before continuing; it will not be retried.');
  if (!runOptions.dryRun) await access(join(directory, 'gmail-auth.json')).catch(() => { throw new Error('Authorize the intended Google account before starting a workflow that sends email. Use --dry-run to collect and prepare only.'); });
  if (runOptions.testEmail && !eligibleContacts(baseline, store.state, { testEmail: runOptions.testEmail }).length) throw new Error('The single test address is not a matched, unsent Snov contact in the saved input.');
  let workflow = store.state.workflow;
  if (!workflow || !['active', 'prepared'].includes(workflow.status)) {
    workflow = { version: 1, id: randomUUID(), status: 'active', stage: 'maps', startedAt: new Date().toISOString(), testEmail: runOptions.testEmail || null };
    store.state.workflow = workflow; await store.save();
  }
  if (workflow.version !== 1 || workflow.testEmail !== (runOptions.testEmail || null)) throw new Error('The unfinished workflow has a different test recipient or format. Review its saved state before starting a different run.');
  const checkpoint = async stage => { workflow.stage = stage; workflow.updatedAt = new Date().toISOString(); await store.save(); };
  const cancelled = () => { if (signal?.aborted) throw Object.assign(new Error('The workflow was stopped. Completed stages are saved and no further action will run.'), { code: 'cancelled' }); };
  let combined = baseline;
  try {
    cancelled();
    let current;
    if (workflow.mapsFile) {
      current = workflow.mapsLeadCount ? await loadLeads(workflow.mapsFile, 100) : [];
      onProgress(`Reusing ${current.length} saved Maps leads; completed collection is not repeated.`);
    } else {
      await checkpoint('maps');
      const result = await collect({ store, baseline, root, directory, signal, onProgress, ...config.maps, ...runOptions });
      current = result.leads; workflow.mapsFile = result.file; workflow.mapsLeadCount = current.length; workflow.mapsStopReason = result.stopReason;
      await checkpoint('snov');
    }
    combined = mergeLeads(baseline, current);
    cancelled();
    if (current.length) {
      const pending = current.some(lead => !store.state.discovery[lead.id]);
      if (pending) {
        await checkpoint('snov');
        const provider = await providerFactory({ credentialsFile: config.snovCredentialsFile,
          maxRequests: config.limits.maxSnovRequestsPerRun, maxCredits: config.limits.maxSnovCreditsPerRun,
          deadlineMs: config.limits.discoveryMinutes * 60000,
          onRequest: metadata => appendFile(join(directory, 'snov-request-log.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), ...metadata }) + '\n', { mode: 0o600 }) });
        workflow.discovery = await discover({ leads: current, store, provider, directory, signal, onProgress });
        if (provider.stats.stoppedCode) throw new Error(`Snov stopped at ${provider.stats.stoppedCode}; results are saved and no email was sent.`);
      }
    }
    cancelled();
    // Preserve one consolidated view, including the original 100 businesses.
    await writeJson(join(directory, 'collected-emails.json'), combined.map(lead => ({ ...lead, result: store.state.discovery[lead.id] || { status: 'not_checked' } })));
    const ready = eligibleContacts(combined, store.state, { testEmail: runOptions.testEmail });
    if (!ready.length) {
      workflow.status = 'completed'; await checkpoint(current.length ? 'no_verified_contacts' : 'no_new_leads');
      return { newMapsLeads: current.length, ready: 0, sent: 0, stopReason: workflow.stage, file: workflow.mapsFile };
    }
    await checkpoint('prepare');
    workflow.preview = await preparePilot({ leads: combined, store, sender: config.sender, directory, testEmail: runOptions.testEmail });
    workflow.status = 'prepared'; await checkpoint('prepared');
    onProgress(`Prepared ${workflow.preview.count} individual email${workflow.preview.count === 1 ? '' : 's'}; no email has been sent yet.`);
    if (runOptions.dryRun) return { newMapsLeads: current.length, ready: ready.length, sent: 0, stopReason: 'dry_run', preview: workflow.preview.file };
    cancelled();
    await checkpoint('send');
    const receipt = await sendPilot({ leads: combined, store, sender: config.sender, directory, sendMessage, signal,
      pauseSeconds: config.limits.pauseSeconds, onProgress });
    workflow.status = 'completed'; workflow.sendResult = receipt; await checkpoint('complete');
    await writeJson(join(directory, 'workflow-last-run.json'), workflow);
    return { newMapsLeads: current.length, prepared: workflow.preview.count, ...receipt, file: workflow.mapsFile, stopReason: 'first_batch_complete' };
  } catch (error) {
    workflow.errorCode = error.code || 'workflow_stopped'; workflow.stoppedAt = new Date().toISOString();
    // Keeping active/prepared state permits reuse of completed stages. Paid
    // interrupted lookups remain interrupted and are never resubmitted.
    await store.save(); await writeJson(join(directory, 'workflow-last-run.json'), workflow);
    await writeJson(join(directory, 'collected-emails.json'), combined.map(lead => ({ ...lead, result: store.state.discovery[lead.id] || { status: 'not_checked' } })));
    throw error;
  }
}

import { readFile, mkdir, access, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLeads } from './lib/leads.mjs';
import { writeJson, openStore, withLock } from './lib/store.mjs';
import { eligibleContacts, discover, preparePilot, sendPilot } from './lib/workflow.mjs';
import { validateSender } from './lib/templates.mjs';
import { parseRunOptions, mergeLeads, runAutomation } from './lib/pipeline.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const directory = join(root, '.local');
const configFile = join(directory, 'config.json');
const command = process.argv[2] || 'status';
const signalController = new AbortController();
process.once('SIGINT', () => signalController.abort(new Error('Stopped by user.')));

async function settings() {
  let config;
  try { config = JSON.parse(await readFile(configFile, 'utf8')); }
  catch { throw new Error('Run init first, then edit automation/.local/config.json.'); }
  validateSender(config.sender, { requirePostalAddress: false });
  const bounds = { maxBusinesses: [1, 100], maxSnovRequestsPerRun: [1, 500], maxSnovCreditsPerRun: [1, 50], discoveryMinutes: [1, 30], pilotEmails: [10, 10], pauseSeconds: [5, 60] };
  for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
    if (key === 'maxSnovCreditsPerRun' && config.limits[key] === undefined) config.limits[key] = 50;
    if (!Number.isFinite(config.limits?.[key]) || config.limits[key] < minimum || config.limits[key] > maximum || !Number.isInteger(config.limits[key])) throw new Error(`Invalid limit: ${key}. Allowed ${minimum}–${maximum}.`);
  }
  for (const key of ['leadsFile', 'gmailClientFile', 'snovCredentialsFile']) if (!config[key] || typeof config[key] !== 'string') throw new Error(`Missing config value: ${key}`);
  return { ...config, leadsFile: resolve(directory, config.leadsFile), gmailClientFile: resolve(directory, config.gmailClientFile), snovCredentialsFile: resolve(directory, config.snovCredentialsFile) };
}

async function init() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = [
    [configFile, JSON.parse(await readFile(join(root, 'config.example.json'), 'utf8'))],
    [join(directory, 'snov-credentials.json'), { clientId: '', clientSecret: '' }]
  ];
  for (const [file, contents] of files) {
    try { await access(file); console.log(`Kept existing ${file}`); }
    catch { await writeJson(file, contents); console.log(`Created ${file}`); }
  }
  console.log('Fill your physical postal address in config.json and API credentials in snov-credentials.json. Keep these files local.');
}

async function status(config, leads, store) {
  const has = async file => access(file).then(() => true, () => false);
  let snovReady = false;
  try { const c = JSON.parse(await readFile(config.snovCredentialsFile, 'utf8')); snovReady = Boolean((c.clientId || c.client_id) && (c.clientSecret || c.client_secret)); } catch {}
  console.log(JSON.stringify({ sourceBusinesses: leads.length,
    checkedInSnov: leads.filter(l => ['matched', 'no_email', 'needs_review'].includes(store.state.discovery[l.id]?.status)).length,
    interruptedLookups: leads.filter(l => ['interrupted', 'in_progress'].includes(store.state.discovery[l.id]?.status)).length,
    sendableUnsentEmails: eligibleContacts(leads, store.state).length, attempted: store.state.sends.length,
    confirmedSent: store.state.sends.filter(s => s.status === 'sent').length, pilotClosed: store.state.pilot.closed,
    postalAddressConfigured: Boolean(config.sender.postalAddress?.trim()), snovCredentialsConfigured: snovReady,
    googleClientConfigured: await has(config.gmailClientFile), gmailAuthorized: await has(join(directory, 'gmail-auth.json')) }, null, 2));
}

async function run() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required.');
  if (command === 'init') return init();
  if (!['status', 'setup', 'collect', 'run', 'discover', 'prepare', 'authorize', 'send', 'suppress'].includes(command)) throw new Error('Commands: init, setup, collect, run, status, discover, prepare, authorize, send, suppress <email>.');
  const config = await settings();
  let leads = await loadLeads(config.leadsFile, config.limits.maxBusinesses);
  return withLock(directory, async () => {
    const store = await openStore(directory);
    if (['status', 'prepare', 'send'].includes(command) && store.state.workflow?.mapsFile && store.state.workflow.mapsLeadCount) leads = mergeLeads(leads, await loadLeads(store.state.workflow.mapsFile, 100));
    if (command === 'setup') {
      const { startSetup } = await import('./lib/setup.mjs');
      return startSetup({ directory, configFile, config, signal: signalController.signal, onUrl: url => console.log(`Open this local setup page in Edge yourself:\n${url}`) });
    }
    if (command === 'status') return status(config, leads, store);
    if (command === 'collect' || command === 'run') {
      const options = parseRunOptions(process.argv.slice(3));
      const workflowAbort = new AbortController();
      const workflowSignal = AbortSignal.any([signalController.signal, workflowAbort.signal]);
      const timeout = setTimeout(() => workflowAbort.abort(new Error('The workflow reached its 90-minute limit.')), 90 * 60000);
      const hardStop = setTimeout(() => { console.error('The workflow exceeded its shutdown deadline. Progress was checkpointed; inspect the recorded lock PID before recovery.'); process.exit(1); }, 90 * 60000 + 20000);
      try {
        if (command === 'collect') {
          if (options.testEmail || options.dryRun) throw new Error('collect never sends or searches Snov; use run for workflow options.');
          const { collectMaps } = await import('./lib/maps.mjs');
          const result = await collectMaps({ store, baseline: leads, root: dirname(root), directory, signal: workflowSignal, onProgress: console.log, ...config.maps, ...options });
          const { leads: found, ...summary } = result; console.log(JSON.stringify({ newMapsLeads: found.length, ...summary }, null, 2));
        } else console.log(JSON.stringify(await runAutomation({ config, root: dirname(root), directory, store, baseline: leads, runOptions: options, signal: workflowSignal, onProgress: console.log }), null, 2));
      } finally { clearTimeout(timeout); clearTimeout(hardStop); }
      return;
    }
    if (command === 'discover') {
      const { createSnovProvider } = await import('./lib/snov.mjs');
      const provider = await createSnovProvider({ credentialsFile: config.snovCredentialsFile, maxRequests: config.limits.maxSnovRequestsPerRun,
        maxCredits: config.limits.maxSnovCreditsPerRun, deadlineMs: config.limits.discoveryMinutes * 60_000,
        onRequest: metadata => appendFile(join(directory, 'snov-request-log.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), ...metadata }) + '\n', { mode: 0o600 }) });
      try { console.log(JSON.stringify(await discover({ leads, store, provider, directory, signal: signalController.signal, onProgress: console.log }), null, 2)); }
      finally { await store.save(); }
    } else if (command === 'prepare') {
      const options = parseRunOptions(process.argv.slice(3));
      if (Object.keys(options).some(key => key !== 'testEmail')) throw new Error('prepare accepts only --test-email for the one explicitly authorized test.');
      console.log(JSON.stringify(await preparePilot({ leads, store, sender: config.sender, directory, testEmail: options.testEmail }), null, 2));
    } else if (command === 'authorize') {
      validateSender(config.sender);
      const { authorizeGmail } = await import('./lib/gmail.mjs');
      console.log('Select craftedwebstudio@gmail.com in Google. Send-only permission does not let this script read your replies.');
      const result = await authorizeGmail({ clientFile: config.gmailClientFile, privateDir: directory, expectedEmail: config.sender.email,
        signal: signalController.signal, loginHint: config.sender.email, onAuthorizationUrl: url => console.log(`Open this Google permission link yourself:\n${url}`) });
      console.log(`Gmail authorization saved for ${result.email}. Permission covers sending and identifying this account, with no inbox access.`);
    } else if (command === 'send') {
      const { sendGmailMessage } = await import('./lib/gmail.mjs');
      console.log(JSON.stringify(await sendPilot({ leads, store, sender: config.sender, directory, sendMessage: sendGmailMessage,
        signal: signalController.signal, pauseSeconds: config.limits.pauseSeconds, onProgress: console.log }), null, 2));
    } else if (command === 'suppress') {
      const { validEmail, leadKeys } = await import('./lib/leads.mjs');
      const email = (process.argv[3] || '').trim().toLowerCase();
      if (!validEmail(email)) throw new Error('Supply a valid email to suppress.');
      const matching = Object.values(store.state.contacts).find(c => c.emails?.some(e => e.email.toLowerCase() === email));
      const keys = matching ? leadKeys(matching) : [];
      if (!store.state.suppressions.some(s => s.email === email)) store.state.suppressions.push({ email, keys, date: new Date().toISOString() });
      await store.save(); console.log('Address suppressed from future outreach.');
    }
  });
}

await run().catch(error => { console.error(error.message || 'Stopped due to an error.'); process.exitCode = 1; });

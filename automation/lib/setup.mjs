import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeJson } from './store.mjs';
import { validateSender } from './templates.mjs';

const template = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lead Finder setup</title>
<style>body{font:16px system-ui;margin:40px auto;max-width:680px;padding:0 20px;color:#173b31;background:#f5f8f6}main{background:white;padding:28px;border-radius:14px}h1{margin-top:0}label{display:block;margin:20px 0 6px;font-weight:600}input,textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid #a6bdb4;border-radius:6px;font:inherit}button{padding:12px 20px;margin-top:24px;background:#21785f;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer}small{display:block;color:#52685e;margin:6px 0}#result{white-space:pre-wrap}a{color:#216c56}</style>
<main><h1>Lead Finder: first email batch</h1><p>Sender: <strong>Afif &lt;craftedwebstudio@gmail.com&gt;</strong></p><p>Save these settings on this computer. After searching the existing 100 US businesses, the workflow will send at most 10 individual emails and stop for your review.</p>
<form id="settings"><label for="postal">Your physical postal address</label><textarea id="postal" rows="3" required placeholder="Street, city, postal code, country"></textarea><small>Your current home address is acceptable. It will appear in outgoing sales emails. Use a valid registered PO box if you prefer privacy.</small>
<label for="clientId">Snov Client ID</label><input id="clientId" autocomplete="off"><label for="clientSecret">Snov Client Secret</label><input id="clientSecret" type="password" autocomplete="off"><small>Copy these from <a href="https://app.snov.io/account/api" target="_blank" rel="noreferrer">Snov API settings</a>. They are stored locally and excluded from Git. Leave both empty to keep credentials already saved.</small>
<label for="google">Google desktop OAuth client JSON (optional for now)</label><input id="google" type="file" accept="application/json,.json"><small>Download this from your own Google Cloud project after enabling Gmail API and creating a Desktop app OAuth client. Then use the authorize command to approve Google permission.</small>
<button>Save local settings</button><p id="result" role="status"></p></form></main>
<script>
const token=__TOKEN__;
document.getElementById('settings').addEventListener('submit',async e=>{
  e.preventDefault();
  const result=document.getElementById('result');
  const button=document.querySelector('button');
  result.textContent='Saving…'; button.disabled=true;
  let googleClient=null;
  const file=document.getElementById('google').files[0];
  if(file){
    try{googleClient=JSON.parse(await file.text());}
    catch{result.textContent='The selected Google file is not valid JSON. Leave that optional field empty for now, or select the downloaded Desktop OAuth JSON.';button.disabled=false;return;}
  }
  const data={postalAddress:document.getElementById('postal').value,clientId:document.getElementById('clientId').value,clientSecret:document.getElementById('clientSecret').value,googleClient};
  let response;
  try{
    response=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':token},body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});
  }catch{
    result.textContent='The local setup session is no longer reachable. Ask me to restart it, then click Save again; keep this tab open to retain your entries.';button.disabled=false;return;
  }
  let output;
  try{output=await response.json();}
  catch{result.textContent='The setup server returned an unexpected response. Keep your entries in this tab and ask me to check the connection.';button.disabled=false;return;}
  result.textContent=output.message||'The setup server could not save the settings.';
  if(response.ok){document.getElementById('clientSecret').value='';document.getElementById('clientId').value='';}
  else{button.disabled=false;}
});
</script></html>`;

export async function startSetup({ directory, configFile, config, signal, onUrl, timeoutMs = 900_000 }) {
  const sessionFile = join(directory, 'setup-session.json');
  let session;
  try { session = JSON.parse(await readFile(sessionFile, 'utf8')); } catch {}
  const resume = session?.version === 1 && /^[a-f0-9]{64}$/.test(session.token) && Number.isInteger(session.port) && session.port > 0 && session.port <= 65535;
  const token = resume ? session.token : randomBytes(32).toString('hex');
  let origin;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const problem = (status, message) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.writeHead(status).end(JSON.stringify({ message })); };
    try {
      if (req.headers.host !== new URL(origin).host) { problem(403, 'This setup request has the wrong local address. Use the setup link provided in this chat.'); return; }
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === token) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(template.replace('__TOKEN__', JSON.stringify(token))); return;
      }
      const submittedToken = req.headers['x-setup-token'] || '';
      if (req.method !== 'POST' || url.pathname !== '/save' || req.headers.origin !== origin || typeof submittedToken !== 'string' || !/^[a-f0-9]{64}$/.test(submittedToken) || !timingSafeEqual(Buffer.from(submittedToken), Buffer.from(token))) { problem(403, 'This setup session could not be verified. Keep your entries in this tab and ask me to restart the setup session.'); return; }
      if (req.headers['content-type'] !== 'application/json') { problem(415, 'The setup request was not in the expected format. Reload the setup page and try again.'); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('Settings are too large.'); chunks.push(chunk); }
      const settings = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const sender = { ...config.sender, postalAddress: String(settings.postalAddress || '').replace(/\s*\r?\n\s*/g, ', ').trim() };
      validateSender(sender);
      const clientId = String(settings.clientId || '').trim(), clientSecret = String(settings.clientSecret || '').trim();
      let credentials;
      if (clientId || clientSecret) {
        if (!clientId || !clientSecret || /\s/.test(clientId) || /\s/.test(clientSecret)) throw new Error('Enter both Snov API credentials without spaces.');
        credentials = { clientId, clientSecret };
      } else {
        try { credentials = JSON.parse(await readFile(join(directory, 'snov-credentials.json'), 'utf8')); } catch {}
        if (!(credentials?.clientId || credentials?.client_id) || !(credentials?.clientSecret || credentials?.client_secret)) throw new Error('Add your Snov Client ID and Client Secret for the first setup.');
      }
      if (settings.googleClient) {
        const installed = settings.googleClient.installed;
        if (!installed?.client_id?.endsWith('.apps.googleusercontent.com') || !installed.client_secret || installed.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' || installed.token_uri !== 'https://oauth2.googleapis.com/token') throw new Error('Upload a Google Desktop app OAuth client JSON, not a web client or service-account key.');
        await writeJson(join(directory, 'google-desktop-client.json'), settings.googleClient);
      }
      const current = JSON.parse(await readFile(configFile, 'utf8'));
      current.sender = sender;
      await writeJson(join(directory, 'snov-credentials.json'), credentials);
      await writeJson(configFile, current);
      res.setHeader('Content-Type', 'application/json');
      res.once('finish', () => finish('saved'));
      res.end(JSON.stringify({ message: 'Saved locally. You can close this page. No emails were sent. Run discovery next; Google permission comes before sending.' }));
    } catch (error) { problem(400, error instanceof SyntaxError ? 'Invalid JSON file.' : error.message); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(resume ? session.port : 0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timeout = setTimeout(() => finish('timeout'), Math.min(900_000, timeoutMs));
  const abort = () => finish('stopped');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await writeJson(sessionFile, { version: 1, port: server.address().port, token });
    await onUrl(`${origin}/?token=${token}`);
    return await finished;
  }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

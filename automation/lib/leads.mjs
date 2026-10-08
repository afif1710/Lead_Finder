import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export function parseCsv(source) {
  source = source.replace(/^\uFEFF/, '');
  const rows = []; let row = [], value = '', quoted = false, closed = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else value += c;
      continue;
    }
    if (c === '"') {
      if (value || closed) throw new Error('Malformed CSV quote.');
      quoted = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(value); value = ''; closed = false;
      if (c !== ',') {
        if (c === '\r' && source[i + 1] === '\n') i++;
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      }
    } else {
      if (closed) throw new Error('Unexpected content after a CSV quote.');
      value += c;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  if (value || closed || row.length) { row.push(value); rows.push(row); }
  return rows;
}

export function normalizedName(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:llc|inc|incorporated|ltd|limited|corp|corporation)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
export function phoneDigits(value) {
  const digits = String(value).replace(/\D/g, '');
  return digits.length === 10 ? `1${digits}` : digits;
}
export function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(value) && !value.includes('..');
}
export function leadKeys(lead) {
  const keys = [`phone:${phoneDigits(lead.phone)}`, `name:${normalizedName(lead.businessName)}|${lead.location.toLowerCase().trim()}`];
  try {
    const url = new URL(lead.mapsUrl);
    const encoded = decodeURIComponent(url.pathname);
    // Detail URLs can carry the original search as an earlier !1s token.
    // Prefer the actual place identity, as the extension does, rather than
    // treating a shared query as a duplicate business.
    const actual = encoded.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)(?:!|$)/i)?.[1];
    const tokens = [...encoded.matchAll(/!1s([^!]+)/g)];
    const fallback = tokens.reverse().find(token =>
      !encoded.slice(0, token.index).endsWith('!2m1') && !/[\s+]/.test(token[1]))?.[1];
    const cid = url.searchParams.get('cid');
    if (cid && /^\d+$/.test(cid)) keys.push(`place:cid:${cid}`);
    else if (actual || fallback) keys.push(`place:${actual || fallback}`);
  } catch { /* Phone and name/location remain available. */ }
  return keys;
}
export function leadId(lead) { return createHash('sha256').update(leadKeys(lead)[0]).digest('hex').slice(0, 24); }

export async function loadLeads(file, maximum = 100) {
  const source = await readFile(file, 'utf8');
  if (Buffer.byteLength(source) > 2_000_000) throw new Error('Lead CSV exceeds the 2 MB input limit.');
  const [headers, ...rows] = parseCsv(source);
  if (!headers) throw new Error('The lead CSV is empty.');
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate CSV headers.');
  const required = ['business name', 'phone number', 'category', 'location', 'Google Maps URL', 'website status'];
  if (required.some(h => !headers.includes(h))) throw new Error('Use the processed USA lead CSV; required columns are missing.');
  const leads = [], seen = new Set();
  for (const row of rows) {
    if (row.length !== headers.length) throw new Error('CSV row has the wrong number of columns.');
    const values = Object.fromEntries(headers.map((h, i) => [h, row[i].trim()]));
    if (values['website status'] !== 'No website listed on Google Maps') throw new Error('Input contains a lead whose missing Maps website was not confirmed.');
    const phone = phoneDigits(values['phone number']);
    if (!/^1[2-9]\d{2}[2-9]\d{6}$/.test(phone) || !/\b(?:USA|United States)\b/i.test(values.location)) throw new Error('Input contains an invalid phone or a location outside the USA.');
    const lead = { businessName: values['business name'], phone: values['phone number'], category: values.category, location: values.location,
      address: values.address || '', profession: values.profession || values.category, mapsUrl: values['Google Maps URL'], checkedDate: values['checked date'] || '' };
    if ([lead.businessName, lead.category, lead.location].some(v => !v || /[\r\n\u0000-\u001f]/.test(v))) throw new Error('Lead fields contain missing or unsafe text.');
    if (seen.has(phone)) continue;
    seen.add(phone); lead.id = leadId(lead); leads.push(lead);
    if (leads.length > maximum) throw new Error(`Input exceeds the ${maximum}-business cap. Split it into an explicit new source file.`);
  }
  if (!leads.length) throw new Error('No leads in the source CSV.');
  return leads;
}

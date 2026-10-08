import test from 'node:test';
import assert from 'node:assert/strict';
import { suppressEmail } from '../lib/store.mjs';
import { eligibleContacts } from '../lib/workflow.mjs';
import { leadKeys } from '../lib/leads.mjs';

const lead = (id, phone) => ({ id, businessName: `Fixture Fence ${id}`, phone, category: 'Fence contractor',
  location: 'Chicago, IL, USA', mapsUrl: `https://www.google.com/maps/place/fixture/data=!1s${id}` });
const mailbox = email => ({ email, source: 'Snov.io', status: 'valid' });
const state = () => ({ contacts: {}, discovery: {}, sends: [], suppressions: [] });

test('a shared mailbox opt-out suppresses every associated business and its alternate mailbox', () => {
  const saved = state(), first = lead('first', '+1 312 555 1000'), second = lead('second', '+1 312 555 2000');
  saved.contacts.first = { ...first, emails: [mailbox('shared@example.com')] };
  saved.contacts.second = { ...second, emails: [mailbox('SHARED@example.com'), mailbox('another@example.com')] };
  saved.discovery.first = { status: 'matched', emails: saved.contacts.first.emails };
  saved.discovery.second = { status: 'matched', emails: saved.contacts.second.emails };
  const suppression = suppressEmail(saved, ' SHARED@example.com ');
  assert.equal(suppression.email, 'shared@example.com');
  assert.deepEqual(new Set(suppression.keys), new Set([...leadKeys(first), ...leadKeys(second)]));
  assert.equal(eligibleContacts([first, second], saved).length, 0);
});

test('repeated suppression merges new associations while retaining existing keys and date', () => {
  const saved = state(), first = lead('first', '+1 312 555 1000'), second = lead('second', '+1 312 555 2000');
  saved.contacts.first = { ...first, emails: [mailbox('shared@example.com')] };
  const firstSuppression = suppressEmail(saved, 'shared@example.com');
  const date = firstSuppression.date;
  saved.contacts = { second: { ...second, emails: [mailbox('shared@example.com')] } };
  suppressEmail(saved, 'shared@example.com');
  assert.equal(saved.suppressions.length, 1);
  assert.equal(saved.suppressions[0].date, date);
  assert.deepEqual(new Set(saved.suppressions[0].keys), new Set([...leadKeys(first), ...leadKeys(second)]));
});

test('send reservations supply business keys when the contact lookup is unavailable', () => {
  const saved = state(), first = lead('first', '+1 312 555 1000');
  saved.sends.push({ email: 'SHARED@example.com', keys: leadKeys(first), status: 'reserved' });
  suppressEmail(saved, 'shared@example.com');
  saved.discovery.first = { status: 'matched', emails: [mailbox('new@example.com')] };
  assert.deepEqual(saved.suppressions[0].keys, leadKeys(first));
  assert.equal(eligibleContacts([first], saved).length, 0);
});

test('an unassociated mailbox is suppressed without blocking unrelated businesses', () => {
  const saved = state(), first = lead('first', '+1 312 555 1000');
  saved.contacts.first = { ...first, emails: [mailbox('office@example.com')] };
  saved.discovery.first = { status: 'matched', emails: saved.contacts.first.emails };
  assert.deepEqual(suppressEmail(saved, 'different@example.com').keys, []);
  assert.equal(eligibleContacts([first], saved).length, 1);
  const before = structuredClone(saved.suppressions);
  assert.throws(() => suppressEmail(saved, 'invalid\n@example.com'), /valid email/);
  assert.deepEqual(saved.suppressions, before);
});

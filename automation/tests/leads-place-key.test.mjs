import test from 'node:test';
import assert from 'node:assert/strict';
import { leadKeys } from '../lib/leads.mjs';

const lead = mapsUrl => ({ businessName: 'Fixture Fence', phone: '+1 212 555 1231', location: 'New York, NY, USA', mapsUrl });
const placeKeys = url => leadKeys(lead(url)).filter(key => key.startsWith('place:'));

test('the original Maps search is not mistaken for a shared place identity', () => {
  const first = 'https://www.google.com/maps/place/First/data=!1m2!2m1!1sfence+contractors+in+Knoxville!3m6!1s0x123:0x456!8m2';
  const second = first.replace('/First/', '/Second/').replace('0x123:0x456', '0x789:0xabc');
  assert.deepEqual(placeKeys(first), ['place:0x123:0x456']);
  assert.deepEqual(placeKeys(second), ['place:0x789:0xabc']);
  assert.deepEqual(placeKeys(first.replace('!1m2!2m1!1sfence+contractors+in+Knoxville!3m6', '')), placeKeys(first));
});

test('actual hexadecimal place identity has priority over query and trailing metadata tokens', () => {
  assert.deepEqual(placeKeys('https://www.google.com/maps/place/First/data=!1squery!1s0x123:0x456!1smetadata'), ['place:0x123:0x456']);
});

test('last-token place IDs and numeric CID links retain stable identity across tracking changes', () => {
  assert.deepEqual(placeKeys('https://www.google.com/maps/place/First/data=!2m1!1sroofers!3m6!1sChIJ_Ab-1234'), ['place:ChIJ_Ab-1234']);
  assert.deepEqual(placeKeys('https://www.google.com/maps/place/First/data=!1sfixtureBranch?hl=en'), ['place:fixtureBranch']);
  assert.deepEqual(placeKeys('https://www.google.com/maps?cid=123456789&rclk=1'), ['place:cid:123456789']);
});

test('query-only or malformed URLs do not create a place identity', () => {
  for (const url of ['https://www.google.com/maps/place/First/data=!2m1!1sroofers',
    'https://www.google.com/maps/place/First/data=!1sroofers+in+Knoxville',
    'https://www.google.com/maps/place/First/data=!1sroofers%20in%20Knoxville', 'not a URL']) {
    assert.deepEqual(placeKeys(url), []);
  }
});

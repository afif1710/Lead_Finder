const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { environment, root } = require('./helpers.cjs');
test('phone formatting handles UAE, UK, Italy, Bangladesh, and shared calling codes', () => {
  const { app, dom } = environment();
  for (const [local, code, full] of [
    ['050 706 4831', '971', '+971 50 706 4831'], ['020 7946 0958', '44', '+44 20 7946 0958'],
    ['06 6982', '39', '+39 06 6982'], ['01712 345678', '880', '+880 1712 345678'],
    ['(212) 555-0123', '1', '+1 212 555 0123']
  ]) {
    assert.equal(app.phone.format(local, { callingCode: code }).value, full);
    const inferred = app.phone.infer(local, full);
    assert.equal(inferred.callingCode, code);
    assert.equal(app.phone.format(local, inferred).value, full);
  }
  assert.equal(app.phone.infer('06 6982', '+39 06 6982').dropPrefix, '');
  assert.equal(app.phone.infer('020 7946 0958', '+44 20 7946 0958').dropPrefix, '0');
  dom.window.close();
});
test('phones preserve existing international values and ambiguous local numbers', () => {
  const { app, dom } = environment();
  for (const phone of ['+971 50 706 4831', '00971 50 706 4831', '']) assert.equal(app.phone.format(phone, null).value, phone);
  assert.equal(app.phone.format('050 706 4831', null).unresolved, true);
  assert.equal(app.phone.format('123', { callingCode: '971' }).value, '123');
  assert.equal(app.phone.infer('050 111 1111', '+971 50 706 4831'), null);
  assert.equal(app.phone.format('٠٥٠ ٧٠٦ ٤٨٣١', { callingCode: '971' }).value, '+971 50 706 4831');
  assert.throws(() => app.phone.code('+999'), /not recognized/);
  assert.throws(() => app.phone.code('+971 50'), /country code/);
  assert.equal(app.phone.code('971'), '971');
  dom.window.close();
});
test('search splitting and link identity preserve separate branches', () => {
  const { app, dom } = environment();
  assert.equal(app.utils.splitSearch('interior designer in Dubai').profession, 'interior designer');
  assert.equal(app.utils.splitSearch('interior designer in Dubai').city, 'Dubai');
  assert.equal(app.utils.splitSearch('مصمم في دبي').city, 'دبي');
  assert.equal(app.utils.splitSearch('painter').city, '');
  assert.equal(app.utils.placeKey('https://www.google.com/maps/place/A/data=!4m1!1sbranch1?hl=en&rclk=1'), app.utils.placeKey('https://www.google.ae/maps/place/B/data=!4m1!1sbranch1?hl=ar'));
  assert.notEqual(app.utils.placeKey('/maps/place/A/data=!1sbranch1'), app.utils.placeKey('/maps/place/A/data=!1sbranch2'));
  assert.equal(app.utils.placeKey('/maps/place/A/data=!1squery!3m6!1s0x123:0x456!8m2'), app.utils.placeKey('/maps/place/A/data=!1s0x123:0x456!8m2'));
  dom.window.close();
});
test('CSV has exact six columns, UTF-8 BOM, CRLF, escaping, and safe formulas', () => {
  const { app, dom } = environment();
  const output = app.csv.create([{ name: 'دبي, "Design"\nStudio', category: '=HYPERLINK("bad")', phone: '+971 50 706 4831', website: 'https://instagram.com/design?q=a&x=%2F' }], { profession: 'interior designer', city: 'Dubai' });
  assert.ok(output.startsWith('\uFEFF"business name","category","phone number","website","profession","city"\r\n'));
  assert.ok(output.includes('"دبي, ""Design""\nStudio"'));
  assert.ok(output.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(output.includes('"+971 50 706 4831"'));
  assert.ok(output.includes('https://instagram.com/design?q=a&x=%2F'));
  assert.equal(app.csv.filename({ profession: 'interior designer', city: 'Dubai' }, new Date(2026, 9, 5)), 'interior-designer_dubai_2026-10-05.csv');
  assert.equal(app.csv.filename({ profession: '../مصمم:<>', city: 'دبي / الإمارات' }, new Date(2026, 9, 5)), 'مصمم_دبي-الإمارات_2026-10-05.csv');
  const filtered = app.csv.create([{ name: 'A', website: 'https://facebook.com/a' }, { name: 'B', website: '' }], { onlyWithoutWebsite: true });
  assert.ok(!filtered.includes('"A"'));
  assert.ok(filtered.includes('"B"'));
  dom.window.close();
});
test('realistic cards extract local phone and category without English UI labels', () => {
  const { app, dom, document } = environment(`<div role="feed"><div role="article"><a aria-label="فرع دبي" href="/maps/place/A/data=!1sone"></a><div class="W4Efsd"><div class="W4Efsd"><span><span>مصمم داخلي</span></span><span> · 123 Road</span></div><div class="W4Efsd"><span><span style="color:green">مفتوح · 9</span></span><span><span class="UsdlK">050 706 4831</span></span></div></div><a data-value="Website" aria-label="موقع" href="https://facebook.com/test?x=%2F">موقع</a></div></div>`);
  const feed = app.extractor.findFeed();
  const card = app.extractor.extractCard(app.extractor.cards(feed)[0]);
  assert.equal(card.name, 'فرع دبي');
  assert.equal(card.category, 'مصمم داخلي');
  assert.equal(card.rawPhone, '050 706 4831');
  assert.equal(card.website, 'https://facebook.com/test?x=%2F');
  assert.equal(card.needsDetail, false);
  document.querySelector('[role="article"]').setAttribute('data-is-ad', 'true');
  assert.equal(app.extractor.extractCard(app.extractor.cards(feed)[0]).ad, true);
  dom.window.close();
});
test('website redirects preserve target, and unknown website actions need details', () => {
  const { app, dom, document } = environment('<a id="redirect" href="https://www.google.com/url?q=https%3A%2F%2Finstagram.com%2FA%3Fx%3D%252F"></a><div role="feed"><div role="article"><a aria-label="A" href="/maps/place/A/data=!1sone"></a><span data-category="Painter"></span><button data-value="Website">موقع</button></div></div>');
  assert.equal(app.extractor.websiteURL(document.querySelector('#redirect')), 'https://instagram.com/A?x=%2F');
  const record = app.extractor.extractCard(app.extractor.cards(app.extractor.findFeed())[0]);
  assert.equal(record.websiteAmbiguous, true);
  assert.equal(record.needsDetail, true);
  dom.window.close();
});
test('abortable waits cancel promptly', async () => {
  const { app, dom } = environment();
  const controller = new dom.window.AbortController();
  const waiting = app.utils.sleep(10000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  dom.window.close();
});
test('actual Maps phone labels, short national numbers, and tel targets produce readable numbers', () => {
  const { app, dom, document } = environment('<button id="label" data-item-id="phone:tel:+971553573290" aria-label="هاتف: +971 55 357 3290">&#xe0b0; +971 55 357 3290</button><a id="target" href="tel:+971553573290">اتصل</a><span class="UsdlK">06 6982</span>');
  assert.equal(app.extractor.phoneValue(document.querySelector('#label')), '+971 55 357 3290');
  assert.equal(app.extractor.phoneValue(document.querySelector('#target')), '+971 55 357 3290');
  assert.equal(app.extractor.phoneValue(document.querySelector('.UsdlK')), '06 6982');
  dom.window.close();
});
test('current live Maps ad marker is recognized without localized ad text', () => {
  const { app, dom, document } = environment('<div id="ad"><h1 aria-label="إعلان"><button data-url="https://adssettings.google.com/aboutthisad?source=maps">⋮</button></h1></div><div id="organic"></div>');
  assert.equal(app.extractor.isAd(document.querySelector('#ad')), true);
  assert.equal(app.extractor.isAd(document.querySelector('#organic')), false);
  dom.window.close();
});
test('compact Belfast restaurant cards are organic and need contact details', () => {
  const { app, dom, document } = environment('<div role="feed"><div role="article" class="Nv2PK THOPZb CpccDe"><a aria-label="Roam" href="/maps/place/Roam/data=!1s0x48610918351999ff:0xf1b387298bf896c6"></a><div class="W4Efsd"><span><span>Irish restaurant</span></span></div></div></div>');
  const item = app.extractor.cards(app.extractor.findFeed())[0];
  assert.equal(app.extractor.isAd(item.card), false);
  const record = app.extractor.extractCard(item);
  assert.equal(record.name, 'Roam');
  assert.equal(record.category, 'Irish restaurant');
  assert.equal(record.needsDetail, true);
  assert.equal(record.websiteNeedsConfirmation, true);
  assert.equal(record.websiteAmbiguous, true);
  const adBadge = document.createElement('button');
  adBadge.dataset.url = 'https://adssettings.google.com/aboutthisad?source=maps';
  item.card.append(adBadge);
  assert.equal(app.extractor.isAd(item.card), true);
  dom.window.close();
});
test('a compact card with a website still fetches a hidden phone without becoming a no-website lead', () => {
  const { app, dom } = environment('<div role="feed"><div role="article" class="Nv2PK THOPZb CpccDe"><a aria-label="Restaurant" href="/maps/place/Restaurant/data=!1srestaurant"></a><span data-category="Restaurant"></span><a data-item-id="authority" href="https://restaurant.example/"></a></div></div>');
  const record = app.extractor.extractCard(app.extractor.cards(app.extractor.findFeed())[0]);
  assert.equal(record.website, 'https://restaurant.example/');
  assert.equal(record.websiteAmbiguous, false);
  assert.equal(record.websiteNeedsConfirmation, false);
  assert.equal(record.needsDetail, true);
  dom.window.close();
});
test('contact detail readiness waits beyond the heading and category', () => {
  const { app, dom, document } = environment('<div role="main"><h1>Restaurant</h1><button data-item-id="category">Restaurant</button></div>');
  assert.equal(app.extractor.details('Restaurant').contactsReady, false);
  const address = document.createElement('button');
  address.dataset.itemId = 'address';
  document.querySelector('[role="main"]').append(address);
  assert.equal(app.extractor.details('Restaurant').contactsReady, true);
  dom.window.close();
});
test('a later compact rendering requires confirmation without undoing a completed detail check', () => {
  const { app, dom, document } = environment('<div role="feed"><div role="article"><a aria-label="Restaurant" href="/maps/place/Restaurant/data=!1srestaurant"></a><span data-category="Restaurant"></span></div></div>');
  dom.window.eval(fs.readFileSync(path.join(root, 'src/runner.js'), 'utf8'));
  let withoutWebsite;
  const runner = new app.Runner({ counts: (_, without) => { withoutWebsite = without; } });
  runner.ads = new Set();
  const feed = app.extractor.findFeed();
  runner.collect(feed);
  assert.equal(withoutWebsite, 1);
  document.querySelector('[role="article"]').className = 'Nv2PK THOPZb CpccDe';
  const [{ record }] = runner.collect(feed);
  assert.equal(record.needsDetail, true);
  assert.equal(record.websiteNeedsConfirmation, true);
  assert.equal(withoutWebsite, 0);
  record.detailChecked = true;
  record.needsDetail = record.websiteNeedsConfirmation = record.websiteAmbiguous = false;
  runner.collect(feed);
  assert.equal(withoutWebsite, 1);
  assert.equal(record.websiteAmbiguous, false);
  dom.window.close();
});
test('detail navigation rejects a recycled link belonging to another business', async () => {
  const { app, dom, document } = environment('<div role="feed"><div role="article"><a href="/maps/place/Recycled/data=!1sother"></a></div></div>');
  dom.window.eval(fs.readFileSync(path.join(root, 'src/runner.js'), 'utf8'));
  const runner = new app.Runner({});
  const link = document.querySelector('a');
  let clicked = false;
  link.addEventListener('click', () => { clicked = true; });
  assert.equal(await runner.detail({ key: 'place:original' }, link, app.extractor.findFeed(), new dom.window.AbortController().signal), null);
  assert.equal(clicked, false);
  dom.window.close();
});
test('a listing with a missing card name can read its detail heading', () => {
  const {app, dom} = environment('<div role="main"><h1>Results</h1><div role="feed"></div></div><div role="main"><h1>Recovered name</h1><button data-item-id="category">Painter</button></div>');
  assert.equal(app.extractor.details('').name, 'Recovered name');
  dom.window.close();
});

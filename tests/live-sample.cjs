/* Probe the actual Maps detail flow by presenting its international card phones
   in their local form. This changes only an isolated test page's displayed text. */
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..');
  const context = await chromium.launchPersistentContext('', { channel: process.env.MLF_BROWSER || 'msedge', headless: true, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  try {
    const page = await context.newPage();
    const navigations = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    await page.goto('https://www.google.com/maps/search/interior+designer+in+Dubai?hl=en', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('[role="feed"] .UsdlK').first().waitFor({timeout:20000});
    console.log('BRIDGE',await page.evaluate(()=>globalThis.__mapsLeadFinderActivation));
    await page.evaluate(() => { for (const node of document.querySelectorAll('[role="feed"] .UsdlK')) node.textContent = node.textContent.replace(/^\+971\s*/, '0'); });
    const ui = page.locator('maps-lead-finder');
    await ui.locator('#start').click();
    await page.waitForTimeout(10000);
    console.log('STATUS', await ui.locator('.status').innerText());
    console.log('WARNING', await ui.locator('.warning').innerText());
    console.log('HINT', await ui.locator('#code-hint').innerText());
    console.log('DETAIL URLS', navigations.filter(url => url.includes('/maps/place/')));
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts/live-sample-dom.html'), await page.content());
    await page.screenshot({path:path.join(root,'artifacts/live-sample.png')});
    if (await ui.locator('#stop').isVisible()) await ui.locator('#stop').click();
    await ui.locator('#download').waitFor({state:'visible',timeout:10000});
    assert.match(await ui.locator('#code-hint').innerText(), /Detected \+971/);
    assert.equal(new Set(navigations.filter(url => url.includes('/maps/place/')).map(url=>new URL(url).pathname.split('/@')[0])).size, 1);
    assert.ok(await page.locator('[role="feed"]').isVisible());
    assert.equal(await page.locator('[data-item-id^="phone:tel:"]').count(), 0);
    assert.ok(!(await ui.locator('.status').innerText()).includes('did not return'));
    assert.ok(!(await ui.locator('.warning').innerText()).includes('could not be converted'));
    console.log('PASS: One real Maps detail opened, international code detected, list restored, partial run retained.');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture.cjs');
const root = path.resolve(__dirname, '..');
const live = process.argv.includes('--live');
const liveBelfast = process.argv.includes('--live-belfast');
const liveOnly = process.argv.includes('--live-only');
const channel = process.env.MLF_BROWSER || 'msedge';
const artifacts = path.join(root, 'artifacts', channel);
fs.mkdirSync(artifacts, { recursive: true });
let context;
let liveProgress;
let passed = 0;
const log = message => { passed++; console.log(`PASS ${passed}: ${message}`); };
async function setup(scenario) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://www.google.com/**', route => route.fulfill({ contentType:'text/html; charset=utf-8', body:fixture(scenario) }));
  await page.goto(`https://www.google.com/maps/search/painter+in+Dubai?fixture=${scenario}`);
  await page.locator('maps-lead-finder').waitFor();
  return { page, ui: page.locator('maps-lead-finder'), errors };
}
async function done(ui) {
  await ui.locator('#stop').waitFor({ state:'hidden', timeout:40000 });
}
async function download(page, ui, label) {
  const pending = page.waitForEvent('download');
  await ui.locator('#download').click();
  const file = await pending;
  const target = path.join(artifacts, `${label}.csv`);
  await file.saveAs(target);
  return { csv:fs.readFileSync(target,'utf8'), name:file.suggestedFilename() };
}
(async () => {
  context = await chromium.launchPersistentContext('', { channel, headless:true, acceptDownloads:true, viewport:{width:1360,height:900}, args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`] });
  assert.ok(context.serviceWorkers().length || await context.waitForEvent('serviceworker', {timeout:10000}));
  if (!liveOnly) {
  const {page,ui,errors} = await setup('normal');
  assert.equal(await ui.locator('#profession').inputValue(),'painter');
  assert.equal(await ui.locator('#city').inputValue(),'Dubai');
  await ui.locator('#start').click(); await done(ui);
  assert.equal(await ui.locator('#count').innerText(),'5');
  assert.equal(await ui.locator('#without').innerText(),'2');
  assert.match(await ui.locator('.status').innerText(),/120/);
  assert.equal(await ui.locator('.warning').innerText(),'');
  assert.deepEqual(await page.evaluate(()=>window.detailOpens),['branchA','branchD']);
  const result=await download(page,ui,'fixture-full');
  assert.ok(result.csv.startsWith('\uFEFF'));
  assert.ok(result.csv.includes('+971 50 706 4831'));
  assert.ok(result.csv.includes('https://facebook.com/branch?x=%2F'));
  assert.ok(result.csv.includes('https://instagram.com/exact?x=%2F'));
  assert.equal((result.csv.match(/"Same name"/g)||[]).length,2);
  assert.ok(!result.csv.includes('Advertisement'));
  assert.match(result.name,/^painter_dubai_\d{4}-\d{2}-\d{2}\.csv$/);
  await page.waitForTimeout(600);
  assert.match(await ui.locator('.status').innerText(),/120/);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(artifacts,'fixture-finished.png')});
  log(`Actual MV3 extension loads in ${channel}; auto-scroll, one phone sample, essential detail fallback, place-link dedupe, ads, Arabic, and CSV download work.`);
  await ui.locator('#code').fill('+971'); await ui.locator('#filter').check();
  await page.evaluate(()=>window.detailOpens=[]);
  await ui.locator('#start').click();await done(ui);
  assert.deepEqual(await page.evaluate(()=>window.detailOpens),['branchD']);
  const filtered=await download(page,ui,'fixture-filtered');
  assert.equal(filtered.csv.split('\r\n').filter(Boolean).length,3);
  assert.ok(!filtered.csv.includes('facebook.com') && !filtered.csv.includes('instagram.com'));
  log('Manual country code skips phone sampling; no-website filter applies to download, with accurate counts.');
  await page.evaluate(()=>{history.pushState({},'','/maps/search/electrician+in+London');document.querySelector('#searchboxinput').value='electrician in London'});
  await page.waitForTimeout(700);
  assert.equal(await ui.locator('#profession').inputValue(),'electrician');
  assert.equal(await ui.locator('#city').inputValue(),'London');
  assert.equal(await ui.locator('#code').inputValue(),'');
  assert.match((await download(page,ui,'fixture-retained')).name,/^painter_dubai_/);
  log('SPA search changes prefill new fields, clear old country code, and preserve the previous CSV labels.');
  await page.close();
  const failed=await setup('failed');await failed.ui.locator('#start').click();await done(failed.ui);
  assert.match(await failed.ui.locator('.warning').innerText(),/Enter a country code/);
  assert.equal((await failed.page.evaluate(()=>window.detailOpens)).filter(id=>id==='branchA').length,1);
  assert.ok((await download(failed.page,failed.ui,'fixture-unresolved')).csv.includes('050 706 4831'));
  log('Failed detection keeps original local phones, warns clearly, and attempts one sample only.');await failed.page.close();
  for (const scenario of ['compact','compact-late','compact-recycled','compact-activation']) {
    const compact=await setup(scenario);
    await compact.ui.locator('#start').click();await done(compact.ui);
    assert.equal(await compact.ui.locator('#count').innerText(),'5');
    assert.equal(await compact.ui.locator('#without').innerText(),'2');
    assert.equal(await compact.ui.locator('.warning').innerText(),'');
    assert.deepEqual(await compact.page.evaluate(()=>window.detailOpens),['branchA','branchB','branchC','branchD','branchE']);
    const full=await download(compact.page,compact.ui,'fixture-'+scenario);
    assert.ok(full.csv.includes('https://facebook.com/branch?x=%2F'));
    assert.ok(full.csv.includes('https://instagram.com/exact?x=%2F'));
    assert.ok(full.csv.includes('+971 50 706 4832'));
    await compact.ui.locator('#filter').check();
    await compact.ui.locator('#start').click();await done(compact.ui);
    const filtered=await download(compact.page,compact.ui,'fixture-'+scenario+'-filtered');
    assert.equal(filtered.csv.split('\r\n').filter(Boolean).length,3);
    assert.ok(!filtered.csv.includes('facebook.com') && !filtered.csv.includes('instagram.com'));
    log('Organic compact cards, hidden contacts, website filtering, and '+(scenario==='compact-late'?'delayed hydration/final batches':scenario==='compact-recycled'?'recycled card links':scenario==='compact-activation'?'lazy link controllers':'real sponsored badges')+' work.');
    await compact.page.close();
  }
  const incomplete=await setup('compact-failed');
  await incomplete.ui.locator('#filter').check();await incomplete.ui.locator('#start').click();await done(incomplete.ui);
  assert.equal(await incomplete.ui.locator('#count').innerText(),'1');
  assert.equal(await incomplete.ui.locator('#without').innerText(),'0');
  assert.match(await incomplete.ui.locator('.warning').innerText(),/website link.*could not be read/);
  assert.equal((await download(incomplete.page,incomplete.ui,'fixture-compact-unverified')).csv.split('\r\n').filter(Boolean).length,1);
  log('A compact card whose details fail to load is excluded from no-website leads.');await incomplete.page.close();
  for (const changed of [false,true]) {
    const stopped=await setup('slow');await stopped.ui.locator('#code').fill('+971');await stopped.ui.locator('#start').click();
    await stopped.page.waitForTimeout(700);
    if (changed) await stopped.page.evaluate(()=>{history.pushState({},'','/maps/search/plumber+in+London');document.querySelector('#searchboxinput').value='plumber in London'});
    else await stopped.ui.locator('#stop').click();
    await done(stopped.ui);
    assert.ok(Number(await stopped.ui.locator('#count').innerText())>0);
    const csv=await download(stopped.page,stopped.ui,changed?'fixture-navigation':'fixture-stop');
    assert.ok(csv.csv.includes('"painter","Dubai"'));
    log(changed?'Changing searches stops the run without mixing cities, and partial data remains downloadable.':'Stop cancels loading promptly and downloads a partial run.');await stopped.page.close();
  }
  for (const [scenario,pattern] of [['single',/opened one place/],['zero',/no results/],['consent',/consent or cookie/],['layout',/layout may have changed/],['blank',/most business names/]]) {
    const fixturePage=await setup(scenario);await fixturePage.ui.locator('#start').click();await done(fixturePage.ui);
    assert.match(await fixturePage.ui.locator('.status').innerText(),pattern);
    log(`Friendly message for ${scenario}.`);await fixturePage.page.close();
  }
  }
  if (live || liveBelfast) {
    const liveQuery=liveBelfast?'restaurants in City Centre, Belfast, UK':'interior designer in Dubai';
    const liveLabel=liveBelfast?'live-belfast':'live-dubai';
    const p=await context.newPage();const started=Date.now();let opens=0;
    p.on('framenavigated',frame=>{if(frame===p.mainFrame() && frame.url().includes('/maps/place/')) opens++});
    await p.goto('https://www.google.com/maps/search/'+encodeURIComponent(liveQuery)+'?hl=en',{waitUntil:'domcontentloaded',timeout:45000});
    const panel=p.locator('maps-lead-finder');await panel.waitFor({timeout:20000});await panel.locator('#start').click();
    liveProgress=setInterval(()=>Promise.all([panel.locator('#count').innerText(),panel.locator('.status').innerText()]).then(([count,status])=>console.log(JSON.stringify({liveProgress:count,status}))).catch(()=>{}),15000);
    await panel.locator('#download').waitFor({state:'visible',timeout:liveBelfast?420000:180000});
    const data=await download(p,panel,liveLabel);
    clearInterval(liveProgress);liveProgress=null;
    await p.screenshot({path:path.join(artifacts,liveLabel+'.png')});
    fs.writeFileSync(path.join(artifacts,liveLabel+'-page.html'),await p.content());
    const report={query:liveQuery,liveCount:await panel.locator('#count').innerText(),withoutWebsite:await panel.locator('#without').innerText(),status:await panel.locator('.status').innerText(),warning:await panel.locator('.warning').innerText(),detailNavigations:opens,totalSeconds:Math.round((Date.now()-started)/1000)};
    fs.writeFileSync(path.join(artifacts,liveLabel+'-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
    assert.ok(Number(report.liveCount)>(liveBelfast?0:20));
    assert.ok(data.csv.includes(liveBelfast?'+44':'+971'));
    assert.match(await panel.locator('.status').innerText(),/120/);
    log('Live Google Maps '+liveQuery+' search and real browser download verified.');await p.close();
  }
  console.log(`${passed} browser scenarios passed (${channel}).`);
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{clearInterval(liveProgress);await context?.close()});

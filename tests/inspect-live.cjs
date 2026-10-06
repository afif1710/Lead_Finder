/* Optional diagnostics for selector maintenance, using a separate browser profile. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ channel: process.env.MLF_BROWSER || 'msedge', headless: true });
  try {
    const artifacts = path.resolve(__dirname, '../artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    const queries = process.argv.slice(2);
    const reports = await Promise.all((queries.length ? queries : ['Maison Dien Interior design Dubai', 'AX DESIGN Dubai', 'dentist in New York']).map(async (query, index) => {
      const page = await browser.newPage();
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(4000);
      const report = await page.evaluate(query => ({
        query, url: location.href, title: document.querySelector('h1')?.textContent,
        phone: [...document.querySelectorAll('[data-item-id^="phone:tel:"]')].map(node => ({ id: node.dataset.itemId, text: node.innerText })),
        website: [...document.querySelectorAll('[data-item-id="authority"]')].map(node => node.getAttribute('href')),
        sponsored: [...document.querySelectorAll('[role="article"]')].filter(node => /Sponsored|Ad /.test(node.innerText)).map(node => node.outerHTML),
        feed: !!document.querySelector('[role="feed"]'),
        cards: [...document.querySelectorAll('[role="feed"] .Nv2PK, [role="feed"] [role="article"]')].slice(0, 3).map(node => ({ className: node.className, html: node.outerHTML })),
        placeLinks: [...document.querySelectorAll('[role="feed"] a[href*="/maps/place/"], [role="feed"] a[href*="?cid="]')].map(node => ({ label: node.getAttribute('aria-label'), href: node.href })),
        feedHTML: document.querySelector('[role="feed"]')?.outerHTML || ''
      }), query);
      if (report.feedHTML) {
        const capture = path.join(artifacts, `inspection-feed-${index}.html`);
        fs.writeFileSync(capture, report.feedHTML);
        report.feedCapture = capture;
      }
      delete report.feedHTML;
      await page.close();
      return report;
    }));
    fs.writeFileSync(path.join(artifacts, 'inspection.json'), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify(reports.map(report => ({ ...report, cards: report.cards.map(card => ({ className: card.className, html: card.html.slice(0, 1000) })) })), null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

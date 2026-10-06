const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
function environment(html = '') {
  const dom = new JSDOM(html, { url: 'https://www.google.com/maps/search/painter+in+Dubai', runScripts: 'outside-only' });
  dom.window.eval(fs.readFileSync(path.join(root, 'vendor/libphonenumber-max.js'), 'utf8'));
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 100 }];
  for (const file of ['selectors', 'utils', 'phone', 'csv', 'extractor']) dom.window.eval(fs.readFileSync(path.join(root, 'src', `${file}.js`), 'utf8'));
  return { dom, app: dom.window.MapsLeadFinder, window: dom.window, document: dom.window.document };
}
module.exports = { environment, root };

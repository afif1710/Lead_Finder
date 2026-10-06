const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.permissions, undefined);
assert.equal(manifest.host_permissions, undefined);
for (const script of manifest.content_scripts) for (const match of script.matches) assert.match(match, /^https:\/\/\*\.google\.[a-z.]+\/maps\*$/);
for (const file of [...manifest.content_scripts.flatMap(script => script.js), manifest.background.service_worker]) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  new vm.Script(source, { filename: file });
  if (!file.startsWith('vendor/')) assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(source), `${file}: unexpected network call`);
}
const context = { MapsLeadFinder: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'styles/panel-style.js'), 'utf8'), context);
assert.equal(context.MapsLeadFinder.panelStyle, fs.readFileSync(path.join(root, 'styles/panel.css'), 'utf8'));
console.log('Manifest paths, Maps-only scope, JavaScript syntax, local-only runtime, and generated stylesheet verified.');

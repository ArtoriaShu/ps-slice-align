'use strict';
// Finding Photoshop's Generator log for the diagnostic bundle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const diagnostics = require('../com.align4.export/js/diagnostics');

function tree(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-diag-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  return {base, put(parts, name, mtime) {
    const dir = path.join(base, 'Adobe', ...parts); fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, name); fs.writeFileSync(file, 'log ' + name);
    if (mtime) { fs.utimesSync(file, mtime, mtime); }
    return file;
  }};
}

test('finds logs in the current Logs\\Generator layout', t => {
  const d = tree(t), file = d.put(['Adobe Photoshop 2024', 'Logs', 'Generator'], 'generator.log');
  assert.equal(diagnostics.findGeneratorLog({fs, path, env: {APPDATA: d.base}}).file.file, file);
});

test('still finds the older Generator\\logs and Generator layouts', t => {
  const d = tree(t);
  const a = d.put(['Adobe Photoshop CC 2019', 'Generator', 'logs'], 'a.log', new Date(2020, 1, 1));
  const b = d.put(['Adobe Photoshop 2020', 'Generator'], 'b.txt', new Date(2021, 1, 1));
  const found = diagnostics.findGeneratorLog({fs, path, env: {APPDATA: d.base}});
  assert.equal(found.file.file, b, 'newest wins without a version preference');
  assert.ok(fs.existsSync(a));
});

test("the running Photoshop's log wins over a newer one from another version", t => {
  const d = tree(t);
  const mine = d.put(['Adobe Photoshop 2020', 'Generator', 'logs'], 'old.log', new Date(2021, 1, 1));
  d.put(['Adobe Photoshop 2024', 'Logs', 'Generator'], 'new.log', new Date(2025, 1, 1));
  const prefer = diagnostics.yearFor('21.2.4');
  assert.equal(prefer, '2020');
  assert.equal(diagnostics.findGeneratorLog({fs, path, env: {APPDATA: d.base}, prefer}).file.file, mine);
  assert.match(diagnostics.generatorSection({fs, path, env: {APPDATA: d.base}, prefer}), /与当前 Photoshop 版本一致/);
});

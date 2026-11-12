'use strict';
// The single export pipeline, with real padding / file writing and a scripted Photoshop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const png = require('../com.align4.export/js/png-padding');
const rules = require('../com.align4.export/js/rules');
const outputFiles = require('../com.align4.export/js/output-files');
const exportJob = require('../com.align4.export/js/export-job');
const loggerModule = require('../com.align4.export/js/logger');

function image(width, height) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), png.chunk('IHDR', header),
    png.chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height))), png.chunk('IEND', Buffer.alloc(0))]);
}

function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-out-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const meta = Object.assign({ok: true, token: 'doc|7|1', name: '按钮', kind: '图层', revision: '10', width: 5, height: 3}, opts.meta);
  const scripts = [], stages = [];
  let describeCount = 0;
  const o = {fs, path, os, png, rules, outputFiles, now: Date.now, setTimeout, clearTimeout, log: loggerModule.create({}), job: 1,
    host(script, cb) {
      scripts.push(script);
      if (/describe/.test(script)) { describeCount++; cb(opts.describe ? opts.describe(describeCount, meta) : meta); return; }
      cb({ok: false, message: 'unexpected ' + script});
    },
    nativeExport: {run(o2, spec, cb) {
      scripts.push(spec.script('/tmp/x'));
      if (opts.nativeError) { cb(opts.nativeError); return {cancel() {}}; }
      const data = opts.native || image(5, 3);
      cb(null, {data, measured: png.parse(data), attempt: opts.attempt || 1});
      return {cancel() {}};
    }},
    superPNG: {encode(o2, data, enabled, cb) {
      if (opts.superError) { cb(opts.superError); return; }
      cb(null, image(png.parse(data).width, png.parse(data).height));
    }}};
  function run(request = {}) {
    return new Promise(resolve => exportJob.run(o, Object.assign({scope: 'selection', meta, name: '按钮', prefix: 'ui_', directory: dir, anchor: 'center',
      onStage: s => stages.push(s)}, request), (error, record) => resolve({error, record, scripts, stages, dir})));
  }
  return {run, dir, meta};
}

test('selection export pads to a multiple of 4 and writes with the prefix', async t => {
  const r = await setup(t).run();
  assert.ifError(r.error);
  assert.equal(path.basename(r.record.file), 'ui_按钮.png');
  const written = png.parse(fs.readFileSync(r.record.file)); assert.equal(written.width, 8); assert.equal(written.height, 4);
  assert.deepEqual([r.record.originalWidth, r.record.originalHeight], [5, 3]);
  assert.deepEqual(r.stages, ['native', 'verify', 'pad', 'write', 'done']);
  assert.match(r.scripts[0], /^Align4\.startNative\("doc\|7\|1",/);
});

test('a minimum size grows the output and is still rounded to 4', async t => {
  const r = await setup(t).run({minWidth: 10, minHeight: 9});
  assert.ifError(r.error); assert.deepEqual([r.record.width, r.record.height], [12, 12]);
});

test('existing files are never overwritten', async t => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.dir, 'ui_按钮.png'), 'keep');
  const r = await s.run();
  assert.equal(path.basename(r.record.file), 'ui_按钮-2.png');
  assert.equal(fs.readFileSync(path.join(s.dir, 'ui_按钮.png'), 'utf8'), 'keep');
});

test('selection change while Generator works stops before anything is written', async t => {
  const r = await setup(t, {describe: (n, meta) => Object.assign({}, meta, {token: 'doc|8|1'})}).run();
  assert.match(r.error.message, /选择已改变/); assert.deepEqual(fs.readdirSync(r.dir), []);
});

test('an edit (history change) during export stops before writing', async t => {
  const r = await setup(t, {describe: (n, meta) => Object.assign({}, meta, {revision: '11'})}).run();
  assert.match(r.error.message, /被编辑/); assert.deepEqual(fs.readdirSync(r.dir), []);
});

test('SuperPNG output is what gets written, and the object is re-checked after it', async t => {
  const r = await setup(t).run({superPNG: true});
  assert.ifError(r.error); assert.equal(r.record.encoder, 'SuperPNG');
  assert.equal(r.scripts.filter(s => /describe/.test(s)).length, 2);
  assert.deepEqual(r.stages, ['native', 'verify', 'pad', 'superpng', 'verify', 'write', 'done']);
});

test('SuperPNG failure never falls back to an ordinary PNG', async t => {
  const r = await setup(t, {superError: new Error('SuperPNG missing')}).run({superPNG: true});
  assert.match(r.error.message, /SuperPNG missing/); assert.deepEqual(fs.readdirSync(r.dir), []);
});

test('canvas export ignores the minimum size and requires the PNG to match the canvas', async t => {
  const ok = await setup(t, {meta: {token: '1|canvas', kind: '整个画布', width: 5, height: 3}}).run({scope: 'canvas', minWidth: 100});
  assert.ifError(ok.error); assert.deepEqual([ok.record.width, ok.record.height], [8, 4]);
  assert.match(ok.scripts[0], /^Align4\.startNativeCanvas\(/);
  const bad = await setup(t, {meta: {token: '1|canvas', width: 6, height: 3}}).run({scope: 'canvas'});
  assert.match(bad.error.message, /画板/);
});

test('native export errors are passed through', async t => {
  const e = Object.assign(new Error('等待 90 秒仍未得到完整 PNG'), {code: 'ALIGN4_PNG_TIMEOUT'});
  const r = await setup(t, {nativeError: e}).run();
  assert.equal(r.error.code, 'ALIGN4_PNG_TIMEOUT');
});

test('a missing target directory is reported, not thrown', async t => {
  const r = await setup(t).run({directory: path.join(os.tmpdir(), 'align4-does-not-exist-' + Date.now())});
  assert.match(r.error.message, /导出目录不可用/);
});

test('cancel stops the job with a recognisable error', t => {
  const s = setup(t);
  let result;
  const o = {fs, path, os, png, rules, outputFiles, now: Date.now, log: loggerModule.create({}), job: 1, host() {},
    nativeExport: {run() { return {cancel() {}}; }}};
  const handle = exportJob.run(o, {scope: 'selection', meta: s.meta, name: 'x', directory: s.dir}, (error) => { result = error; });
  handle.cancel(); assert.equal(result.code, 'ALIGN4_CANCELLED');
});

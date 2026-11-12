'use strict';
// Native export waiting, resend and cleanup against a real temp directory and a fake clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const png = require('../com.align4.export/js/png-padding');
const nativeExport = require('../com.align4.export/js/native-export');
const loggerModule = require('../com.align4.export/js/logger');
const diagnostics = require('../com.align4.export/js/diagnostics');

function image(width, height) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), png.chunk('IHDR', header),
    png.chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height))), png.chunk('IEND', Buffer.alloc(0))]);
}

// Fake clock: timers fire in order, advancing "now". `at(ms, fn)` schedules world events.
function world(t, behaviour) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-root-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let now = 1000; const timers = []; let seq = 0; const commands = [];
  const logger = loggerModule.create({now: () => now});
  function setTimeout(fn, delay) { const id = ++seq; timers.push({id, at: now + delay, fn}); return id; }
  function clearTimeout(id) { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); }
  const o = {fs, path, png, os: {tmpdir: () => root}, now: () => now, setTimeout, clearTimeout, log: logger, job: 1,
    host(script, callback) {
      const dir = JSON.parse('[' + script.slice(script.indexOf('(') + 1, -1) + ']')[1];
      commands.push(dir);
      behaviour({number: commands.length, dir, at: (ms, fn) => setTimeout(fn, ms), write: (name, data) => fs.writeFileSync(path.join(dir, name), data), callback});
    }};
  function run(spec = {}) {
    let outcome = null;
    const handle = nativeExport.run(o, Object.assign({prefix: 'align4-native-', script: dir => 'Align4.startNative("tok",' + JSON.stringify(dir) + ')'}, spec),
      (error, result) => { outcome = {error, result, at: now}; });
    for (let guard = 0; !outcome && timers.length && guard < 5000; guard++) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers.shift(); now = Math.max(now, next.at); next.fn();
    }
    return Object.assign(outcome || {}, {commands, handle, root, logger, started: 1000});
  }
  return {run, root, logger};
}

test('normal export: first request writes the PNG; its directory is removed', t => {
  const w = world(t, ({write, callback}) => { callback({ok: true}); write('x.png', image(5, 3)); });
  const r = w.run();
  assert.ifError(r.error); assert.equal(r.result.measured.width, 5); assert.equal(r.result.attempt, 1);
  assert.equal(r.commands.length, 1); assert.deepEqual(fs.readdirSync(r.root), []);
  assert.ok(r.at - r.started < 1500, 'stable-size check adds well under a second');
});

test('a dropped request is re-sent automatically and the second one succeeds', t => {
  const w = world(t, ({number, write, callback}) => { callback({ok: true}); if (number === 2) write('x.png', image(4, 4)); });
  const r = w.run();
  assert.ifError(r.error); assert.equal(r.result.attempt, 2); assert.equal(r.commands.length, 2);
  assert.ok(r.at - r.started >= 10000 && r.at - r.started < 12000);
  assert.ok(w.logger.entries().some(e => e.event === 'native.silent'));
});

test('a slow first request still wins if it finishes before the re-sent one', t => {
  const w = world(t, ({number, at, write, callback}) => { callback({ok: true}); if (number === 1) at(15000, () => write('slow.png', image(8, 8))); });
  const r = w.run();
  assert.ifError(r.error); assert.equal(r.result.attempt, 1); assert.equal(r.commands.length, 2);
});

test('a file already being written suppresses re-sending', t => {
  const w = world(t, ({at, dir, callback}) => {
    callback({ok: true}); const data = image(6, 6);
    at(9000, () => fs.writeFileSync(path.join(dir, 'x.png'), data.subarray(0, 20)));
    at(14000, () => fs.writeFileSync(path.join(dir, 'x.png'), data));
  });
  const r = w.run();
  assert.ifError(r.error); assert.equal(r.commands.length, 1); assert.equal(r.result.measured.width, 6);
});

test('nothing ever appears: times out after the configured resends with a clear message', t => {
  const w = world(t, ({callback}) => callback({ok: true}));
  const r = w.run();
  assert.equal(r.error.code, 'ALIGN4_PNG_TIMEOUT'); assert.equal(r.commands.length, 3);
  assert.match(r.error.message, /共发送 3 次请求，没有任何文件出现/);
  assert.ok(r.at - r.started >= 90000);
});

test('a host failure (e.g. selection changed) on a re-send stops the job', t => {
  const w = world(t, ({number, callback}) => callback(number === 1 ? {ok: true} : {ok: false, message: '选择已改变'}));
  const r = w.run();
  assert.match(r.error.message, /选择已改变/); assert.equal(r.commands.length, 2);
});

test('multiple PNGs in one directory are rejected', t => {
  const w = world(t, ({write, callback}) => { callback({ok: true}); write('a.png', image(2, 2)); write('b.png', image(2, 2)); });
  const r = w.run({multipleMessage: 'many'});
  assert.equal(r.error.message, 'many');
});

test('progress reports elapsed seconds and attempts', t => {
  const seen = [];
  const w = world(t, ({number, at, write, callback}) => { callback({ok: true}); if (number === 2) at(1500, () => write('x.png', image(2, 2))); });
  w.run({onProgress: p => seen.push(p)});
  assert.ok(seen.length >= 10); assert.equal(seen[0].attempts, 1); assert.equal(seen[seen.length - 1].attempts, 2);
});

test('sweep removes only stale align4 temp directories', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-sweep-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const name of ['align4-native-old', 'align4-canvas-new', 'other-old']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'align4-native-old', 'late.png'), 'x');
  const old = new Date(Date.now() - 2 * 3600000);
  fs.utimesSync(path.join(root, 'align4-native-old'), old, old); fs.utimesSync(path.join(root, 'other-old'), old, old);
  const removed = nativeExport.sweep({fs, path, os: {tmpdir: () => root}, now: Date.now}, 3600000);
  assert.equal(removed, 1); assert.deepEqual(fs.readdirSync(root).sort(), ['align4-canvas-new', 'other-old']);
});

test('logger appends daily files, prunes old ones and formats entries', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-log-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'align4-2000-01-01.log'), 'old');
  const log = loggerModule.create({fs, path, dir, keepDays: 7});
  log.info('export.start', '开始切图导出', {name: 'A'}, 3); log.debug('host', 'quiet');
  const files = fs.readdirSync(dir); assert.equal(files.length, 1); assert.notEqual(files[0], 'align4-2000-01-01.log');
  const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.match(text, /INFO  #3 export\.start  开始切图导出  \{"name":"A"\}/);
  assert.equal(log.entries('info').length, 1); assert.equal(log.entries('debug').length, 2);
});

test('diagnostics find the newest Generator log and include its tail', t => {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-appdata-'));
  t.after(() => fs.rmSync(appdata, {recursive: true, force: true}));
  const logs = path.join(appdata, 'Adobe', 'Adobe Photoshop 2024', 'Generator', 'logs'); fs.mkdirSync(logs, {recursive: true});
  fs.writeFileSync(path.join(logs, 'generator_latest.txt'), Array.from({length: 200}, (_, i) => 'line ' + i).join('\n') + '\n');
  const section = diagnostics.generatorSection({fs, path, env: {APPDATA: appdata}}, 5);
  assert.match(section, /generator_latest\.txt/); assert.match(section, /line 199$/); assert.doesNotMatch(section, /line 194\n/);
  assert.match(diagnostics.generatorSection({fs, path, env: {}}, 5), /未找到 Generator 日志/);
  const text = diagnostics.bundle({version: '1.12.0', environment: {ok: true}, state: {}, entries: [{time: 0, level: 'info', event: 'e', message: 'm'}], generator: section});
  assert.match(text, /插件版本：1\.12\.0/); assert.match(text, /e  m/);
});

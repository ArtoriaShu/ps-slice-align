'use strict';
// Selection tracking and settings persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const selection = require('../com.align4.export/js/selection');
const settings = require('../com.align4.export/js/settings');

function clock() {
  let now = 0, seq = 0; const timers = [];
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.push({id, at: now + ms, fn}); return id; },
    clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms) { const end = now + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); now = t.at; t.fn(); } now = end; }
  };
}

function setup(opts = {}) {
  const c = clock(), scripts = [], changes = [], errors = [];
  let token = 'A', hidden = false, mode = 'selection', fail = null;
  const tracker = selection.create({setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, hidden: () => hidden, mode: () => mode,
    host(script, cb) { scripts.push(script); cb(fail ? {ok: false, message: fail} : {ok: true, token: mode === 'canvas' ? 'doc' : token, name: 'n' + token, kind: '图层'}); },
    onChange: m => changes.push(m), onError: e => errors.push(e)});
  return {tracker, c, scripts, changes, errors, select(t) { token = t; }, hide(v) { hidden = v; }, setMode(m) { mode = m; }, fail(m) { fail = m; }};
}

test('bursts of notifications coalesce into one query', () => {
  const s = setup(); s.tracker.start(); s.c.advance(300);
  s.select('B'); for (let i = 0; i < 100; i++) s.tracker.poke(); s.c.advance(300);
  assert.equal(s.scripts.length, 2); assert.deepEqual(s.changes.map(m => m.token), ['A', 'B']);
});

test('polling recovers a lost notification and reports only real changes', () => {
  const s = setup(); s.tracker.start(); s.c.advance(300);
  s.c.advance(1200 * 3); assert.equal(s.changes.length, 1, 'no change, no report');
  s.select('B'); s.c.advance(1200); assert.equal(s.changes[s.changes.length - 1].token, 'B');
});

test('polling pauses while hidden or while an export runs', () => {
  const s = setup(); s.tracker.start(); s.c.advance(300); const base = s.scripts.length;
  s.hide(true); s.c.advance(5000); assert.equal(s.scripts.length, base);
  s.hide(false); s.tracker.pause(); s.tracker.poke(); s.c.advance(5000); assert.equal(s.scripts.length, base);
  s.select('B'); s.tracker.resume(); s.c.advance(300); assert.equal(s.changes[s.changes.length - 1].token, 'B');
});

test('errors are reported once and slow polling down', () => {
  const s = setup(); s.fail('请打开 PSD'); s.tracker.start(); s.c.advance(1300); // first (already scheduled) poll
  const n = s.scripts.length; s.c.advance(4500); assert.equal(s.scripts.length, n, 'backs off to 5s');
  s.c.advance(1000); assert.equal(s.scripts.length, n + 1); assert.equal(s.errors.length, 1);
});

test('canvas mode queries the document instead of the selection', () => {
  const s = setup(); s.setMode('canvas'); s.tracker.start(); s.c.advance(300);
  assert.equal(s.scripts[0], 'Align4.describeDocument()'); assert.equal(s.changes[0].mode, 'canvas');
});

function memoryStorage(init = {}) { const m = new Map(Object.entries(init)); return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m}; }

test('settings migrate presets, main and canvas directories from 1.x without duplicates', () => {
  const st = memoryStorage({'align4-directory-presets': JSON.stringify([{path: 'D:\\切图', name: '切图'}, {path: 'D:\\icons'}]),
    'align4-export-directory': 'D:\\切图\\', 'align4-canvas-directory': 'E:\\整图', 'align4-filename-prefix': 'ui_', 'align4-superpng': '1'});
  const s = settings.load(st);
  assert.deepEqual(s.directories.map(d => d.path), ['D:\\切图', 'D:\\icons', 'E:\\整图']);
  assert.equal(s.directories[1].name, 'icons'); assert.equal(s.prefix, 'ui_'); assert.equal(s.superPNG, true);
  s.mode = 'canvas'; settings.save(st, s);
  const again = settings.load(st); assert.equal(again.mode, 'canvas'); assert.equal(again.directories.length, 3);
});

test('settings survive corrupt storage', () => {
  const s = settings.load(memoryStorage({'align4-settings-v2': '{oops'}));
  assert.equal(s.mode, 'selection'); assert.deepEqual(s.directories, []);
});

'use strict';
// Export-name ownership (ported from the 1.10.x regressions).
const test = require('node:test');
const assert = require('node:assert/strict');
const naming = require('../com.align4.export/js/naming');

function setup() {
  let selected = 'A';
  const queries = [];
  const meta = (token = selected) => ({ok: true, token, name: 'PS-' + token, kind: '图层'});
  const n = naming.create({query(cb) { const r = meta(); queries.push(() => cb(r)); }});
  n.observe(meta());
  return {n, meta, select(t) { selected = t; }, reply(i = 0) { assert.ok(queries.length, 'a query is pending'); queries.splice(i, 1)[0](); },
    pending: () => queries.length,
    resolve(m = meta()) { let out; n.resolve(m, (error, name) => { out = {error, name}; }); return () => out; }};
}

test('layer name is used until the user types', () => {
  const s = setup(); assert.equal(s.n.state().value, 'PS-A');
  assert.equal(s.resolve()().name, 'PS-A');
});

test('switch layer, type, export immediately: the name binds to the newly selected layer', () => {
  const s = setup(); s.select('B'); s.n.edit('自定义-B');
  const out = s.resolve(); assert.equal(out(), undefined, 'waits for ownership');
  s.reply(); assert.equal(out().name, '自定义-B');
});

test('a late tracker report does not discard a draft whose owner is still pending', () => {
  const s = setup(); s.select('B'); s.n.edit('custom');
  s.n.observe(s.meta('B')); assert.equal(s.n.state().value, 'custom');
  s.reply(); s.n.observe(s.meta('B')); assert.equal(s.n.state().value, 'custom');
});

test('a custom name is not reused for another layer', () => {
  const s = setup(); s.n.edit('custom-A'); s.reply(); s.select('B');
  s.n.edit('custom-A'); // focus/blur/keyup with no change
  assert.equal(s.pending(), 0, 'no-op events must not rebind');
  assert.equal(s.resolve(s.meta('B'))().name, 'PS-B');
  assert.equal(s.n.state().value, 'PS-B');
});

test('out-of-order replies cannot replace the latest edit', () => {
  const s = setup(); s.n.edit('custom-A'); s.select('B'); s.n.edit('custom-B');
  s.reply(1); s.reply();
  assert.equal(s.resolve(s.meta('B'))().name, 'custom-B');
});

test('selection changing while ownership is pending drops the stale draft', () => {
  const s = setup(); s.n.edit('custom-A'); s.select('B');
  s.n.observe(s.meta('B')); s.reply(); s.n.observe(s.meta('B'));
  assert.equal(s.n.state().value, 'PS-B');
});

test('an emptied name exports with the layer name', () => {
  const s = setup(); s.select('B'); s.n.edit(''); s.reply();
  const out = s.resolve(s.meta('B'))();
  assert.equal(out.error, null); assert.equal(out.name, 'PS-B');
});

test('reset returns to the layer name and cancels the outstanding query', () => {
  const s = setup(); s.n.edit('custom-A'); s.n.reset(); s.reply();
  assert.equal(s.resolve()().name, 'PS-A'); assert.equal(s.n.state().edited, false);
});

test('a draft whose owner could not be determined is not attached to any object', () => {
  const n = naming.create({query(cb) { cb({ok: false, message: '没有打开文档'}); }});
  n.observe({token: 'A', name: 'A'}); n.edit('x');
  let out; n.resolve({token: 'A', name: 'A'}, (error, name) => { out = {error, name}; });
  assert.equal(out.error, null); assert.equal(out.name, 'A');
});

test('export waiting on a pending query reports that query\'s failure', () => {
  let reply; const n = naming.create({query(cb) { reply = cb; }});
  n.observe({token: 'A', name: 'A'}); n.edit('x');
  let out; n.resolve({token: 'A', name: 'A'}, (error) => { out = error; });
  reply({ok: false, message: '没有打开文档'}); assert.match(out.message, /没有打开文档/);
});

test('names are trimmed and lose a trailing .png', () => {
  assert.equal(naming.normalize('  按钮.PNG  '), '按钮');
});

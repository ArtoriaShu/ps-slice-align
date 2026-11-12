'use strict';
// host.jsx selection metadata against a scripted Photoshop (ActionManager).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function photoshop(opts = {}) {
  let now = 0, history = 5, boundsReads = 0;
  const layer = Object.assign({id: 7, name: '按钮', section: 'layerSectionContent', artboard: false, bounds: [10, 20, 488, 131]}, opts.layer);
  function ActionReference() { this.prop = null; }
  ActionReference.prototype.putProperty = function (cls, prop) { this.prop = prop; };
  ActionReference.prototype.putEnumerated = function () {};
  function rect(l, t, r, b) { const v = {left: l, top: t, right: r, bottom: b}; return {getUnitDoubleValue: k => v[k], getDouble: k => v[k]}; }
  function executeActionGet(ref) {
    const p = ref.prop;
    const d = {hasKey: () => true};
    if (p === 'targetLayersIDs') return Object.assign(d, {getList: () => ({count: 1})});
    if (p === 'layerID') return Object.assign(d, {getInteger: () => layer.id});
    if (p === 'name') return Object.assign(d, {getString: () => layer.name});
    if (p === 'layerSection') return Object.assign(d, {getEnumerationValue: () => layer.section});
    if (p === 'artboardEnabled') return Object.assign(d, {hasKey: () => true, getBoolean: () => layer.artboard});
    if (p === 'currentHistoryState') return Object.assign(d, {getInteger: () => history});
    if (p === 'bounds') { boundsReads++; now += opts.boundsMs || 1; return Object.assign(d, {getObjectValue: () => rect.apply(null, layer.bounds)}); }
    if (p === 'artboard') return Object.assign(d, {getObjectValue: () => ({getObjectValue: () => rect(0, 0, 1080, 602)})});
    throw new Error('unexpected ' + p);
  }
  function FakeDate() { this.t = now; } FakeDate.prototype.getTime = function () { return this.t; };
  const context = vm.createContext({app: {documents: {length: 1}, activeDocument: {id: 1}}, ActionReference, executeActionGet,
    stringIDToTypeID: s => s, charIDToTypeID: s => s, Date: FakeDate, $: {os: 'test'}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../com.align4.export/host/host.jsx'), 'utf8'), context);
  return {describe: () => JSON.parse(context.Align4v2.describeSelection()), reads: () => boundsReads, edit() { history++; }, layer};
}

test('the host object is Align4v2 and reports an estimated size from the layer bounds', () => {
  const ps = photoshop(); const m = ps.describe();
  assert.equal(m.ok, true); assert.equal(m.estWidth, 478); assert.equal(m.estHeight, 111);
});

test('artboards are estimated from the artboard rectangle', () => {
  const m = photoshop({layer: {section: 'layerSectionStart', artboard: true}}).describe();
  assert.equal(m.kind, '画板'); assert.equal(m.estWidth, 1080); assert.equal(m.estHeight, 602);
});

test('bounds are read once per object and history state, not on every poll', () => {
  const ps = photoshop();
  for (let i = 0; i < 10; i++) assert.equal(ps.describe().estWidth, 478);
  assert.equal(ps.reads(), 1);
  ps.edit(); ps.describe(); assert.equal(ps.reads(), 2, 'an edit refreshes the estimate');
});

test('a document whose bounds lookup is slow stops being estimated', () => {
  const ps = photoshop({boundsMs: 400});
  const first = ps.describe(); assert.equal(first.estWidth, undefined); assert.equal(first.estMs, 400);
  ps.edit(); const later = ps.describe();
  assert.equal(later.estSkipped, true); assert.equal(ps.reads(), 1, 'no further lookups in this document');
});

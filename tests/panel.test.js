'use strict';
// Boots the real panel.js with every real module, a minimal DOM and a fake
// Photoshop whose "Generator" writes the PNG asynchronously, then clicks export.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const png = require('../com.align4.export/js/png-padding');

const ROOT = path.resolve(__dirname, '../com.align4.export');

function image(width, height) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), png.chunk('IHDR', header),
    png.chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height))), png.chunk('IEND', Buffer.alloc(0))]);
}

function node(tag) {
  const n = {tagName: tag, children: [], attributes: {}, listeners: {}, style: {setProperty() {}}, textContent: '', value: '', className: '',
    hidden: false, disabled: false, checked: false, title: '', parentNode: null, type: '', scrollTop: 0, scrollHeight: 0,
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
    setAttribute(k, v) { this.attributes[k] = String(v); }, getAttribute(k) { return this.attributes[k]; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, removeEventListener() {},
    fire(t, e) { (this.listeners[t] || []).forEach(f => f(e || {})); },
    querySelector(sel) { const cls = sel.slice(1); const find = x => { for (const c of x.children) { if ((' ' + c.className + ' ').includes(' ' + cls + ' ')) return c; const r = find(c); if (r) return r; } return null; }; return find(this); },
    focus() {}, blur() {}, select() {}};
  Object.defineProperty(n, 'innerHTML', {set(v) { n._html = v; n.children = []; }, get() { return n._html || ''; }});
  return n;
}

function boot(t, opts = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-panel-out-'));
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-panel-log-'));
  t.after(() => { fs.rmSync(out, {recursive: true, force: true}); fs.rmSync(logs, {recursive: true, force: true}); });
  process.env.ALIGN4_LOG_DIR = logs; t.after(() => { delete process.env.ALIGN4_LOG_DIR; });
  const nodes = {}, scripts = [], storage = new Map(opts.storage ? Object.entries(opts.storage) : [['align4-settings-v2', JSON.stringify({directories: [{id: 'd1', path: out, name: '输出'}]})]]);
  let selected = {token: '1|5|1', name: '按钮', kind: '图层', revision: '3'};
  function getElementById(id) { if (!nodes[id]) { nodes[id] = node('div'); nodes[id].parentNode = node('div'); } return nodes[id]; }
  const timers = new Set();
  const win = {
    addEventListener() {},
    setTimeout(fn, ms) { const h = setTimeout(() => { timers.delete(h); fn(); }, ms); timers.add(h); return h; }, clearTimeout(h) { clearTimeout(h); timers.delete(h); },
    setInterval(fn, ms) { const h = setInterval(fn, ms); timers.add(h); return h; }, clearInterval(h) { clearInterval(h); timers.delete(h); },
    cep_node: {require},
    localStorage: {getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, v)},
    __adobe_cep__: {
      getSystemPath: () => ROOT, getHostEnvironment: () => JSON.stringify({appId: 'PHXS', appVersion: '21.2', appSkinInfo: {panelBackgroundColor: {color: {red: 50, green: 50, blue: 50}}}}),
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, resizeContent() {},
      evalScript(script, cb) {
        scripts.push(script);
        const reply = v => setTimeout(() => cb(JSON.stringify(v)), 1);
        if (script === 'Align4.describeSelection()' || script === 'Align4.selectionToken()') return reply(Object.assign({ok: true}, selected));
        if (script === 'Align4.describeDocument()') return reply({ok: true, token: '1|canvas', name: '设计稿', kind: '整个画布', width: 9, height: 7, revision: '3'});
        if (script === 'Align4.eventIDs()') return reply({ok: true, events: []});
        if (script === 'Align4.environment()') return reply({ok: true, photoshop: '21.2'});
        const m = /^Align4\.startNative(Canvas)?\((.*)\)$/.exec(script);
        if (m) {
          const [, dir] = JSON.parse('[' + m[2] + ']');
          if (!(opts.dropFirst && scripts.filter(s => s.startsWith('Align4.startNative')).length === 1)) {
            setTimeout(() => fs.writeFileSync(path.join(dir, 'gen.png'), m[1] ? image(9, 7) : image(5, 3)), 30);
          }
          return reply({ok: true});
        }
        reply({ok: false, message: 'unexpected ' + script});
      }}
  };
  const doc = {hidden: false, getElementById, createElement: node, createTextNode: text => Object.assign(node('#text'), {textContent: text}),
    querySelector: () => node('section'), addEventListener() {}, documentElement: node('html'), body: node('body'), execCommand: () => true};
  const context = vm.createContext({window: win, document: doc, JSON, Date, Error, Math, Object, Array, String, Number, Buffer, decodeURI, isFinite, require, process});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/panel.js'), 'utf8'), context);
  t.after(() => { try { win.Align4Panel && win.Align4Panel.tracker().stop(); } catch (e) {} timers.forEach(h => { clearTimeout(h); clearInterval(h); }); });
  return {nodes, scripts, out, logs, storage, api: win.Align4Panel, select(s) { selected = s; },
    exportButton() { const row = nodes.directoryList.children[0]; return row && row.children[2]; }};
}

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await wait(20); } assert.fail('timed out waiting'); }

test('boot, recognise the selection, export to a directory and report the result', async t => {
  const p = boot(t);
  await until(() => p.nodes.objectName.textContent === '按钮');
  assert.equal(p.nodes.version.textContent, 'v2.0.0');
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.exportButton().fire('click');
  await until(() => fs.readdirSync(p.out).length === 1);
  const file = path.join(p.out, fs.readdirSync(p.out)[0]);
  assert.equal(path.basename(file), '按钮.png');
  const parsed = png.parse(fs.readFileSync(file)); assert.deepEqual([parsed.width, parsed.height], [8, 4]);
  await until(() => /已导出/.test(p.nodes.statusTitle.textContent));
  assert.match(p.nodes.statusDetail.textContent, /8 × 4（原 5 × 3）/);
  await until(() => p.nodes.sizeSource.textContent === '5 × 3', 1000);
  const log = fs.readFileSync(path.join(p.logs, fs.readdirSync(p.logs)[0]), 'utf8');
  assert.match(log, /export\.start/); assert.match(log, /native\.done/); assert.match(log, /export\.end  成功/);
});

test('typing a name then pressing Enter exports with that name to the most recent directory', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.nodes.prefix.value = 'ui_'; p.nodes.prefix.fire('input');
  p.nodes.exportName.value = '确认按钮'; p.nodes.exportName.fire('input');
  p.nodes.exportName.fire('keydown', {keyCode: 13});
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['ui_确认按钮.png']);
  assert.equal(JSON.parse(p.storage.get('align4-settings-v2')).prefix, 'ui_');
});

test('canvas mode exports the whole document', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.nodes.modeCanvas.fire('click');
  await until(() => p.nodes.objectName.textContent === '设计稿');
  assert.equal(p.nodes.sizeSource.textContent, '9 × 7'); assert.equal(p.nodes.sizeTarget.textContent, '12 × 8');
  await until(() => p.exportButton() && !p.exportButton().disabled && p.exportButton().textContent === '导出整图');
  p.exportButton().fire('click');
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['设计稿.png']);
});

test('1.x settings are migrated on first start', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-migrate-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const p = boot(t, {storage: {'align4-export-directory': dir, 'align4-filename-prefix': 'old_', 'align4-superpng': '0'}});
  await until(() => p.nodes.directoryList.children.length === 1);
  assert.equal(p.nodes.prefix.value, 'old_');
});

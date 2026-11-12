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
  // 我的术语表 lives under APPDATA: give every test its own (unless it set one up), never the real one.
  if (!/align4-test-appdata-/.test(process.env.APPDATA || '')) {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-appdata-'));
  const oldAppdata = process.env.APPDATA; process.env.APPDATA = appdata;
  t.after(() => { if (oldAppdata === undefined) { delete process.env.APPDATA; } else { process.env.APPDATA = oldAppdata; } fs.rmSync(appdata, {recursive: true, force: true}); });
  }
  const settings = Object.assign({directories: [{id: 'd1', path: out, name: '输出'}]}, opts.settings);
  if (opts.canvasHere) { settings.canvasDirectory = out; }
  const hostListeners = {};
  const nodes = {}, scripts = [], storage = new Map(opts.storage ? Object.entries(opts.storage) : [['align4-settings-v2', JSON.stringify(settings)]]);
  let selected = {token: '1|5|1', name: '按钮', kind: '图层', revision: '3'};
  const p0 = {slowNext: false};
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
      addEventListener(type, fn) { hostListeners[type] = fn; }, removeEventListener() {}, dispatchEvent() {}, resizeContent() {},
      evalScript(script, cb) {
        assert.match(script, /^Align4v2\./, 'the panel talks to the 2.x host object');
        script = script.replace(/^Align4v2\./, 'Align4.');
        scripts.push(script);
        const reply = v => setTimeout(() => cb(JSON.stringify(v)), p0.slowNext && /describeSelection/.test(script) && !(p0.slowNext = false) ? 200 : 1);
        if (script === 'Align4.describeSelection()' || script === 'Align4.selectionToken()') return reply(selected.fail ? {ok: false, message: '每次只选择一个图层、图层组或画板。'} : Object.assign({ok: true}, selected));
        if (script === 'Align4.describeDocument()') return reply({ok: true, token: '1|canvas', name: '设计稿', kind: '整个画布', width: 9, height: 7, revision: '3'});
        if (script === 'Align4.eventIDs()') return reply({ok: true, events: opts.events || []});
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
  return {nodes, scripts, out, logs, storage, doc, emitHost(type, event) { if (hostListeners[type]) hostListeners[type](event); }, api: win.Align4Panel, slowNextDescribe() { p0.slowNext = true; }, select(s) { selected = s; },
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

test('the separate canvas button exports the whole document without SuperPNG by default', async t => {
  // Slice SuperPNG is on; canvas has its own switch, which defaults to off.
  const p = boot(t, {canvasHere: true, settings: {superPNG: true}});
  await until(() => !p.nodes.canvasExport.disabled);
  assert.equal(p.nodes.canvasSuperPNG.checked, false);
  p.nodes.canvasExport.fire('click');
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['设计稿.png']);
  const parsed = png.parse(fs.readFileSync(path.join(p.out, '设计稿.png'))); assert.deepEqual([parsed.width, parsed.height], [12, 8]);
  assert.equal(p.scripts.filter(s => s.startsWith('Align4.convertSuperPNG')).length, 0);
  await until(() => /整图已导出/.test(p.nodes.statusTitle.textContent));
  assert.match(p.nodes.canvasLast.textContent, /设计稿\.png · 12×8/);
});

test('canvas export stays available when the layer selection is invalid', async t => {
  const p = boot(t, {canvasHere: true});
  p.select({fail: true}); // e.g. several layers selected
  await until(() => /每次只选择一个/.test(p.nodes.objectName.textContent));
  assert.equal(p.exportButton().disabled, true);
  assert.equal(p.nodes.canvasExport.disabled, false);
});

test('without a canvas directory the canvas button is disabled until one is chosen', async t => {
  const p = boot(t);
  await until(() => p.nodes.objectName.textContent === '按钮');
  assert.equal(p.nodes.canvasExport.disabled, true); assert.equal(p.nodes.canvasFolder.textContent, '选择目录');
});

test('1.x settings are migrated on first start', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-migrate-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const p = boot(t, {storage: {'align4-export-directory': dir, 'align4-canvas-directory': dir, 'align4-filename-prefix': 'old_', 'align4-superpng': '1'}});
  await until(() => p.nodes.directoryList.children.length === 1);
  assert.equal(p.nodes.prefix.value, 'old_'); assert.equal(p.nodes.superPNG.checked, true);
  await until(() => p.nodes.canvasDirPath.textContent === dir);
  assert.equal(p.nodes.canvasSuperPNG.checked, false, 'canvas SuperPNG starts off even when slice SuperPNG was on');
});

test('a fixed size survives selection changes and is used for every export', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  assert.equal(p.nodes.lockSize.disabled, true, 'nothing to lock yet');
  p.nodes.minWidth.value = '62'; p.nodes.minWidth.fire('input');
  p.nodes.minHeight.value = '40'; p.nodes.minHeight.fire('input');
  p.nodes.lockSize.fire('click');
  assert.equal(p.nodes.lockSize.attributes['aria-pressed'], 'true');
  assert.equal(String(p.nodes.minWidth.value), '64', 'rounded up to a multiple of 4 when fixed');
  assert.equal(p.nodes.minWidth.disabled, true);
  p.select({token: '1|6|1', name: '图标', kind: '图层', revision: '3'});
  await until(() => p.nodes.objectName.textContent === '图标');
  assert.equal(String(p.nodes.minWidth.value), '64'); assert.equal(String(p.nodes.minHeight.value), '40');
  p.exportButton().fire('click');
  await until(() => fs.readdirSync(p.out).length === 1);
  const parsed = png.parse(fs.readFileSync(path.join(p.out, '图标.png'))); assert.deepEqual([parsed.width, parsed.height], [64, 40]);
  assert.equal(JSON.parse(p.storage.get('align4-settings-v2')).sizeLocked, true);
});

test('an unfixed size applies only to the current object', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.nodes.minWidth.value = '100'; p.nodes.minWidth.fire('input');
  p.select({token: '1|6|1', name: '图标', kind: '图层', revision: '3'});
  await until(() => p.nodes.objectName.textContent === '图标');
  assert.equal(p.nodes.minWidth.value, '');
});

test('an image larger than the fixed size is padded from its own size, never shrunk, and flagged', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.nodes.minWidth.value = '4'; p.nodes.minWidth.fire('input'); p.nodes.minHeight.value = '4'; p.nodes.minHeight.fire('input');
  p.nodes.lockSize.fire('click');
  p.exportButton().fire('click');
  await until(() => fs.readdirSync(p.out).length === 1);
  const parsed = png.parse(fs.readFileSync(path.join(p.out, '按钮.png'))); assert.deepEqual([parsed.width, parsed.height], [8, 4]);
  await until(() => /大于固定尺寸/.test(p.nodes.statusTitle.textContent));
});

test('cancelling before Photoshop answers ends the job, and a late reply cannot hijack the next export', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.slowNextDescribe(); p.exportButton().fire('click');
  assert.equal(p.scripts.filter(s => s.startsWith('Align4.startNative')).length, 0, 'still waiting for Photoshop');
  assert.equal(p.nodes.cancelJob.hidden, false);
  p.nodes.cancelJob.fire('click');
  await until(() => /已取消/.test(p.nodes.statusTitle.textContent), 500);
  await wait(400); // the cancelled job's late describe reply arrives here
  assert.deepEqual(fs.readdirSync(p.out), []);
  assert.equal(p.scripts.filter(s => s.startsWith('Align4.startNative')).length, 0, 'the late reply must not start an export');
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.exportButton().fire('click');
  await until(() => fs.readdirSync(p.out).length === 1);
});

test('the clicked directory button turns into a cancel button while exporting', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.slowNextDescribe(); p.exportButton().fire('click');
  const running = p.exportButton();
  assert.equal(running.disabled, false); assert.match(running.className, /running-button/);
  assert.match(p.nodes.statusDetail.textContent, /可随时取消/);
  running.fire('click');
  await until(() => /已取消/.test(p.nodes.statusTitle.textContent), 500);
  await wait(400); assert.deepEqual(fs.readdirSync(p.out), []);
});

function appdata(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-appdata-'));
  process.env.APPDATA = dir; t.after(() => { delete process.env.APPDATA; fs.rmSync(dir, {recursive: true, force: true}); });
  return dir;
}
const text = n => n.children.map(c => c.textContent).join('');

test('translation: a typed Chinese name becomes an English file name; typed English is kept as written', async t => {
  appdata(t);
  const p = boot(t, {settings: {translate: true}});
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.nodes.exportName.value = '聊天 装饰 气泡'; p.nodes.exportName.fire('input');
  await wait(20);
  assert.equal(p.nodes.englishName.value, 'chat_deco_bubble'); assert.equal(p.nodes.englishName.readOnly, false);
  assert.equal(p.nodes.fileName.textContent, 'chat_deco_bubble.png');
  p.exportButton().fire('click');
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['chat_deco_bubble.png']);
  p.nodes.exportName.value = 'btnConfirm'; p.nodes.exportName.fire('input'); await wait(20);
  assert.equal(p.nodes.fileName.textContent, 'btnConfirm.png');
});

test('translation: typing over the English is remembered for next time', async t => {
  const dir = appdata(t);
  const p = boot(t, {settings: {translate: true}});
  p.select({token: '1|8|1', name: '头像闪光', kind: '图层', revision: '3'});
  await until(() => p.nodes.englishName.value === 'avatar_flash');
  assert.match(text(p.nodes.translateNote), /闪光 → flash/, 'the exact word to check is named');
  const chip = p.nodes.translateNote.children.find(c => /flash/.test(c.textContent));
  let focused = false, range = null;
  p.nodes.englishName.focus = () => { focused = true; }; p.nodes.englishName.setSelectionRange = (a, b) => { range = [a, b]; };
  chip.fire('mousedown', {preventDefault() {}});
  assert.ok(focused); assert.deepEqual(range, [7, 12], 'clicking the chip selects "flash"');
  p.nodes.englishName.value = 'avatar_shine'; p.nodes.englishName.fire('input');
  assert.equal(p.nodes.englishReset.hidden, false);
  assert.equal(p.nodes.exportName.value, '头像闪光', 'the Chinese name is untouched');
  assert.equal(p.nodes.fileName.textContent, 'avatar_shine.png');
  p.exportButton().fire('click');
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['avatar_shine.png']);
  const glossary = path.join(dir, 'Align4Export', '我的术语表.csv');
  await until(() => fs.existsSync(glossary));
  assert.match(fs.readFileSync(glossary, 'utf8'), /闪光,shine/);
  p.select({token: '1|9|1', name: '按钮闪光', kind: '图层', revision: '3'});
  await until(() => p.nodes.englishName.value === 'btn_shine');
  assert.equal(p.nodes.englishReset.hidden, true, 'a new name starts from the automatic English again');
});

test('without translation the file field mirrors the name and is read-only', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.nodes.prefix.value = 'ui_'; p.nodes.prefix.fire('input');
  assert.equal(p.nodes.englishName.value, '按钮'); assert.equal(p.nodes.englishName.readOnly, true);
  assert.equal(p.nodes.filePrefix.textContent, 'ui_'); assert.equal(p.nodes.fileName.textContent, 'ui_按钮.png');
  assert.equal(p.nodes.translateNote.hidden, true);
});

test('an approximate size from the layer bounds shows on selection; the exact size replaces it after export', async t => {
  const p = boot(t);
  p.select({token: '1|5|1', name: '按钮', kind: '图层', revision: '3', estWidth: 6, estHeight: 3});
  await until(() => p.nodes.sizeSource.textContent === '约 6 × 3');
  assert.equal(p.nodes.sizeTarget.textContent, '约 8 × 4');
  assert.match(p.nodes.objectHint.textContent, /估算/);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.exportButton().fire('click');
  await until(() => p.nodes.sizeSource.textContent === '5 × 3', 3000);
  assert.equal(p.nodes.sizeTarget.textContent, '8 × 4');
});

test('an empty name exports with the layer name, which shows as the placeholder', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.nodes.exportName.value = ''; p.nodes.exportName.fire('input'); await wait(20);
  assert.equal(p.nodes.exportName.placeholder, '按钮');
  assert.equal(p.exportButton().disabled, false);
  assert.equal(p.nodes.fileName.textContent, '按钮.png');
  p.exportButton().fire('click');
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['按钮.png']);
});

// ---------- Review regressions (2026-11-12) ----------

test('the export button survives the name field losing focus (first click after renaming exports)', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  const pressed = p.exportButton();
  p.nodes.exportName.value = '确认按钮'; p.nodes.exportName.fire('input');
  p.nodes.exportName.fire('blur'); // mousedown on the button blurs the field first
  assert.equal(p.exportButton(), pressed, 'the pressed button must still be the one in the list');
  await until(() => !p.api.namer().state().pending);
  p.api.render();
  assert.equal(p.exportButton(), pressed);
  pressed.fire('click');
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['确认按钮.png']);
});

test('unfixed dimensions do not carry over to another layer through an invalid selection', async t => {
  const p = boot(t);
  await until(() => p.nodes.objectName.textContent === '按钮');
  p.nodes.minWidth.value = '100'; p.nodes.minWidth.fire('input');
  p.select({fail: true}); p.api.tracker().refresh();
  await until(() => /每次只选择一个/.test(p.nodes.objectName.textContent));
  p.select({token: '1|6|1', name: '背景', kind: '图层', revision: '4'}); p.api.tracker().refresh();
  await until(() => p.nodes.objectName.textContent === '背景');
  assert.equal(p.nodes.minWidth.value, '');
});

test('unfixed dimensions survive an invalid selection when the same layer comes back', async t => {
  const p = boot(t);
  await until(() => p.nodes.objectName.textContent === '按钮');
  p.nodes.minWidth.value = '100'; p.nodes.minWidth.fire('input');
  p.select({fail: true}); p.api.tracker().refresh();
  await until(() => /每次只选择一个/.test(p.nodes.objectName.textContent));
  p.select({token: '1|5|1', name: '按钮', kind: '图层', revision: '3'}); p.api.tracker().refresh();
  await until(() => p.nodes.objectName.textContent === '按钮');
  assert.equal(p.nodes.minWidth.value, '100');
});

test('an unfixed size typed for one object is not applied when export finds another', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.nodes.minWidth.value = '100'; p.nodes.minWidth.fire('input');
  p.select({token: '1|6|1', name: '背景', kind: '图层', revision: '4'}); // Photoshop changed, panel not refreshed yet
  p.exportButton().fire('click');
  await until(() => p.nodes.statusTitle.textContent === '导出失败');
  assert.match(p.nodes.statusDetail.textContent, /上一个对象/);
  assert.deepEqual(fs.readdirSync(p.out), []);
});

test('naming controls lock at once and the name is fixed at the click', async t => {
  const p = boot(t, {settings: {translate: true}});
  await until(() => p.nodes.objectName.textContent === '按钮');
  p.nodes.exportName.value = '确认按钮'; p.nodes.exportName.fire('input');
  await until(() => !p.api.namer().state().pending);
  p.slowNextDescribe(); p.api.exportTo(0);
  assert.equal(p.nodes.englishName.disabled, true);
  assert.equal(p.nodes.translate.disabled, true);
  p.nodes.translate.checked = false; p.nodes.translate.fire('change'); // ignored by this export
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['confirm_btn.png']);
});

test('Enter that confirms an IME candidate does not export', async t => {
  const p = boot(t);
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.nodes.exportName.fire('compositionstart');
  p.nodes.exportName.value = '确认';
  p.nodes.exportName.fire('keydown', {keyCode: 13, isComposing: true, preventDefault() {}});
  p.nodes.exportName.fire('keydown', {keyCode: 229, preventDefault() {}});
  p.nodes.exportName.fire('keydown', {keyCode: 13, preventDefault() {}}); // composition flag still set
  await wait(50);
  assert.equal(p.scripts.filter(s => s.startsWith('Align4.startNative')).length, 0);
  p.nodes.exportName.fire('compositionend'); p.nodes.exportName.fire('input');
  p.nodes.exportName.fire('keydown', {keyCode: 13, preventDefault() {}});
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['确认.png']);
});

test('without history IDs, an edit notification during export stops it', async t => {
  const MOVE = 1836021349;
  const p = boot(t, {events: [{id: 1936483188, edit: false}, {id: MOVE, edit: true}]});
  p.select({token: '1|5|1', name: '按钮', kind: '图层', revision: null});
  await until(() => p.exportButton() && !p.exportButton().disabled);
  await wait(30);
  p.exportButton().fire('click');
  await until(() => p.scripts.some(s => s.startsWith('Align4.startNative')));
  p.emitHost('com.adobe.PhotoshopJSONCallbackcom.align4.export.panel', {data: 'ver1,{"eventID":' + MOVE + ',"eventData":{}}'});
  await until(() => p.nodes.statusTitle.textContent === '导出失败');
  assert.match(p.nodes.statusDetail.textContent, /被编辑/);
  assert.deepEqual(fs.readdirSync(p.out), []);
});

test('selection notifications alone do not fail an export without history IDs', async t => {
  const SLCT = 1936483188;
  const p = boot(t, {events: [{id: SLCT, edit: false}]});
  p.select({token: '1|5|1', name: '按钮', kind: '图层', revision: null});
  await until(() => p.exportButton() && !p.exportButton().disabled);
  p.exportButton().fire('click');
  await until(() => p.scripts.some(s => s.startsWith('Align4.startNative')));
  p.emitHost('com.adobe.PhotoshopJSONCallbackcom.align4.export.panel', {data: 'ver1,{"eventID":' + SLCT + '}'});
  await until(() => fs.readdirSync(p.out).length === 1);
});

test('typed English is shown and written in the glossary format', async t => {
  const p = boot(t, {settings: {translate: true}});
  await until(() => p.nodes.objectName.textContent === '按钮');
  p.nodes.englishName.value = 'confirm button'; p.nodes.englishName.fire('input');
  p.nodes.englishName.fire('blur');
  assert.equal(p.nodes.englishName.value, 'confirm_button');
  p.api.exportTo(0);
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['confirm_button.png']);
});

test('the file field shows characters Windows cannot use as they will be written', async t => {
  const p = boot(t);
  p.select({token: '1|7|1', name: '按钮/确认', kind: '图层', revision: '3'});
  await until(() => p.nodes.objectName.textContent === '按钮/确认');
  assert.equal(p.nodes.englishName.value, '按钮_确认');
  p.api.exportTo(0);
  await until(() => fs.readdirSync(p.out).length === 1);
  assert.deepEqual(fs.readdirSync(p.out), ['按钮_确认.png']);
});

/* Browser preview of the panel with a simulated Photoshop.
   Loads the real panel markup, CSS, panel.js and core modules; only Photoshop,
   Generator and the file system are faked. Not shipped with the extension. */
(function () {
  'use strict';
  var BASE = '../com.align4.export/';

  // ---------- Simulated Photoshop document ----------
  var ps = {
    docOpen: true, docName: '首页改版_v3', docW: 1080, docH: 2337, revision: 41, selected: 0, scenario: 'normal', theme: 'dark',
    layers: [
      {id: 12, name: '按钮/确认', kind: '图层组', w: 478, h: 111},
      {id: 31, name: 'icon_search', kind: '图层', w: 46, h: 46},
      {id: 7, name: 'Banner 主视觉', kind: '画板', w: 1080, h: 602},
      {id: 54, name: '卡片背景', kind: '图层', w: 327, h: 214}
    ]
  };
  var files = {}; // fake file system: path -> true
  var folders = ['D:\\项目\\首页改版\\切图', 'D:\\项目\\首页改版\\icons', '\\\\NAS\\设计交付\\2026-11', 'E:\\临时\\整图'];
  var folderIndex = 0, skinListeners = [];

  function layer() { return ps.layers[ps.selected]; }
  function selMeta() {
    if (!ps.docOpen) { return {ok: false, message: '请打开 PSD 并选择一个导出对象。'}; }
    var l = layer();
    return {ok: true, token: [1, l.id, 1].join('|'), docId: 1, id: l.id, name: l.name, kind: l.kind, revision: String(ps.revision)};
  }
  function docMeta() {
    if (!ps.docOpen) { return {ok: false, message: '请先打开需要导出的 PSD。'}; }
    return {ok: true, docId: 1, token: '1|canvas', name: ps.docName, width: ps.docW, height: ps.docH, revision: String(ps.revision), kind: '整个画布'};
  }
  function skin() { return ps.theme === 'light' ? {red: 240, green: 240, blue: 240} : {red: 50, green: 50, blue: 50}; }

  var bridge = {
    getSystemPath: function () { return BASE; },
    getHostEnvironment: function () { return JSON.stringify({appId: 'PHXS', appVersion: '21.2.4', appLocale: 'zh_CN', appSkinInfo: {panelBackgroundColor: {color: skin()}}}); },
    getExtensionId: function () { return 'com.align4.export.panel'; },
    addEventListener: function (type, fn) { if (/ThemeColorChanged/.test(type)) { skinListeners.push(fn); } },
    removeEventListener: function () {}, dispatchEvent: function () {}, resizeContent: function () {},
    evalScript: function (script, cb) {
      var r, args = [];
      var m = /^Align4\.(\w+)\((.*)\)$/.exec(script);
      if (m && m[2]) { try { args = JSON.parse('[' + m[2] + ']'); } catch (e) {} }
      switch (m && m[1]) {
        case 'describeSelection': case 'selectionToken': r = selMeta(); break;
        case 'describeDocument': r = docMeta(); break;
        case 'eventIDs': r = {ok: true, events: []}; break;
        case 'startNative': case 'startNativeCanvas': r = {ok: true, started: true}; break;
        case 'chooseFolder': r = {ok: true, path: folders[folderIndex++ % folders.length]}; break;
        case 'openFolder': r = {ok: true}; break;
        case 'environment': r = {ok: true, photoshop: '21.2.4', os: 'Windows/64 10.0', openDocuments: 1, document: {name: ps.docName + '.psd', width: ps.docW, height: ps.docH, fileMB: 3120, layers: 1846, bits: 'BitsPerChannelType.EIGHT'}}; break;
        case 'convertSuperPNG': r = {ok: true}; break;
        default: r = {ok: false, message: 'mock: ' + script};
      }
      setTimeout(function () { cb(JSON.stringify(r)); }, 30 + Math.random() * 60);
    }
  };

  // ---------- Fake Node modules ----------
  var path = {
    sep: '\\',
    join: function () { return Array.prototype.slice.call(arguments).join('\\').replace(/\\+/g, '\\').replace(/^\\(?=[^\\])/, '\\\\'); },
    basename: function (p) { var parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/); return parts[parts.length - 1]; },
    dirname: function (p) { return String(p).replace(/[\\/][^\\/]*$/, ''); }
  };
  var fs = {
    existsSync: function () { return true; },
    statSync: function () { return {isDirectory: function () { return true; }, isFile: function () { return true; }, size: 0, mtimeMs: Date.now()}; },
    readdirSync: function () { return []; }, mkdirSync: function () {}, appendFileSync: function () {}
  };
  var os = {platform: function () { return 'win32'; }, release: function () { return '10.0.19045'; }, tmpdir: function () { return 'C:\\Users\\设计\\AppData\\Local\\Temp'; }};

  var png = {
    parse: function (data) { return data.measured; },
    pad: function (data, w, h) { return {measured: {width: w, height: h}, bytes: Math.round(w * h * 1.6)}; }
  };

  // Simulated Generator: the scenario decides how the native PNG arrives.
  var nativeExport = {
    sweep: function () { return 0; },
    run: function (o, spec, cb) {
      var started = null, attempts = 0, finished = false, timers = [];
      var canvas = /Canvas/.test(spec.script('x'));
      var target = canvas ? {width: ps.docW, height: ps.docH} : {width: layer().w, height: layer().h};
      function later(ms, fn) { timers.push(setTimeout(function () { if (!finished) { fn(); } }, ms)); }
      function send() {
        attempts++;
        var dir = o.os.tmpdir() + '\\' + (spec.prefix || 'align4-native-') + Math.random().toString(36).slice(2, 8);
        o.log.info('native.send', (attempts === 1 ? '发送' : '重发') + (spec.label || '快速导出') + '命令（第 ' + attempts + ' 次）', {dir: dir, at: started ? (Date.now() - started) / 1000 : 0}, o.job);
        o.host(spec.script(dir), function () { if (started === null) { started = Date.now(); } });
      }
      function progress() { if (spec.onProgress && !finished) { spec.onProgress({elapsed: Date.now() - started, attempts: attempts, fileSeen: false}); } }
      function tick() { if (!finished) { progress(); later(1000, tick); } }
      function done() {
        finished = true;
        var ms = Date.now() - started;
        o.log.info('native.file', '第 ' + attempts + ' 次请求的 PNG 开始写入（' + (ms / 1000).toFixed(1) + 's）', {bytes: target.width * target.height}, o.job);
        o.log.info('native.done', 'PNG 完成：' + target.width + '×' + target.height + '，用时 ' + (ms / 1000).toFixed(1) + 's（第 ' + attempts + ' 次请求）', {attempts: attempts}, o.job);
        cb(null, {data: {measured: target}, measured: target, attempt: attempts, elapsed: ms});
      }
      send(); later(1000, tick);
      if (ps.scenario === 'normal') { later(1300, done); }
      else if (ps.scenario === 'dropped') {
        later(10000, function () { o.log.warn('native.silent', '10s 内没有任何 PNG 出现，判断请求可能被 Generator 丢弃，重发', {attempts: attempts}, o.job); send(); progress(); });
        later(11800, done);
      } else {
        later(10000, function () { o.log.warn('native.silent', '10s 内没有任何 PNG 出现，重发', {attempts: 1}, o.job); send(); });
        later(14000, function () {
          finished = true;
          var e = new Error('等待 14 秒仍未得到完整 PNG（预览中缩短；实际为 90 秒，共发送 ' + attempts + ' 次请求，没有任何文件出现）。');
          e.code = 'ALIGN4_PNG_TIMEOUT'; o.log.error('native.timeout', e.message, {attempts: attempts}, o.job); cb(e);
        });
      }
      return {state: {attempts: attempts}, cancel: function () { finished = true; timers.forEach(clearTimeout); o.log.warn('native.cancel', '已取消等待', {}, o.job); }};
    }
  };

  // ---------- Tiny CommonJS loader for the real modules ----------
  var cache = {};
  function fetchText(url) { return fetch(url, {cache: 'no-store'}).then(function (r) { if (!r.ok) { throw new Error(url + ' ' + r.status); } return r.text(); }); }
  function define(name, text) {
    var module = {exports: {}};
    new Function('module', 'exports', 'require', 'Buffer', text)(module, module.exports, function (dep) { return cache[dep.replace(/^\.\//, '').replace(/\.js$/, '')]; }, {alloc: function () { return {}; }});
    cache[name] = module.exports;
  }
  var real = ['rules', 'logger', 'naming', 'selection', 'settings', 'output-files', 'export-job', 'diagnostics'];

  function boot() {
    return fetchText(BASE + 'index.html').then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      Array.prototype.forEach.call(doc.body.querySelectorAll('script'), function (s) { s.parentNode.removeChild(s); });
      document.body.innerHTML = doc.body.innerHTML;
      return Promise.all(real.map(function (n) { return fetchText(BASE + 'js/' + n + '.js').then(function (t) { return [n, t]; }); }));
    }).then(function (texts) {
      texts.forEach(function (pair) { define(pair[0], pair[1]); });
      var outputFiles = Object.assign({}, cache['output-files'], {
        save: function (fs_, path_, png_, dir, name, data) {
          var base = dir + '\\' + cache['output-files'].baseName(name), file, n = 1;
          do { file = base + (n === 1 ? '' : '-' + n) + '.png'; n++; } while (files[file]);
          files[file] = true;
          return {path: file, width: data.measured.width, height: data.measured.height};
        }
      });
      var diagnostics = Object.assign({}, cache.diagnostics, {generatorSection: function () { return '（预览环境：没有真实的 Generator 日志）'; }});
      window.Align4Modules = {fs: fs, path: path, os: os, env: {}, rules: cache.rules, png: png, outputFiles: outputFiles,
        superPNG: {encode: function (o, data, enabled, cb) { setTimeout(function () { cb(null, data); }, 900); }},
        nativeExport: nativeExport, exportJob: cache['export-job'], logger: cache.logger, diagnostics: diagnostics,
        naming: cache.naming, selection: cache.selection, settings: cache.settings};
      window.__adobe_cep__ = bridge;
      try {
        if (!localStorage.getItem('align4-settings-v2')) {
          localStorage.setItem('align4-settings-v2', JSON.stringify({prefix: '', canvasDirectory: 'E:\\临时\\整图', directories: [
            {id: 'a', path: 'D:\\项目\\首页改版\\切图', name: '切图', lastExport: {ok: true, time: Date.now() - 3600000, file: '按钮_确认.png', width: 480, height: 112}},
            {id: 'b', path: 'D:\\项目\\首页改版\\icons', name: 'icons', lastExport: null},
            {id: 'c', path: '\\\\NAS\\设计交付\\2026-11', name: '交付', lastExport: null}]}));
        }
      } catch (e) {}
      var s = document.createElement('script'); s.src = BASE + 'js/panel.js'; document.body.appendChild(s);
    }).catch(function (e) { document.body.textContent = '预览加载失败：' + e.message; });
  }

  // Controls used by the outer preview page.
  window.mockPS = {
    state: ps,
    select: function (i) { ps.docOpen = true; ps.selected = i; poke(); },
    edit: function () { ps.revision++; poke(); },
    closeDoc: function () { ps.docOpen = false; poke(); },
    scenario: function (s) { ps.scenario = s; },
    theme: function (t) { ps.theme = t; skinListeners.forEach(function (fn) { fn(); }); },
    reset: function () { try { localStorage.removeItem('align4-settings-v2'); } catch (e) {} location.reload(); }
  };
  function poke() { var p = window.Align4Panel; if (p && p.tracker()) { p.tracker().poke(); } }

  boot();
}());

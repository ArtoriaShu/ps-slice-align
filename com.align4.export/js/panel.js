/* 4 倍数导出 — panel controller.
   UI only: state lives here, all export work happens in export-job.js. */
(function () {
  'use strict';
  var VERSION = '2.0.0';
  var STAGE_TEXT = {prepare: '读取当前对象', native: '等待 Photoshop 生成 PNG', verify: '核对对象是否改变', pad: '补齐到 4 的倍数',
    superpng: 'SuperPNG 编码', write: '写入文件', done: '完成'};

  var ids = ['modeSelection', 'modeCanvas', 'openLog', 'objectKind', 'refresh', 'objectName', 'sizeSource', 'sizeTarget', 'objectHint',
    'resetName', 'prefix', 'clearPrefix', 'exportName', 'fileName', 'sizeGroup', 'minWidth', 'minHeight', 'anchorCenter', 'anchorTopLeft',
    'superPNG', 'directoryCount', 'addDirectory', 'directoryList', 'statusbar', 'statusTitle', 'statusDetail', 'statusOpen', 'statusLog',
    'cancelJob', 'logPanel', 'logVerbose', 'logCopy', 'logFolder', 'logClose', 'logList', 'logNote', 'version', 'restoreSize', 'debug'];
  var el = {};
  ids.forEach(function (id) { el[id] = document.getElementById(id); });
  var objectCard = document.querySelector ? document.querySelector('.object') : null;

  var bridge = window.__adobe_cep__, M = null, logger = null, S = null, storage = null;
  var tracker = null, namers = {}, current = {selection: null, canvas: null}, trackerError = null;
  var measured = {};      // token -> {width, height, revision}
  var job = null, jobSeq = 0, lastResult = null, status = null, closing = false, registered = [], listeners = [];
  var pendingRemove = null, choosingFolder = false, logOpen = false;

  // ---------- Utilities ----------
  function quote(v) { return JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
  function setText(node, text) { text = String(text); if (node.textContent !== text) { node.textContent = text; } }
  function now() { return Date.now(); }
  function seconds(ms) { return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's'; }
  function clock(t) { var d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function make(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text != null) { n.textContent = text; } return n; }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function mode() { return S.mode; }
  function persist() { if (storage) { M.settings.save(storage, S); } }

  var QUIET = /^Align4\.(describeSelection|describeDocument|selectionToken)\(/;
  function host(script, callback, timeout) {
    if (!bridge) { callback({ok: false, message: '请从 Photoshop 中打开插件。'}); return; }
    var name = script.slice(0, script.indexOf('(')), t0 = now(), done = false;
    var watchdog = timeout === 0 ? null : window.setTimeout(function () {
      deliver({ok: false, code: 'ALIGN4_HOST_TIMEOUT', message: 'Photoshop 脚本在 25 秒内未响应。可能正忙于其它操作，请稍后重试；如持续出现，请复制诊断信息。'});
    }, 25000);
    function deliver(r) {
      if (done) { return; } done = true;
      if (watchdog !== null) { window.clearTimeout(watchdog); }
      var ms = now() - t0, log = logger;
      if (log) {
        if (!r || !r.ok) { if (!(r && r.cancelled) && !(QUIET.test(script) && r && !r.code)) { log.warn('host', name + ' 失败（' + ms + 'ms）', {code: r && r.code, message: r && r.message}, job && job.id); } }
        else if (!QUIET.test(script) || ms > 1000) { log.debug('host', name + ' 完成（' + ms + 'ms）', undefined, job && job.id); }
      }
      if (!closing) { callback(r); }
    }
    try {
      bridge.evalScript(script, function (raw) {
        var r; try { r = JSON.parse(raw); } catch (e) { r = {ok: false, message: '宿主脚本连接失败（' + String(raw).slice(0, 80) + '），请重启 Photoshop。'}; }
        deliver(r);
      });
    } catch (e) { deliver({ok: false, message: String(e.message || e)}); }
  }

  // ---------- Status bar ----------
  // kind: idle | ready | working | ok | warn | error
  function setStatus(kind, title, detail, extra) {
    status = {kind: kind, title: title, detail: detail || '', open: extra && extra.open, log: extra && extra.log};
    renderStatus();
  }
  function renderStatus() {
    var s = status || {kind: 'idle', title: '', detail: ''};
    el.statusbar.setAttribute('data-kind', s.kind);
    setText(el.statusTitle, s.title); el.statusTitle.title = s.title;
    setText(el.statusDetail, s.detail); el.statusDetail.title = s.detail;
    el.statusOpen.hidden = !s.open;
    el.statusLog.hidden = !s.log;
    el.cancelJob.hidden = !job;
  }
  function idleStatus() {
    if (job) { return; }
    var meta = current[mode()];
    if (trackerError) { setStatus('warn', trackerError, mode() === 'canvas' ? '打开一个 PSD 后会自动识别。' : '在 Photoshop 中选中一个图层、图层组或画板。'); return; }
    if (!meta) { setStatus('idle', '正在读取 Photoshop…', ''); return; }
    if (!S.directories.length) { setStatus('warn', '还没有导出目录', '在右侧“添加目录”后即可导出。'); return; }
    var nm = namers[mode()].state();
    if (nm.edited && !M.naming.normalize(nm.value)) { setStatus('warn', '请填写导出名称', '或点击“用图层名”。'); return; }
    var dir = recentDirectory();
    setStatus('ready', '就绪', '点击目录右侧的“导出”' + (dir ? '，或在名称框按 Enter 导出到「' + dir.name + '」' : '') + '。');
  }

  // ---------- Rendering ----------
  function recentDirectory() {
    var best = null;
    S.directories.forEach(function (d) { if (d.lastExport && (!best || d.lastExport.time > best.lastExport.time)) { best = d; } });
    return best || S.directories[0] || null;
  }
  function minSize() {
    function read(input) {
      var raw = String(input.value).trim(); if (!raw) { return {value: 0, ok: true}; }
      var n = Number(raw); return {value: n, ok: isFinite(n) && n % 1 === 0 && n >= 1 && n <= 30000};
    }
    var w = read(el.minWidth), h = read(el.minHeight);
    return {width: w.value, height: h.value, ok: w.ok && h.ok, wOk: w.ok, hOk: h.ok};
  }

  function renderMode() {
    var canvas = mode() === 'canvas';
    el.modeSelection.setAttribute('aria-selected', String(!canvas));
    el.modeCanvas.setAttribute('aria-selected', String(canvas));
    el.sizeGroup.hidden = canvas;
    el.resetName.textContent = canvas ? '用文档名' : '用图层名';
  }

  function renderObject() {
    var canvas = mode() === 'canvas', meta = current[mode()], m = meta && measured[meta.token], min = minSize();
    if (objectCard) { objectCard.className = 'object' + (meta ? '' : ' empty'); }
    if (!meta) {
      setText(el.objectKind, canvas ? '整个画布' : '未选择');
      setText(el.objectName, trackerError || (canvas ? '请打开一个 PSD' : '在 Photoshop 中选择一个对象'));
      setText(el.sizeSource, '— × —'); setText(el.sizeTarget, '— × —'); setText(el.objectHint, ''); el.objectHint.className = 'hint';
      return;
    }
    setText(el.objectKind, meta.kind); setText(el.objectName, meta.name); el.objectName.title = meta.name;
    var source = canvas ? {width: meta.width, height: meta.height} : (m && (m.revision == null || m.revision === meta.revision) ? m : null);
    var hint = '', warn = false;
    if (source) {
      setText(el.sizeSource, source.width + ' × ' + source.height);
      var tw = M.rules.ceil4(Math.max(source.width, canvas ? 0 : min.width)), th = M.rules.ceil4(Math.max(source.height, canvas ? 0 : min.height));
      setText(el.sizeTarget, tw + ' × ' + th);
      var p = M.rules.padding(tw, th, source.width, source.height, S.anchor);
      hint = (tw === source.width && th === source.height) ? '已经是 4 的倍数，不需要补边。' :
        '透明补边：左 ' + p.left + ' · 右 ' + p.right + ' · 上 ' + p.top + ' · 下 ' + p.bottom + ' px' + (canvas ? '' : '（以上次导出时的实际尺寸估算）');
    } else {
      setText(el.sizeSource, '导出时读取');
      setText(el.sizeTarget, min.width || min.height ? '≥ ' + (min.width || '自动') + ' × ' + (min.height || '自动') : '自动补齐');
      hint = '实际像素尺寸在导出时由 Photoshop 生成的 PNG 测得。';
    }
    if (!min.ok && !canvas) { hint = '尺寸需为 1–30000 的整数。'; warn = true; }
    setText(el.objectHint, hint); el.objectHint.className = 'hint' + (warn ? ' warn' : '');
  }

  function renderNaming() {
    var nm = namers[mode()].state(), meta = current[mode()];
    // While typing, nm.value already equals the field, so this only fires for
    // selection changes / reset, and never interrupts an IME composition.
    if (el.exportName.value !== nm.value) { el.exportName.value = nm.value; }
    el.exportName.parentNode.className = 'field name-field' + (nm.edited ? ' custom' : '');
    el.resetName.disabled = !nm.edited || !!job;
    var name = M.naming.normalize(el.exportName.value);
    clear(el.fileName);
    if (!meta) { el.fileName.textContent = '—'; }
    else if (!name) { el.fileName.appendChild(make('span', 'warn', '请填写导出名称')); }
    else { el.fileName.textContent = M.outputFiles.nameFor(el.prefix.value, name) + '.png'; }
    el.fileName.title = (el.fileName.textContent || '') + '（同名文件不会覆盖，自动追加 -2、-3…）';
    el.clearPrefix.hidden = !el.prefix.value;
  }

  var FOLDER_SVG = '<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 5.2c0-.9.7-1.6 1.6-1.6h3.2l1.6 1.8h6c.9 0 1.6.7 1.6 1.6v6.6c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6V5.2z"/></svg>';

  function renderDirectories() {
    clear(el.directoryList);
    setText(el.directoryCount, S.directories.length);
    var canvas = mode() === 'canvas', recent = recentDirectory(), blocked = !!job || choosingFolder;
    var nm = namers[mode()].state(), meta = current[mode()];
    var cannot = !meta ? '没有可导出的对象' : (nm.edited && !M.naming.normalize(nm.value)) ? '请先填写导出名称' : (!canvas && !minSize().ok) ? '输出尺寸无效' : '';
    if (!S.directories.length) {
      var empty = make('div', 'empty-dest');
      empty.appendChild(make('p', null, '添加常用的导出目录，每个目录都有自己的导出按钮，点一下就导出到那里。'));
      var add = make('button', 'primary-button', '＋ 添加第一个目录');
      add.addEventListener('click', addDirectory); add.disabled = blocked;
      empty.appendChild(add); el.directoryList.appendChild(empty);
      return;
    }
    S.directories.forEach(function (d) {
      var running = job && job.dirId === d.id, exists = directoryExists(d.path);
      var row = make('div', 'dest' + (d === recent ? ' recent' : '') + (running ? ' running' : '') + (exists ? '' : ' missing'));
      var icon = make('span', 'dest-icon'); icon.innerHTML = FOLDER_SVG;
      var main = make('div', 'dest-main');
      var name = make('input', 'dest-name'); name.type = 'text'; name.value = d.name; name.title = '点击修改显示名称'; name.disabled = blocked; name.setAttribute('aria-label', '目录名称');
      name.addEventListener('change', function () { d.name = name.value.trim() || M.settings.basename(d.path); name.value = d.name; persist(); });
      name.addEventListener('keydown', function (e) { if (e.keyCode === 13) { name.blur(); } });
      var path = make('p', 'dest-path', exists ? d.path : '目录不存在：' + d.path); path.title = d.path;
      main.appendChild(name); main.appendChild(path);
      if (d.lastExport) {
        var le = d.lastExport, last = make('p', 'dest-last ' + (le.ok ? 'ok' : 'error'));
        last.textContent = le.ok ? clock(le.time) + ' · ' + le.file + ' · ' + le.width + '×' + le.height : clock(le.time) + ' · 失败：' + le.message;
        last.title = last.textContent; main.appendChild(last);
      }
      var btn = make('button', 'dest-export');
      if (running) { btn.innerHTML = '<span class="spinner"></span>'; btn.appendChild(document.createTextNode(seconds(now() - job.started))); btn.disabled = true; }
      else {
        btn.textContent = canvas ? '导出整图' : '导出';
        btn.disabled = blocked || !!cannot || !exists;
        btn.title = !exists ? '目录不存在，请移除后重新添加' : cannot || ((canvas ? '导出整张画布到 ' : '导出到 ') + d.path);
      }
      btn.addEventListener('click', function () { exportTo(d); });
      var remove = make('button', 'dest-remove' + (pendingRemove === d.id ? ' confirm' : ''), pendingRemove === d.id ? '确认移除' : '×');
      remove.title = '从列表中移除（不会删除文件夹）'; remove.disabled = blocked; remove.setAttribute('aria-label', '移除目录 ' + d.name);
      remove.addEventListener('click', function () { removeDirectory(d); });
      row.appendChild(icon); row.appendChild(main); row.appendChild(btn); row.appendChild(remove);
      el.directoryList.appendChild(row);
    });
  }

  var existsCache = {};
  function directoryExists(p) {
    if (!M.fs) { return true; }
    var c = existsCache[p];
    if (c && now() - c.t < 5000) { return c.v; }
    var v = false; try { v = M.fs.existsSync(p) && M.fs.statSync(p).isDirectory(); } catch (e) {}
    existsCache[p] = {t: now(), v: v}; return v;
  }

  function renderControls() {
    var busy = !!job;
    el.modeSelection.disabled = busy; el.modeCanvas.disabled = busy;
    el.prefix.disabled = busy; el.exportName.disabled = busy || !current[mode()];
    el.minWidth.disabled = busy; el.minHeight.disabled = busy;
    el.anchorCenter.disabled = busy; el.anchorTopLeft.disabled = busy;
    el.anchorCenter.setAttribute('aria-checked', String(S.anchor === 'center'));
    el.anchorTopLeft.setAttribute('aria-checked', String(S.anchor === 'topLeft'));
    el.superPNG.disabled = busy; el.addDirectory.disabled = busy || choosingFolder; el.refresh.disabled = busy;
    var min = minSize();
    el.minWidth.parentNode.className = 'field size-field' + (min.wOk ? '' : ' invalid');
    el.minHeight.parentNode.className = 'field size-field' + (min.hOk ? '' : ' invalid');
  }

  function render() {
    if (!M) { return; }
    renderMode(); renderObject(); renderNaming(); renderControls(); renderDirectories();
    if (!job && (!status || status.kind === 'idle' || status.kind === 'ready' || (status.kind === 'warn' && !status.sticky))) { idleStatus(); }
    else { renderStatus(); }
  }

  // ---------- Selection tracking ----------
  function onSelection(meta) {
    var m = meta.mode || mode();
    var previous = current[m];
    current[m] = meta; trackerError = null;
    if (!previous || previous.token !== meta.token) {
      logger.info('selection', (m === 'canvas' ? '文档 ' : '选中 ' + meta.kind) + '「' + meta.name + '」', {token: meta.token, revision: meta.revision, width: meta.width, height: meta.height});
    }
    namers[m].observe(meta);
    if (status && status.kind === 'warn' && !status.sticky) { status = null; }
    render();
  }
  function onTrackerError(message) {
    logger.warn('selection', message);
    current[mode()] = null; trackerError = message;
    if (!job) { status = null; }
    render();
  }

  // ---------- Export ----------
  function exportTo(d) {
    if (job || closing) { return; }
    if (!directoryExists(d.path)) { existsCache = {}; setStatus('error', '目录不存在', d.path, {}); render(); return; }
    var m = mode(), min = minSize();
    if (m === 'selection' && !min.ok) { setStatus('error', '输出尺寸无效', '宽高需为 1–30000 的整数，或留空自动补齐。'); return; }
    job = {id: ++jobSeq, dirId: d.id, started: now(), stage: 'prepare', attempts: 1, handle: null, mode: m};
    pendingRemove = null; tracker.pause();
    logger.info('export.start', '开始' + (m === 'canvas' ? '整图' : '切图') + '导出 → ' + d.name,
      {directory: d.path, prefix: S.prefix, typedName: el.exportName.value, minWidth: min.width, minHeight: min.height, anchor: S.anchor, superPNG: S.superPNG}, job.id);
    showJobStatus();
    host(m === 'canvas' ? 'Align4.describeDocument()' : 'Align4.describeSelection()', function (meta) {
      if (!job) { return; }
      if (!meta.ok) { end(d, new Error(meta.message)); return; }
      current[m] = meta;
      namers[m].resolve(meta, function (error, name, custom) {
        if (!job) { return; }
        if (error) { end(d, error); return; }
        logger.info('export.object', (m === 'canvas' ? '文档' : meta.kind) + '「' + meta.name + '」，文件名 ' + M.outputFiles.nameFor(S.prefix, name) + '.png' + (custom ? '（自定义）' : ''), {token: meta.token, revision: meta.revision}, job.id);
        job.handle = M.exportJob.run({fs: M.fs, path: M.path, os: M.os, png: M.png, rules: M.rules, outputFiles: M.outputFiles, nativeExport: M.nativeExport, superPNG: M.superPNG,
          host: host, now: now, setTimeout: function (fn, ms) { return window.setTimeout(fn, ms); }, clearTimeout: function (t) { window.clearTimeout(t); }, log: logger, job: job.id}, {
          scope: m, meta: meta, name: name, prefix: S.prefix, directory: d.path, minWidth: min.width, minHeight: min.height, anchor: S.anchor, superPNG: S.superPNG,
          onStage: function (stage, detail) { if (!job) { return; } job.stage = stage; if (detail && detail.attempts) { job.attempts = detail.attempts; } showJobStatus(); }
        }, function (error, record) { end(d, error, record, meta); });
      });
    });
  }

  var ticker = null;
  function showJobStatus() {
    if (!job) { return; }
    var elapsed = now() - job.started, detail = seconds(elapsed);
    if (job.stage === 'native') {
      if (job.attempts > 1) { detail += ' · Generator 没有响应，已自动重发 ' + (job.attempts - 1) + ' 次'; }
      else if (elapsed > 5000) { detail += ' · 大文件需要更久，请稍候'; }
    }
    status = {kind: 'working', title: (STAGE_TEXT[job.stage] || job.stage) + '…', detail: detail};
    renderStatus(); renderControls(); renderDirectories();
    if (ticker === null) { ticker = window.setInterval(function () { if (job) { showJobStatus(); } else { window.clearInterval(ticker); ticker = null; } }, 500); }
  }

  function end(d, error, record, meta) {
    var finished = job; job = null;
    if (ticker !== null) { window.clearInterval(ticker); ticker = null; }
    var took = seconds(now() - finished.started);
    if (error) {
      var cancelled = error.code === 'ALIGN4_CANCELLED';
      logger[cancelled ? 'warn' : 'error']('export.end', (cancelled ? '已取消' : '失败：' + String(error.message || error)) + '，用时 ' + took, {stage: finished.stage}, finished.id);
      if (!cancelled) { d.lastExport = {ok: false, time: now(), message: String(error.message || error)}; persist(); }
      status = {kind: cancelled ? 'warn' : 'error', title: cancelled ? '已取消导出' : '导出失败', detail: String(error.message || error), log: !cancelled, sticky: true};
    } else {
      var file = M.path.basename(record.file);
      if (finished.mode === 'selection' && meta) { measured[meta.token] = {width: record.originalWidth, height: record.originalHeight, revision: meta.revision}; }
      d.lastExport = {ok: true, time: now(), file: file, width: record.width, height: record.height}; persist();
      lastResult = record;
      logger.info('export.end', '成功，总用时 ' + took, {file: record.file}, finished.id);
      var padded = record.width !== record.originalWidth || record.height !== record.originalHeight;
      status = {kind: 'ok', title: '已导出 ' + file, detail: record.width + ' × ' + record.height + (padded ? '（原 ' + record.originalWidth + ' × ' + record.originalHeight + '）' : '') +
        ' · ' + record.encoder + ' · ' + took + ' · ' + d.name, open: true, sticky: true};
    }
    tracker.resume(); tracker.refresh();
    render(); renderStatus();
  }

  // ---------- Directories ----------
  function addDirectory() {
    if (choosingFolder || job) { return; }
    choosingFolder = true; render();
    var last = S.directories.length ? S.directories[S.directories.length - 1].path : '';
    host('Align4.chooseFolder(' + quote(last) + ')', function (r) {
      choosingFolder = false;
      if (r.ok) {
        if (M.settings.addDirectory(S.directories, r.path)) { persist(); logger.info('directory', '添加目录 ' + r.path); existsCache = {}; }
        else { setStatus('warn', '这个目录已在列表中', r.path); status.sticky = true; }
      } else if (!r.cancelled) { setStatus('error', '无法选择目录', r.message); status.sticky = true; }
      render();
    }, 0);
  }
  var removeTimer = null;
  function removeDirectory(d) {
    if (job) { return; }
    if (pendingRemove !== d.id) {
      pendingRemove = d.id; render();
      if (removeTimer) { window.clearTimeout(removeTimer); }
      removeTimer = window.setTimeout(function () { pendingRemove = null; removeTimer = null; render(); }, 3000);
      return;
    }
    pendingRemove = null;
    S.directories = S.directories.filter(function (x) { return x !== d; }); persist();
    logger.info('directory', '移除目录 ' + d.path);
    render();
  }

  // ---------- Log panel ----------
  function logLine(entry) { var row = make('div', 'log-row log-' + entry.level, M.logger.format(entry, false)); return row; }
  function renderLog() {
    if (!logOpen) { return; }
    clear(el.logList);
    var list = logger.entries(el.logVerbose.checked ? 'debug' : 'info').slice(-500);
    if (!list.length) { el.logList.appendChild(make('p', 'log-empty', '暂无记录。执行一次导出后，这里会逐步显示每个环节和用时。')); }
    list.forEach(function (e) { el.logList.appendChild(logLine(e)); });
    el.logList.scrollTop = el.logList.scrollHeight;
  }
  function setLogOpen(open) {
    logOpen = open; el.logPanel.hidden = !open; el.debug.hidden = true;
    if (open) {
      var f = logger.file(); setText(el.logNote, f ? '日志文件：' + f : '日志仅保存在内存中'); el.logNote.title = f || '';
      renderLog();
    }
  }
  function panelState() {
    return {version: VERSION, mode: S.mode, current: current, trackerError: trackerError, measured: measured,
      directories: S.directories, prefix: S.prefix, exportName: el.exportName.value, naming: {selection: namers.selection.state(), canvas: namers.canvas.state()},
      minWidth: el.minWidth.value, minHeight: el.minHeight.value, anchor: S.anchor, superPNG: S.superPNG, lastResult: lastResult, status: status};
  }
  function copyText(text) {
    var area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', '');
    area.style.position = 'fixed'; area.style.left = '-9999px'; document.body.appendChild(area); area.select();
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(area); return ok;
  }
  function copyDiagnostics() {
    el.logCopy.disabled = true; setText(el.logCopy, '正在收集…');
    host('Align4.environment()', function (environment) {
      var generator;
      try { generator = M.diagnostics.generatorSection({fs: M.fs, path: M.path, env: M.env}, 80); } catch (e) { generator = '读取失败：' + String(e.message || e); }
      var text = M.diagnostics.bundle({version: VERSION, environment: environment, state: panelState(), entries: logger.entries('debug').slice(-600), generator: generator, logFile: logger.file()});
      el.logCopy.disabled = false;
      if (copyText(text)) { setText(el.logCopy, '已复制 ✓'); logger.info('diagnostics', '诊断信息已复制（' + text.length + ' 字符）'); }
      else { setText(el.logCopy, '复制诊断信息'); el.debug.hidden = false; el.debug.value = text; el.debug.focus(); el.debug.select(); }
      window.setTimeout(function () { setText(el.logCopy, '复制诊断信息'); }, 2500);
    });
  }

  // ---------- Theme (follow Photoshop's interface colour) ----------
  function applyTheme() {
    try {
      var env = JSON.parse(bridge.getHostEnvironment()), c = env.appSkinInfo.panelBackgroundColor.color;
      var rgb = [c.red, c.green, c.blue].map(function (v) { return Math.round(v); });
      document.documentElement.style.setProperty('--bg', 'rgb(' + rgb.join(',') + ')');
      var lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
      document.documentElement.setAttribute('data-theme', lum > 0.55 ? 'light' : 'dark');
    } catch (e) {}
  }

  // ---------- Events ----------
  function bind() {
    function setMode(m) {
      if (job || S.mode === m) { return; }
      S.mode = m; persist(); status = null; logger.info('mode', '切换到' + (m === 'canvas' ? '整图' : '切图') + '模式');
      tracker.refresh(); render();
    }
    el.modeSelection.addEventListener('click', function () { setMode('selection'); });
    el.modeCanvas.addEventListener('click', function () { setMode('canvas'); });
    el.refresh.addEventListener('click', function () { existsCache = {}; status = null; tracker.refresh(); render(); });
    el.openLog.addEventListener('click', function () { setLogOpen(true); });
    el.statusLog.addEventListener('click', function () { setLogOpen(true); });
    el.logClose.addEventListener('click', function () { setLogOpen(false); });
    el.logVerbose.addEventListener('change', renderLog);
    el.logCopy.addEventListener('click', copyDiagnostics);
    el.logFolder.addEventListener('click', function () { if (logger.dir) { host('Align4.openFolder(' + quote(logger.dir) + ')', function (r) { if (!r.ok) { setStatus('error', '无法打开日志目录', r.message); } }); } });
    el.restoreSize.addEventListener('click', function () { try { bridge.resizeContent(760, 620); } catch (e) {} });
    el.cancelJob.addEventListener('click', function () { if (job && job.handle) { job.handle.cancel(); } });
    el.statusOpen.addEventListener('click', function () {
      if (lastResult && lastResult.directory) { host('Align4.openFolder(' + quote(lastResult.directory) + ')', function (r) { if (!r.ok) { setStatus('error', '无法打开目录', r.message); } }); }
    });
    el.addDirectory.addEventListener('click', addDirectory);
    el.anchorCenter.addEventListener('click', function () { S.anchor = 'center'; persist(); render(); });
    el.anchorTopLeft.addEventListener('click', function () { S.anchor = 'topLeft'; persist(); render(); });
    el.superPNG.addEventListener('change', function () { S.superPNG = !!el.superPNG.checked; persist(); logger.info('setting', 'SuperPNG ' + (S.superPNG ? '开启' : '关闭')); render(); });
    function sizeChanged() { S.minWidth = el.minWidth.value; S.minHeight = el.minHeight.value; persist(); render(); }
    ['input', 'change'].forEach(function (t) { el.minWidth.addEventListener(t, sizeChanged); el.minHeight.addEventListener(t, sizeChanged); });
    function prefixChanged() { if (el.prefix.value !== S.prefix) { S.prefix = el.prefix.value; persist(); render(); } }
    ['input', 'change', 'compositionend', 'keyup', 'blur'].forEach(function (t) { el.prefix.addEventListener(t, prefixChanged); });
    el.clearPrefix.addEventListener('click', function () { el.prefix.value = ''; prefixChanged(); el.prefix.focus(); });
    // Some CEP / IME combinations only deliver compositionend or keyup; any of them commits.
    function nameChanged() { namers[mode()].edit(el.exportName.value); }
    ['input', 'change', 'compositionend', 'keyup'].forEach(function (t) { el.exportName.addEventListener(t, nameChanged); });
    el.exportName.addEventListener('blur', function () { nameChanged(); render(); });
    el.exportName.addEventListener('keydown', function (e) {
      if (e.keyCode === 13) { nameChanged(); var d = recentDirectory(); if (d) { exportTo(d); } }
    });
    el.resetName.addEventListener('click', function () { namers[mode()].reset(); el.exportName.value = namers[mode()].state().value; render(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && tracker) { tracker.poke(); } });
    window.addEventListener('focus', function () { existsCache = {}; if (tracker) { tracker.poke(); } });
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('error', function (e) { if (logger) { logger.error('script', '面板脚本错误：' + (e && e.message), {file: e && e.filename, line: e && e.lineno, stack: e && e.error && e.error.stack}); } });
  }

  function registerPhotoshopEvents() {
    var extensionId = 'com.align4.export.panel', appId = 'PHXS';
    try {
      if (bridge.getExtensionId) { extensionId = bridge.getExtensionId() || extensionId; }
      if (bridge.getHostEnvironment) { appId = JSON.parse(bridge.getHostEnvironment()).appId || appId; }
    } catch (e) {}
    function dispatch(type, id) { bridge.dispatchEvent(JSON.stringify({type: type, scope: 'APPLICATION', extensionId: extensionId, appId: appId, data: String(id)})); }
    function listen(type, fn) { try { bridge.addEventListener(type, fn); listeners.push([type, fn]); } catch (e) {} }
    listen('com.adobe.PhotoshopJSONCallback' + extensionId, function () { if (tracker) { tracker.poke(); } });
    listen('documentAfterActivate', function () { if (tracker) { tracker.poke(); } });
    listen('com.adobe.csxs.events.ThemeColorChanged', applyTheme);
    host('Align4.eventIDs()', function (r) {
      if (!r.ok) { logger.warn('events', '无法注册 Photoshop 通知，改为定时检测', {message: r.message}); return; }
      r.events.forEach(function (e) { try { dispatch('com.adobe.PhotoshopRegisterEvent', e.id); registered.push([e.id, dispatch]); } catch (x) {} });
    });
  }

  function cleanup() {
    closing = true;
    if (tracker) { tracker.stop(); }
    if (job && job.handle) { job.handle.cancel(); }
    registered.forEach(function (r) { try { r[1]('com.adobe.PhotoshopUnRegisterEvent', r[0]); } catch (e) {} });
    listeners.forEach(function (l) { try { bridge.removeEventListener(l[0], l[1]); } catch (e) {} });
  }

  // ---------- Startup ----------
  function loadModules() {
    if (window.Align4Modules) { return window.Align4Modules; } // browser preview / tests
    var rq = window.cep_node && window.cep_node.require ? window.cep_node.require : window.require;
    if (!rq && typeof require === 'function') { rq = require; }
    if (!rq) { throw new Error('CEP Node 未启用。'); }
    var path = rq('path'), base = decodeURI(bridge.getSystemPath('extension')).replace(/^file:\/\//, '');
    if (/^\/[A-Za-z]:/.test(base)) { base = base.slice(1); }
    function mod(name) { return rq(path.join(base, 'js', name + '.js')); }
    var env = {}; try { env = rq('process').env || {}; } catch (e) {}
    return {fs: rq('fs'), path: path, os: rq('os'), env: env, rules: mod('rules'), png: mod('png-padding'), outputFiles: mod('output-files'),
      superPNG: mod('superpng'), nativeExport: mod('native-export'), exportJob: mod('export-job'), logger: mod('logger'),
      diagnostics: mod('diagnostics'), naming: mod('naming'), selection: mod('selection'), settings: mod('settings')};
  }

  function start() {
    try { M = loadModules(); }
    catch (e) {
      el.statusbar.setAttribute('data-kind', 'error');
      setText(el.statusTitle, '插件文件未完整加载');
      setText(el.statusDetail, '请重启 Photoshop，并确认新版已完整安装。' + String(e.message || e));
      return;
    }
    try { storage = window.localStorage; } catch (e) { storage = null; }
    S = M.settings.load(storage || {getItem: function () { return null; }, setItem: function () {}});
    var logDir = M.env.ALIGN4_LOG_DIR || M.path.join(M.env.APPDATA || M.os.tmpdir(), 'Align4Export', 'logs');
    logger = M.logger.create({fs: M.fs, path: M.path, dir: logDir, keepDays: 7});
    logger.onEntry(function (entry) {
      if (!logOpen || (entry.level === 'debug' && !el.logVerbose.checked)) { return; }
      var empty = el.logList.querySelector('.log-empty'); if (empty) { el.logList.removeChild(empty); }
      el.logList.appendChild(logLine(entry)); el.logList.scrollTop = el.logList.scrollHeight;
    });
    var hostEnv = null; try { hostEnv = JSON.parse(bridge.getHostEnvironment()); } catch (e) {}
    logger.info('panel.start', '面板启动 v' + VERSION, {app: hostEnv && hostEnv.appVersion, locale: hostEnv && hostEnv.appLocale, os: M.os.platform() + ' ' + M.os.release(), logWriteError: logger.writeError()});
    var swept = M.nativeExport.sweep({fs: M.fs, path: M.path, os: M.os, now: now}, 3600000);
    if (swept) { logger.info('temp.sweep', '清理了 ' + swept + ' 个过期临时目录'); }

    ['selection', 'canvas'].forEach(function (m) {
      namers[m] = M.naming.create({
        query: function (cb) { host(m === 'canvas' ? 'Align4.describeDocument()' : 'Align4.selectionToken()', cb); },
        onChange: function () { if (M && S) { renderNaming(); renderDirectories(); if (!job && status && (status.kind === 'ready' || status.kind === 'warn') && !status.sticky) { idleStatus(); } } },
        onOwnerResolved: function () { if (tracker) { tracker.poke(); } }
      });
    });
    tracker = M.selection.create({host: host, setTimeout: function (fn, ms) { return window.setTimeout(fn, ms); }, clearTimeout: function (t) { window.clearTimeout(t); },
      hidden: function () { return !!document.hidden; }, mode: mode, onChange: onSelection, onError: onTrackerError});

    el.prefix.value = S.prefix; el.superPNG.checked = S.superPNG; el.minWidth.value = S.minWidth || ''; el.minHeight.value = S.minHeight || '';
    setText(el.version, 'v' + VERSION);
    applyTheme(); bind(); render();
    if (bridge) { registerPhotoshopEvents(); }
    tracker.start();
  }

  start();
  // Exposed for automated tests and the browser preview.
  window.Align4Panel = {exportTo: function (index) { exportTo(S.directories[index]); }, state: panelState, tracker: function () { return tracker; },
    namers: namers, settings: function () { return S; }, render: render};
}());

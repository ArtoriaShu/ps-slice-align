/* 4 倍数导出 — panel controller.
   UI only: state lives here, all export work happens in export-job.js. */
(function () {
  'use strict';
  var VERSION = '2.0.0';
  var STAGE_TEXT = {prepare: '读取当前对象', native: '等待 Photoshop 生成 PNG', verify: '核对对象是否改变', pad: '补齐到 4 的倍数',
    superpng: 'SuperPNG 编码', write: '写入文件', done: '完成'};

  var ids = ['openLog', 'objectKind', 'refresh', 'objectName', 'sizeSource', 'sizeTarget', 'objectHint',
    'resetName', 'translate', 'openGlossary', 'translateNote', 'englishRow', 'englishAuto', 'englishName', 'englishEdit', 'englishReset', 'sizeHint', 'lockSize', 'prefix', 'clearPrefix', 'exportName', 'fileName', 'sizeGroup', 'minWidth', 'minHeight', 'anchorCenter', 'anchorTopLeft',
    'superPNG', 'directoryCount', 'addDirectory', 'directoryList', 'statusbar', 'statusTitle', 'statusDetail', 'statusOpen', 'statusLog',
    'cancelJob', 'canvasIcon', 'canvasDirName', 'canvasDirPath', 'canvasLast', 'canvasFolder', 'canvasSuperPNG', 'canvasExport', 'logPanel', 'logVerbose', 'logCopy', 'logFolder', 'logClose', 'logList', 'logNote', 'version', 'restoreSize', 'debug'];
  var el = {};
  ids.forEach(function (id) { el[id] = document.getElementById(id); });
  var objectCard = document.querySelector ? document.querySelector('.object') : null;
  var canvasCard = document.querySelector ? document.querySelector('.canvas-card') : null;

  var bridge = window.__adobe_cep__, M = null, logger = null, S = null, storage = null;
  var tracker = null, namer = null, current = null, trackerError = null;
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
  function persist() { if (storage) { M.settings.save(storage, S); } }

  var QUIET = /^Align4\.(describeSelection|describeDocument|selectionToken)\(/;
  function host(script, callback, timeout) {
    if (!bridge) { callback({ok: false, message: '请从 Photoshop 中打开插件。'}); return; }
    var name = script.slice(0, script.indexOf('(')), t0 = now(), done = false;
    // SuperPNG re-encodes the whole padded image inside Photoshop; big canvases need longer.
    var limit = timeout != null ? timeout : (/^Align4\.convertSuperPNG\(/.test(script) ? 180000 : 25000);
    var watchdog = limit === 0 ? null : window.setTimeout(function () {
      deliver({ok: false, code: 'ALIGN4_HOST_TIMEOUT', message: 'Photoshop 脚本在 ' + Math.round(limit / 1000) + ' 秒内未响应。可能正忙于其它操作，请稍后重试；如持续出现，请复制诊断信息。'});
    }, limit);
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
    var meta = current;
    if (trackerError) { setStatus('warn', trackerError, '切图需要在 Photoshop 中选中一个图层、图层组或画板；整图导出不受影响。'); return; }
    if (!meta) { setStatus('idle', '正在读取 Photoshop…', ''); return; }
    if (!S.directories.length) { setStatus('warn', '还没有切图目录', '在左侧“添加目录”后即可导出。'); return; }
    var nm = namer.state();
    if (nm.edited && !M.naming.normalize(nm.value)) { setStatus('warn', '请填写导出名称', '或点击“用图层名”。'); return; }
    var dir = recentDirectory();
    setStatus('ready', '就绪', '点击目录右侧的“导出”' + (dir ? '，或在名称框按 Enter 导出到「' + dir.name + '」' : '') + '。');
  }

  // ---------- Translation ----------
  var translator = null, translatorError = null, userCache = {mtime: -1, map: {}};
  function userGlossaryPath() { return M.path.join(M.env.APPDATA || M.os.tmpdir(), 'Align4Export', '我的术语表.csv'); }
  // Excel on Chinese Windows often saves CSV as GBK unless "CSV UTF-8" is chosen.
  function decodeText(buffer) {
    var text = buffer.toString('utf8');
    if (text.indexOf('\ufffd') >= 0 && window.TextDecoder) { try { text = new window.TextDecoder('gbk').decode(new Uint8Array(buffer)); } catch (e) {} }
    return text;
  }
  function userGlossary() {
    var p = userGlossaryPath();
    try {
      var st = M.fs.statSync(p);
      if (st.mtimeMs !== userCache.mtime) { userCache = {mtime: st.mtimeMs, map: M.translate.loadGlossary(decodeText(M.fs.readFileSync(p)))}; }
    } catch (e) { userCache = {mtime: -1, map: {}}; }
    return userCache.map;
  }
  function getTranslator() {
    if (translator || translatorError) { return translator; }
    try {
      var builtin = M.translate.loadGlossary(M.readData('glossary.csv'));
      var dict = JSON.parse(M.readData('dict.json')).words;
      translator = M.translate.create({user: userGlossary, builtin: builtin, dict: dict});
      logger.info('translate', '翻译已加载：内置术语 ' + Object.keys(builtin).length + ' 条，离线词典 ' + Object.keys(dict).length + ' 条');
    } catch (e) { translatorError = String(e.message || e); logger.error('translate', '翻译数据加载失败：' + translatorError); }
    return translator;
  }
  var CJK = /[\u3400-\u9fff]/;
  // English text is used exactly as typed; only Chinese gets translated.
  function autoEnglish(zh) {
    if (!S.translate || !zh) { return null; }
    if (!CJK.test(zh)) { return {text: zh, parts: [{src: zh, out: zh, source: 'ascii'}]}; }
    var t = getTranslator(); return t ? t.translate(zh) : null;
  }
  function translateName(name) { var a = autoEnglish(name); return a ? a.text : name; }
  // The user's English for the current Chinese name (from the "改" row), if any.
  var englishOverride = null; // {source, value}
  function finalName(zh) {
    if (!S.translate) { return zh; }
    if (englishOverride && englishOverride.source === zh && englishOverride.value.trim()) { return englishOverride.value.trim(); }
    return translateName(zh);
  }
  function ensureUserGlossary() {
    var p = userGlossaryPath();
    if (M.fs.existsSync(p)) { return p; }
    (function make(dir) { if (!M.fs.existsSync(dir)) { make(M.path.dirname(dir)); M.fs.mkdirSync(dir); } }(M.path.dirname(p)));
    M.fs.writeFileSync(p, '\ufeff' + ['中文,英文,备注', '# 我的术语表：优先于内置术语表。英文填 - 表示去掉这个词。导出前改过的译法会自动记到这里。,,',
      '# 用 Excel 编辑后请另存为“CSV UTF-8”。,,'].join('\r\n') + '\r\n', 'utf8');
    return p;
  }
  // Remember corrections: update an existing row or add a new one under the header.
  function rememberTranslations(pairs) {
    if (!pairs.length) { return 0; }
    var p = ensureUserGlossary(), rows = M.translate.parseCSV(decodeText(M.fs.readFileSync(p))), changed = 0;
    pairs.forEach(function (pair) {
      var hit = null;
      rows.forEach(function (r) { if (!hit && String(r[0] || '').trim() === pair[0]) { hit = r; } });
      if (hit) { if (hit[1] !== pair[1]) { hit[1] = pair[1]; hit[2] = '导出时修改'; changed++; } }
      else {
        var at = 0; while (at < rows.length && (rows[at][0] === '中文' || String(rows[at][0] || '').charAt(0) === '#')) { at++; }
        rows.splice(at, 0, [pair[0], pair[1], '导出时修改']); changed++;
      }
    });
    if (changed) {
      M.fs.writeFileSync(p, '\ufeff' + rows.filter(function (r) { return r.length && r.join('') !== ''; }).map(M.translate.csvLine).join('\r\n') + '\r\n', 'utf8');
      userCache.mtime = -1;
    }
    return changed;
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
  function oversize(img, min) { return (min.width && img.width > min.width) || (min.height && img.height > min.height); }
  function lastText(le) {
    return le.ok ? clock(le.time) + ' · ' + le.file + ' · ' + le.width + '×' + le.height : clock(le.time) + ' · 失败：' + le.message;
  }

  function renderObject() {
    var meta = current, m = meta && measured[meta.token], min = minSize();
    if (objectCard) { objectCard.className = 'object' + (meta ? '' : ' empty'); }
    if (!meta) {
      setText(el.objectKind, '未选择');
      setText(el.objectName, trackerError || '在 Photoshop 中选择一个对象');
      setText(el.sizeSource, '— × —'); setText(el.sizeTarget, '— × —'); setText(el.objectHint, ''); el.objectHint.title = ''; el.objectHint.className = 'hint';
      return;
    }
    setText(el.objectKind, meta.kind); setText(el.objectName, meta.name); el.objectName.title = meta.name;
    var source = m && (m.revision == null || m.revision === meta.revision) ? m : null;
    var hint = '', warn = false;
    var locked = S.sizeLocked && (min.width || min.height);
    if (source) {
      setText(el.sizeSource, source.width + ' × ' + source.height);
      var tw = M.rules.ceil4(Math.max(source.width, min.width)), th = M.rules.ceil4(Math.max(source.height, min.height));
      setText(el.sizeTarget, tw + ' × ' + th);
      var p = M.rules.padding(tw, th, source.width, source.height, S.anchor);
      hint = (tw === source.width && th === source.height) ? '已经是 4 的倍数，不需要补边。' :
        '透明补边：左 ' + p.left + ' · 右 ' + p.right + ' · 上 ' + p.top + ' · 下 ' + p.bottom + ' px（按上次导出时的实际尺寸估算）';
      if (locked && oversize(source, min)) { hint = '图像比固定尺寸大，这张会按图像尺寸补齐到 ' + tw + ' × ' + th + '，不会缩小。'; warn = true; }
    } else {
      setText(el.sizeSource, '导出时读取');
      setText(el.sizeTarget, locked ? (min.width && min.height ? min.width + ' × ' + min.height : '≥ ' + (min.width || '自动') + ' × ' + (min.height || '自动')) :
        min.width || min.height ? '≥ ' + (min.width || '自动') + ' × ' + (min.height || '自动') : '自动补齐');
      hint = locked ? '已固定输出尺寸；图像比它大时按图像尺寸补齐，不会缩小。' : '实际像素尺寸在导出时由 Photoshop 生成的 PNG 测得。';
    }
    if (!min.ok) { hint = '尺寸需为 1–30000 的整数。'; warn = true; }
    setText(el.objectHint, hint); el.objectHint.title = hint; el.objectHint.className = 'hint' + (warn ? ' warn' : '');
  }

  function renderNaming() {
    var nm = namer.state();
    // While typing, nm.value already equals the field, so this only fires for
    // selection changes / reset, and never interrupts an IME composition.
    if (el.exportName.value !== nm.value) { el.exportName.value = nm.value; }
    el.exportName.parentNode.className = 'field name-field' + (nm.edited ? ' custom' : '');
    el.resetName.disabled = !nm.edited || !!job;
    el.resetName.textContent = '用图层名';
    var zh = M.naming.normalize(el.exportName.value), note = null;
    // English row (translation on): automatic English with source marks, or the user's own English.
    el.englishRow.hidden = !S.translate;
    if (englishOverride && englishOverride.source !== zh) { englishOverride = null; } // the Chinese changed
    if (S.translate) {
      var auto = current && zh ? autoEnglish(zh) : null, overriding = !!englishOverride;
      el.englishAuto.hidden = overriding; el.englishName.hidden = !overriding;
      el.englishEdit.hidden = overriding; el.englishReset.hidden = !overriding;
      el.englishEdit.disabled = !auto || !!job; el.englishName.disabled = !!job; el.englishReset.disabled = !!job;
      clear(el.englishAuto);
      if (overriding) { if (document.activeElement !== el.englishName) { el.englishName.value = englishOverride.value; } }
      else if (auto) {
        var counts = {dict: 0, none: 0};
        auto.parts.forEach(function (p, i) {
          if (i) { el.englishAuto.appendChild(document.createTextNode('_')); }
          var span = make('span', p.source === 'dict' || p.source === 'none' ? 'part-' + p.source : null, p.out);
          span.title = p.src + ' → ' + p.out + '（' + ({user: '我的术语表', builtin: '内置术语表', dict: '离线词典，建议核对', none: '没有找到译法', ascii: '原文'}[p.source]) + '）';
          if (counts[p.source] != null) { counts[p.source]++; }
          el.englishAuto.appendChild(span);
        });
        note = counts.dict || counts.none ? counts : null;
      } else { el.englishAuto.appendChild(make('span', 'empty', translatorError ? '翻译数据加载失败' : '—')); }
    }
    clear(el.fileName);
    if (!current) { el.fileName.textContent = '—'; }
    else if (!zh) { el.fileName.appendChild(make('span', 'warn', '请填写导出名称')); }
    else { el.fileName.textContent = M.outputFiles.nameFor(el.prefix.value, finalName(zh)) + '.png'; }
    el.fileName.title = (el.fileName.textContent || '') + '（同名文件不会覆盖，自动追加 -2、-3…）';
    // The note line is reserved while translation is on, so the layout never jumps.
    clear(el.translateNote); el.translateNote.hidden = !S.translate;
    if (note) {
      if (note.dict) { el.translateNote.appendChild(make('i', 'k-dict', '黄色 ' + note.dict + ' 个来自离线词典，建议核对')); }
      if (note.dict && note.none) { el.translateNote.appendChild(document.createTextNode('；')); }
      if (note.none) { el.translateNote.appendChild(make('i', 'k-none', '红色 ' + note.none + ' 个没找到，保留中文')); }
      el.translateNote.appendChild(document.createTextNode('。点“改”修改英文，导出后会记到我的术语表。'));
    }
    el.translate.checked = S.translate;
    el.translate.disabled = !!job;
    el.clearPrefix.hidden = !el.prefix.value;
  }

  var FOLDER_SVG = '<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 5.2c0-.9.7-1.6 1.6-1.6h3.2l1.6 1.8h6c.9 0 1.6.7 1.6 1.6v6.6c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6V5.2z"/></svg>';
  var CANVAS_SVG = '<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="3" width="13" height="12" rx="1.6"/><path d="M2.5 11.5l3.6-3.4 3 2.8 2.2-2 4.2 3.8"/></svg>';

  // While exporting, the clicked button shows the elapsed time and becomes "取消" on hover.
  function runningButton(btn) {
    clear(btn);
    var time = make('span', 'run-time');
    time.appendChild(make('span', 'spinner')); time.appendChild(make('span', 'run-seconds', seconds(now() - job.started)));
    btn.appendChild(time); btn.appendChild(make('span', 'run-cancel', '取消'));
    btn.disabled = false; btn.title = '点击取消这次导出';
    btn.className = btn.className.replace(/\s*running-button/g, '') + ' running-button';
  }
  function cancelCurrent() {
    if (!job) { return; }
    var stage = job.stage;
    if (job.handle) { job.handle.cancel(); } // reports back through end()
    else { end(job, Object.assign(new Error('已取消导出。'), {code: 'ALIGN4_CANCELLED'})); }
    if (stage === 'superpng' && status) {
      // An ExtendScript call cannot be interrupted; Photoshop finishes it in the background.
      status.detail = 'Photoshop 可能还在完成这次 SuperPNG 编码，结果不会保存。稍等几秒再导出。'; renderStatus();
    }
  }

  function renderDirectories() {
    // The list is rebuilt on every refresh (selection changes, every 0.5s while
    // exporting): keep its scroll position and any name being edited.
    var scroll = el.directoryList.scrollTop, active = document.activeElement, editing = null;
    if (active && active.className === 'dest-name' && active.getAttribute) {
      editing = {id: active.getAttribute('data-id'), value: active.value, start: active.selectionStart, end: active.selectionEnd};
    }
    clear(el.directoryList);
    setText(el.directoryCount, S.directories.length);
    var recent = recentDirectory(), blocked = !!job || choosingFolder;
    var nm = namer.state();
    var cannot = !current ? '没有可导出的对象' : (nm.edited && !M.naming.normalize(nm.value)) ? '请先填写导出名称' : !minSize().ok ? '输出尺寸无效' : '';
    if (!S.directories.length) {
      var empty = make('div', 'empty-dest');
      empty.appendChild(make('p', null, '添加常用的切图目录，每个目录都有自己的导出按钮，点一下就导出到那里。'));
      var add = make('button', 'primary-button', '＋ 添加第一个目录');
      add.addEventListener('click', addDirectory); add.disabled = blocked;
      empty.appendChild(add); el.directoryList.appendChild(empty);
      return;
    }
    S.directories.forEach(function (d) {
      var running = job && job.target.id === d.id, exists = directoryExists(d.path);
      var row = make('div', 'dest' + (d === recent ? ' recent' : '') + (running ? ' running' : '') + (exists ? '' : ' missing'));
      var icon = make('span', 'dest-icon'); icon.innerHTML = FOLDER_SVG;
      var main = make('div', 'dest-main');
      var name = make('input', 'dest-name'); name.type = 'text'; name.value = d.name; name.setAttribute('data-id', d.id); name.title = '点击修改显示名称'; name.disabled = blocked; name.setAttribute('aria-label', '目录名称');
      name.addEventListener('change', function () { d.name = name.value.trim() || M.settings.basename(d.path); name.value = d.name; persist(); });
      name.addEventListener('keydown', function (e) { if (e.keyCode === 13) { name.blur(); } });
      var path = make('p', 'dest-path' + (exists ? ' openable' : ''), exists ? d.path : '目录不存在：' + d.path);
      path.title = exists ? '点击打开：' + d.path : d.path;
      if (exists) { path.addEventListener('click', function () { openFolder(d.path); }); }
      main.appendChild(name); main.appendChild(path);
      if (d.lastExport) { var last = make('p', 'dest-last ' + (d.lastExport.ok ? 'ok' : 'error'), lastText(d.lastExport)); last.title = last.textContent; main.appendChild(last); }
      var btn = make('button', 'dest-export');
      if (running) { runningButton(btn); }
      else {
        btn.textContent = '导出';
        btn.disabled = blocked || !!cannot || !exists;
        btn.title = !exists ? '目录不存在，请移除后重新添加' : cannot || ('导出到 ' + d.path);
      }
      btn.addEventListener('click', function () { if (running) { cancelCurrent(); } else { exportTo(d); } });
      var remove = make('button', 'dest-remove' + (pendingRemove === d.id ? ' confirm' : ''), pendingRemove === d.id ? '确认移除' : null);
      if (pendingRemove !== d.id) { remove.innerHTML = '<svg viewBox="0 0 10 10" width="8" height="8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>'; }
      remove.title = '从列表中移除（不会删除文件夹）'; remove.disabled = blocked; remove.setAttribute('aria-label', '移除目录 ' + d.name);
      remove.addEventListener('click', function () { removeDirectory(d); });
      row.appendChild(icon); row.appendChild(main); row.appendChild(btn); row.appendChild(remove);
      el.directoryList.appendChild(row);
      if (editing && editing.id === d.id && !name.disabled) {
        name.value = editing.value; name.focus();
        try { name.setSelectionRange(editing.start, editing.end); } catch (e) {}
      }
    });
    el.directoryList.scrollTop = scroll;
  }

  function renderCanvas() {
    var dir = S.canvasDirectory, exists = !!dir && directoryExists(dir), running = !!job && job.target.id === 'canvas', blocked = !!job || choosingFolder;
    if (canvasCard) { canvasCard.className = 'canvas-card' + (dir ? '' : ' unset') + (running ? ' running' : ''); }
    if (!el.canvasIcon.innerHTML) { el.canvasIcon.innerHTML = CANVAS_SVG; }
    setText(el.canvasDirName, dir ? M.settings.basename(dir) : '未选择目录');
    setText(el.canvasDirPath, dir ? (exists ? dir : '目录不存在：' + dir) : '整图使用单独的目录，与切图目录分开');
    el.canvasDirPath.title = exists ? '点击打开：' + dir : (dir || '');
    el.canvasDirPath.className = 'dest-path' + (exists ? ' openable' : '');
    setText(el.canvasFolder, dir ? '更换' : '选择目录'); el.canvasFolder.disabled = blocked;
    var le = S.canvasLastExport;
    el.canvasLast.hidden = !le;
    if (le) { el.canvasLast.className = 'dest-last ' + (le.ok ? 'ok' : 'error'); setText(el.canvasLast, lastText(le)); el.canvasLast.title = el.canvasLast.textContent; }
    el.canvasSuperPNG.checked = S.canvasSuperPNG; el.canvasSuperPNG.disabled = blocked;
    if (running) { runningButton(el.canvasExport); }
    else {
      el.canvasExport.className = 'canvas-export';
      setText(el.canvasExport, '导出整图');
      el.canvasExport.disabled = blocked || !exists;
      el.canvasExport.title = !dir ? '先选择整图目录' : !exists ? '目录不存在，请点“更换”' : '导出整张画布到 ' + dir + '（文件名：前缀 + 文档名）';
    }
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
    el.prefix.disabled = busy; el.exportName.disabled = busy || !current;
    var min0 = minSize(), lockable = !!(min0.width || min0.height) && min0.ok;
    el.minWidth.disabled = busy || S.sizeLocked; el.minHeight.disabled = busy || S.sizeLocked;
    el.lockSize.setAttribute('aria-pressed', String(S.sizeLocked));
    el.lockSize.disabled = busy || (!S.sizeLocked && !lockable);
    el.lockSize.title = S.sizeLocked ? '已固定：之后每张切图都按这个尺寸输出。点击解除' : lockable ? '固定后，之后的每张切图都按这个尺寸输出' : '先填写宽或高，再点固定';
    el.sizeGroup.className = 'group' + (S.sizeLocked ? ' size-locked' : '');
    setText(el.sizeHint, S.sizeLocked ? '已固定，切换对象后保持不变' : '留空自动补齐；填写的尺寸只用于当前对象');
    el.sizeHint.className = 'muted' + (S.sizeLocked ? ' locked' : '');
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
    renderObject(); renderNaming(); renderControls(); renderDirectories(); renderCanvas();
    if (!job && (!status || status.kind === 'idle' || status.kind === 'ready' || (status.kind === 'warn' && !status.sticky))) { idleStatus(); }
    else { renderStatus(); }
  }

  // ---------- Selection tracking ----------
  function onSelection(meta) {
    var previous = current;
    current = meta; trackerError = null;
    if (!previous || previous.token !== meta.token) {
      if (previous && !S.sizeLocked && (el.minWidth.value || el.minHeight.value)) {
        el.minWidth.value = ''; el.minHeight.value = ''; S.minWidth = ''; S.minHeight = ''; persist();
      }
      logger.info('selection', '选中 ' + meta.kind + '「' + meta.name + '」', {token: meta.token, revision: meta.revision});
    }
    namer.observe(meta);
    if (status && status.kind === 'warn' && !status.sticky) { status = null; }
    render();
  }
  function onTrackerError(message) {
    logger.warn('selection', message);
    current = null; trackerError = message;
    if (!job) { status = null; }
    render();
  }

  // ---------- Export ----------
  // target: {id, label, path, superPNG, setLast(entry)}
  function startJob(scope, target, details) {
    job = {id: ++jobSeq, target: target, scope: scope, started: now(), stage: 'prepare', attempts: 1, handle: null};
    pendingRemove = null; tracker.pause();
    logger.info('export.start', '开始' + (scope === 'canvas' ? '整图' : '切图') + '导出 → ' + target.label, details, job.id);
    showJobStatus();
    return job;
  }
  function runPipeline(meta, name, min) {
    var mine = job, t = mine.target;
    job.handle = M.exportJob.run({fs: M.fs, path: M.path, os: M.os, png: M.png, rules: M.rules, outputFiles: M.outputFiles, nativeExport: M.nativeExport, superPNG: M.superPNG,
      host: host, now: now, setTimeout: function (fn, ms) { return window.setTimeout(fn, ms); }, clearTimeout: function (h) { window.clearTimeout(h); }, log: logger, job: job.id}, {
      scope: job.scope, meta: meta, name: name, prefix: S.prefix, directory: t.path, minWidth: min.width, minHeight: min.height, anchor: S.anchor, superPNG: t.superPNG,
      onStage: function (stage, detail) { if (!job) { return; } job.stage = stage; if (detail && detail.attempts) { job.attempts = detail.attempts; } showJobStatus(); }
    }, function (error, record) { end(mine, error, record, meta); });
  }

  function exportTo(d) {
    if (job || closing) { return; }
    if (!directoryExists(d.path)) { existsCache = {}; setStatus('error', '目录不存在', d.path); render(); return; }
    var min = minSize();
    if (!min.ok) { setStatus('error', '输出尺寸无效', '宽高需为 1–30000 的整数，或留空自动补齐。'); return; }
    var mine = startJob('selection', {id: d.id, label: d.name, path: d.path, superPNG: S.superPNG, setLast: function (le) { d.lastExport = le; }},
      {directory: d.path, prefix: S.prefix, typedName: el.exportName.value, minWidth: min.width, minHeight: min.height, sizeLocked: S.sizeLocked, anchor: S.anchor, superPNG: S.superPNG});
    mine.locked = S.sizeLocked; mine.min = min;
    host('Align4.describeSelection()', function (meta) {
      if (job !== mine) { return; } // cancelled meanwhile
      if (!meta.ok) { end(mine, new Error(meta.message)); return; }
      current = meta;
      namer.resolve(meta, function (error, name, custom) {
        if (job !== mine) { return; }
        if (error) { end(mine, error); return; }
        var english = finalName(name);
        mine.naming = {source: name, name: english, override: !!(S.translate && englishOverride && englishOverride.source === name)};
        if (english !== name) { logger.info('translate', '「' + name + '」→ ' + english + (mine.naming.override ? '（手动修改）' : ''), undefined, mine.id); }
        name = english;
        logger.info('export.object', meta.kind + '「' + meta.name + '」，文件名 ' + M.outputFiles.nameFor(S.prefix, name) + '.png' + (custom ? '（自定义）' : ''), {token: meta.token, revision: meta.revision}, job.id);
        runPipeline(meta, name, min);
      });
    });
  }

  function exportCanvas() {
    if (job || closing) { return; }
    var dir = S.canvasDirectory;
    if (!dir) { chooseCanvasFolder(); return; }
    if (!directoryExists(dir)) { existsCache = {}; setStatus('error', '整图目录不存在', dir); render(); return; }
    var mine = startJob('canvas', {id: 'canvas', label: '整图目录', path: dir, superPNG: S.canvasSuperPNG, setLast: function (le) { S.canvasLastExport = le; }},
      {directory: dir, prefix: S.prefix, anchor: S.anchor, superPNG: S.canvasSuperPNG});
    host('Align4.describeDocument()', function (meta) {
      if (job !== mine) { return; }
      if (!meta.ok) { end(mine, new Error(meta.message)); return; }
      var name = M.naming.normalize(translateName(M.naming.normalize(meta.name))) || 'canvas';
      logger.info('export.object', '文档「' + meta.name + '」' + meta.width + '×' + meta.height + '，文件名 ' + M.outputFiles.nameFor(S.prefix, name) + '.png', {token: meta.token, revision: meta.revision}, job.id);
      runPipeline(meta, name, {width: 0, height: 0});
    });
  }

  var ticker = null;
  function showJobStatus() {
    if (!job) { return; }
    var elapsed = now() - job.started, detail = '已用 ' + seconds(elapsed);
    if (job.stage === 'native') {
      if (job.attempts > 1) { detail += ' · Generator 没有响应，已自动重发 ' + (job.attempts - 1) + ' 次'; }
      else if (elapsed > 5000) { detail += ' · 大文件需要更久，最多等 90 秒'; }
    } else if (job.stage === 'superpng' && elapsed > 5000) { detail += ' · 大图编码较慢，最多等 180 秒'; }
    detail += ' · 可随时取消';
    status = {kind: 'working', title: (job.scope === 'canvas' ? '整图：' : '') + (STAGE_TEXT[job.stage] || job.stage) + '…', detail: detail};
    renderStatus();
    var key = job.id + ':' + job.stage + ':' + job.attempts;
    if (job.rendered !== key) { job.rendered = key; renderControls(); renderDirectories(); renderCanvas(); }
    else {
      // Tick: update the timers in place so hovering "取消" is not disturbed by a rebuild.
      var spans = document.querySelectorAll ? document.querySelectorAll('.run-seconds') : [];
      for (var i = 0; i < spans.length; i++) { spans[i].textContent = seconds(elapsed); }
    }
    if (ticker === null) { ticker = window.setInterval(function () { if (job) { showJobStatus(); } else { window.clearInterval(ticker); ticker = null; } }, 500); }
  }

  function end(finished, error, record, meta) {
    if (!finished || job !== finished) { return; }
    var t = finished.target; job = null;
    if (ticker !== null) { window.clearInterval(ticker); ticker = null; }
    var took = seconds(now() - finished.started);
    if (error) {
      var cancelled = error.code === 'ALIGN4_CANCELLED';
      logger[cancelled ? 'warn' : 'error']('export.end', (cancelled ? '已取消' : '失败：' + String(error.message || error)) + '，用时 ' + took, {stage: finished.stage}, finished.id);
      if (!cancelled) { t.setLast({ok: false, time: now(), message: String(error.message || error)}); persist(); }
      status = {kind: cancelled ? 'warn' : 'error', title: cancelled ? '已取消导出' : (finished.scope === 'canvas' ? '整图导出失败' : '导出失败'), detail: String(error.message || error), log: !cancelled, sticky: true};
    } else {
      var file = M.path.basename(record.file);
      if (finished.scope === 'selection' && meta) { measured[meta.token] = {width: record.originalWidth, height: record.originalHeight, revision: meta.revision}; }
      t.setLast({ok: true, time: now(), file: file, width: record.width, height: record.height}); persist();
      lastResult = record;
      logger.info('export.end', '成功，总用时 ' + took, {file: record.file}, finished.id);
      var learned = 0;
      if (S.translate && finished.naming && finished.naming.override && getTranslator()) {
        try {
          var pairs = translator.learn(finished.naming.source, finished.naming.name);
          learned = rememberTranslations(pairs);
          if (learned) { logger.info('translate', '记住 ' + learned + ' 条译法', {pairs: pairs}, finished.id); }
          englishOverride = null; // the glossary now produces this English automatically
        } catch (e) { logger.warn('translate', '保存译法失败：' + String(e.message || e)); }
      }
      var padded = record.width !== record.originalWidth || record.height !== record.originalHeight;
      var over = finished.scope === 'selection' && finished.locked && oversize({width: record.originalWidth, height: record.originalHeight}, finished.min);
      status = {kind: over ? 'warn' : 'ok', title: (finished.scope === 'canvas' ? '整图已导出 ' : '已导出 ') + file + (over ? '（图像大于固定尺寸）' : ''), detail: record.width + ' × ' + record.height + (padded ? '（原 ' + record.originalWidth + ' × ' + record.originalHeight + '）' : '') +
        ' · ' + record.encoder + ' · ' + took + ' · ' + t.label + (learned ? ' · 已记住 ' + learned + ' 条译法' : ''), open: true, sticky: true};
    }
    tracker.resume(); tracker.refresh();
    render(); renderStatus();
  }

  function openFolder(dir) {
    host('Align4.openFolder(' + quote(dir) + ')', function (r) { if (!r.ok) { setStatus('error', '无法打开目录', r.message); } });
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

  function chooseCanvasFolder() {
    if (choosingFolder || job) { return; }
    choosingFolder = true; render();
    host('Align4.chooseFolder(' + quote(S.canvasDirectory || '') + ')', function (r) {
      choosingFolder = false;
      if (r.ok) { S.canvasDirectory = r.path; persist(); existsCache = {}; logger.info('directory', '整图目录设为 ' + r.path); }
      else if (!r.cancelled) { setStatus('error', '无法选择目录', r.message); status.sticky = true; }
      render();
    }, 0);
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
    return {version: VERSION, current: current, trackerError: trackerError, measured: measured,
      directories: S.directories, prefix: S.prefix, exportName: el.exportName.value, naming: namer.state(),
      minWidth: el.minWidth.value, minHeight: el.minHeight.value, anchor: S.anchor, superPNG: S.superPNG, sizeLocked: S.sizeLocked,
      canvasDirectory: S.canvasDirectory, canvasSuperPNG: S.canvasSuperPNG, canvasLastExport: S.canvasLastExport, lastResult: lastResult, status: status};
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
    el.canvasFolder.addEventListener('click', function () { chooseCanvasFolder(); });
    el.translate.addEventListener('change', function () {
      S.translate = !!el.translate.checked; persist();
      logger.info('setting', '翻译成英文 ' + (S.translate ? '开启' : '关闭'));
      if (S.translate && !getTranslator()) { setStatus('error', '翻译数据加载失败', translatorError || ''); }
      render();
    });
    function editEnglish() {
      if (job || !current) { return; }
      var zh = M.naming.normalize(el.exportName.value), auto = autoEnglish(zh);
      if (!auto) { return; }
      englishOverride = {source: zh, value: auto.text}; render();
      el.englishName.value = englishOverride.value; el.englishName.focus(); el.englishName.select();
    }
    el.englishEdit.addEventListener('click', editEnglish);
    el.englishAuto.addEventListener('click', editEnglish);
    el.englishAuto.addEventListener('keydown', function (e) { if (e.keyCode === 13 || e.keyCode === 32) { editEnglish(); } });
    ['input', 'change', 'compositionend', 'keyup'].forEach(function (type) {
      el.englishName.addEventListener(type, function () { if (englishOverride && englishOverride.value !== el.englishName.value) { englishOverride.value = el.englishName.value; renderNaming(); } });
    });
    el.englishName.addEventListener('blur', function () {
      // An empty edit, or one identical to the automatic English, is not an override.
      var auto = englishOverride && autoEnglish(englishOverride.source);
      if (englishOverride && (!englishOverride.value.trim() || (auto && englishOverride.value.trim() === auto.text))) { englishOverride = null; }
      render();
    });
    el.englishName.addEventListener('keydown', function (e) {
      if (e.keyCode === 13) { var d = recentDirectory(); if (d) { exportTo(d); } }
      else if (e.keyCode === 27) { englishOverride = null; render(); }
    });
    el.englishReset.addEventListener('click', function () { englishOverride = null; render(); });
    el.openGlossary.addEventListener('click', function () {
      try { var p = ensureUserGlossary(); host('Align4.openFile(' + quote(p) + ')', function (r) { if (!r.ok) { setStatus('error', '无法打开术语表', r.message + ' ' + p); } }); }
      catch (e) { setStatus('error', '无法创建术语表', String(e.message || e)); }
    });
    el.canvasExport.addEventListener('click', function () { if (job && job.target.id === 'canvas') { cancelCurrent(); } else { exportCanvas(); } });
    el.canvasDirPath.addEventListener('click', function () { if (S.canvasDirectory && directoryExists(S.canvasDirectory)) { openFolder(S.canvasDirectory); } });
    el.canvasSuperPNG.addEventListener('change', function () { S.canvasSuperPNG = !!el.canvasSuperPNG.checked; persist(); logger.info('setting', '整图 SuperPNG ' + (S.canvasSuperPNG ? '开启' : '关闭')); render(); });
    el.refresh.addEventListener('click', function () { existsCache = {}; status = null; tracker.refresh(); render(); });
    el.openLog.addEventListener('click', function () { setLogOpen(true); });
    el.statusLog.addEventListener('click', function () { setLogOpen(true); });
    el.logClose.addEventListener('click', function () { setLogOpen(false); });
    el.logVerbose.addEventListener('change', renderLog);
    el.logCopy.addEventListener('click', copyDiagnostics);
    el.logFolder.addEventListener('click', function () { if (logger.dir) { host('Align4.openFolder(' + quote(logger.dir) + ')', function (r) { if (!r.ok) { setStatus('error', '无法打开日志目录', r.message); } }); } });
    el.restoreSize.addEventListener('click', function () { try { bridge.resizeContent(760, 620); } catch (e) {} });
    el.cancelJob.addEventListener('click', cancelCurrent);
    el.statusOpen.addEventListener('click', function () { if (lastResult && lastResult.directory) { openFolder(lastResult.directory); } });
    el.addDirectory.addEventListener('click', addDirectory);
    el.anchorCenter.addEventListener('click', function () { S.anchor = 'center'; persist(); render(); });
    el.anchorTopLeft.addEventListener('click', function () { S.anchor = 'topLeft'; persist(); render(); });
    el.superPNG.addEventListener('change', function () { S.superPNG = !!el.superPNG.checked; persist(); logger.info('setting', '切图 SuperPNG ' + (S.superPNG ? '开启' : '关闭')); render(); });
    el.lockSize.addEventListener('click', function () {
      if (job) { return; }
      if (!S.sizeLocked) {
        var min = minSize(); if (!min.ok || !(min.width || min.height)) { return; }
        // Fixed sizes are output sizes, so store them already rounded up to 4.
        if (min.width) { el.minWidth.value = M.rules.ceil4(min.width); }
        if (min.height) { el.minHeight.value = M.rules.ceil4(min.height); }
        S.minWidth = el.minWidth.value; S.minHeight = el.minHeight.value;
      }
      S.sizeLocked = !S.sizeLocked; persist();
      logger.info('setting', S.sizeLocked ? '固定输出尺寸 ' + (S.minWidth || '自动') + ' × ' + (S.minHeight || '自动') : '解除固定尺寸');
      render();
    });
    function sizeChanged() { S.minWidth = el.minWidth.value; S.minHeight = el.minHeight.value; persist(); render(); }
    ['input', 'change'].forEach(function (t) { el.minWidth.addEventListener(t, sizeChanged); el.minHeight.addEventListener(t, sizeChanged); });
    function prefixChanged() { if (el.prefix.value !== S.prefix) { S.prefix = el.prefix.value; persist(); render(); } }
    ['input', 'change', 'compositionend', 'keyup', 'blur'].forEach(function (t) { el.prefix.addEventListener(t, prefixChanged); });
    el.clearPrefix.addEventListener('click', function () { el.prefix.value = ''; prefixChanged(); el.prefix.focus(); });
    // Some CEP / IME combinations only deliver compositionend or keyup; any of them commits.
    function nameChanged() { namer.edit(el.exportName.value); }
    ['input', 'change', 'compositionend', 'keyup'].forEach(function (t) { el.exportName.addEventListener(t, nameChanged); });
    el.exportName.addEventListener('blur', function () { nameChanged(); render(); });
    el.exportName.addEventListener('keydown', function (e) {
      if (e.keyCode === 13) { nameChanged(); var d = recentDirectory(); if (d) { exportTo(d); } }
    });
    el.resetName.addEventListener('click', function () { namer.reset(); el.exportName.value = namer.state().value; render(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && tracker) { tracker.poke(); } });
    window.addEventListener('focus', function () { existsCache = {}; if (S.translate && translator) { renderNaming(); } if (tracker) { tracker.poke(); } });
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
      diagnostics: mod('diagnostics'), naming: mod('naming'), selection: mod('selection'), settings: mod('settings'), translate: mod('translate'),
      readData: function (name) { return rq('fs').readFileSync(path.join(base, 'data', name), 'utf8'); }};
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

    namer = M.naming.create({
      query: function (cb) { host('Align4.selectionToken()', cb); },
      onChange: function () { if (M && S) { renderNaming(); renderDirectories(); if (!job && status && (status.kind === 'ready' || status.kind === 'warn') && !status.sticky) { idleStatus(); } } },
      onOwnerResolved: function () { if (tracker) { tracker.poke(); } }
    });
    tracker = M.selection.create({host: host, setTimeout: function (fn, ms) { return window.setTimeout(fn, ms); }, clearTimeout: function (t) { window.clearTimeout(t); },
      hidden: function () { return !!document.hidden; }, mode: function () { return 'selection'; }, onChange: onSelection, onError: onTrackerError});

    if (!S.sizeLocked) { S.minWidth = ''; S.minHeight = ''; }
    el.prefix.value = S.prefix; el.superPNG.checked = S.superPNG; el.minWidth.value = S.minWidth || ''; el.minHeight.value = S.minHeight || '';
    setText(el.version, 'v' + VERSION);
    applyTheme(); bind(); render();
    if (bridge) { registerPhotoshopEvents(); }
    tracker.start();
  }

  start();
  // Exposed for automated tests and the browser preview.
  window.Align4Panel = {exportTo: function (index) { exportTo(S.directories[index]); }, state: panelState, tracker: function () { return tracker; },
    exportCanvas: exportCanvas, namer: function () { return namer; }, settings: function () { return S; }, render: render};
}());

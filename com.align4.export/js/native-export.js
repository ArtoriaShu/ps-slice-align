'use strict';
// Photoshop's Quick Export is handed to Generator and returns immediately; the PNG
// appears later, or never if Generator drops the request (cold start, large PSD
// being re-read). So: watch every requested directory, re-send the command into a
// fresh directory when nothing shows up, and accept the first complete PNG.

var PREFIX = /^align4-(native|canvas|superpng)-/;

exports.DEFAULTS = {
  poll: 250,                  // ms between directory scans
  resendAfter: [10000, 30000],// ms after the first send: re-issue the command if no file has appeared
  timeout: 90000,             // ms before giving up entirely
  progressEvery: 1000
};

function remove(fs, path, p) {
  if (!fs.existsSync(p)) { return; }
  var stat = fs.lstatSync(p);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.readdirSync(p).forEach(function (n) { remove(fs, path, path.join(p, n)); });
    fs.rmdirSync(p);
  } else { fs.unlinkSync(p); }
}
exports.remove = remove;

// Remove old temp directories left by abandoned/timed-out attempts. A late
// Generator write may still land in a recent one, so only stale ones go.
exports.sweep = function (o, maxAge) {
  var root = o.os.tmpdir(), limit = o.now() - (maxAge || 3600000), removed = 0;
  try {
    o.fs.readdirSync(root).forEach(function (name) {
      if (!PREFIX.test(name)) { return; }
      var p = o.path.join(root, name);
      try { if (o.fs.lstatSync(p).mtimeMs < limit) { remove(o.fs, o.path, p); removed++; } } catch (ignore) {}
    });
  } catch (ignore) {}
  return removed;
};

function scan(fs, path, dir, depth) {
  var out = [];
  if (depth > 4) { return out; }
  fs.readdirSync(dir).forEach(function (name) {
    var file = path.join(dir, name), stat;
    try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') { return; } throw e; }
    if (stat.isDirectory() && !stat.isSymbolicLink()) { out = out.concat(scan(fs, path, file, depth + 1)); }
    else if (stat.isFile() && /\.png$/i.test(name)) { out.push({file: file, size: stat.size}); }
  });
  return out;
}

// o: {fs, path, os, png, host, now, setTimeout, clearTimeout, log, job}
// spec: {prefix, script(dir) -> host script, label, multipleMessage, onProgress(info), poll, resendAfter, timeout}
// callback(error, {data, measured, file, attempt, elapsed})
exports.run = function (o, spec, callback) {
  var cfg = {}, k;
  for (k in exports.DEFAULTS) { cfg[k] = spec[k] != null ? spec[k] : exports.DEFAULTS[k]; }
  var log = o.log || {debug: function () {}, info: function () {}, warn: function () {}, error: function () {}};
  var attempts = [], started = null, finished = false, timer = null, lastProgress = 0, lastError = '', fileSeen = false;
  var state = {phase: 'command', attempts: 0, elapsed: 0, directories: [], error: null};

  function elapsed() { return started === null ? 0 : o.now() - started; }
  function secs(ms) { return Math.round(ms / 100) / 10; }

  function finish(error, result) {
    if (finished) { return; }
    finished = true;
    if (timer !== null) { o.clearTimeout(timer); timer = null; }
    state.phase = error ? 'failed' : 'complete'; state.elapsed = elapsed(); state.error = error ? String(error.message || error) : null;
    if (result) {
      // The winning file is fully written and read into memory; its directory can go.
      try { remove(o.fs, o.path, result.dir); } catch (ignore) {}
    }
    callback(error, result);
  }

  function issue(number) {
    var dir;
    try { dir = o.fs.mkdtempSync(o.path.join(o.os.tmpdir(), spec.prefix || 'align4-native-')); }
    catch (e) { log.error('native.mkdtemp', '无法创建临时目录', {error: String(e.message || e)}, o.job); finish(e); return; }
    var attempt = {number: number, dir: dir, alive: true, sent: false, sentAt: o.now(), size: -1, stable: 0, seenAt: null};
    attempts.push(attempt); state.attempts = attempts.length; state.directories.push(dir);
    log.info('native.send', (number === 1 ? '发送' : '重发') + (spec.label || '快速导出') + '命令（第 ' + number + ' 次）', {dir: dir, at: secs(elapsed())}, o.job);
    var t0 = o.now();
    o.host(spec.script(dir), function (r) {
      if (finished) { return; }
      var ms = o.now() - t0;
      if (!r || !r.ok) {
        var error = new Error((r && r.message) || '快速导出命令失败。');
        error.code = r && r.code;
        log.error('native.command', '命令返回失败（' + ms + 'ms）', {attempt: number, code: error.code, message: error.message}, o.job);
        finish(error);
        return;
      }
      attempt.sent = true;
      log.debug('native.command', '命令已被 Photoshop 接受（' + ms + 'ms）', {attempt: number}, o.job);
      if (started === null) { started = t0; state.phase = 'waiting'; schedule(0); }
    });
  }

  function schedule(delay) { if (!finished && timer === null) { timer = o.setTimeout(poll, delay); } }

  function check(attempt) {
    if (!o.fs.existsSync(attempt.dir)) {
      attempt.alive = false;
      log.warn('native.missing', '临时目录被删除', {attempt: attempt.number, dir: attempt.dir}, o.job);
      return null;
    }
    var files = scan(o.fs, o.path, attempt.dir, 0);
    if (files.length > 1) {
      var multi = new Error(spec.multipleMessage || '原生导出了多个 PNG，请每次只选一个对象。'); multi.code = 'ALIGN4_MULTIPLE';
      throw multi;
    }
    if (!files.length) { return null; }
    var f = files[0];
    if (attempt.seenAt === null) {
      attempt.seenAt = o.now(); fileSeen = true;
      log.info('native.file', '第 ' + attempt.number + ' 次请求的 PNG 开始写入（' + secs(elapsed()) + 's）', {file: f.file, bytes: f.size}, o.job);
    }
    // Read only once the size stops changing: avoids re-reading and CRC-checking
    // a large file every poll while Generator is still writing it.
    if (f.size > 0 && f.size === attempt.size) { attempt.stable++; } else { attempt.stable = 0; attempt.size = f.size; }
    if (attempt.stable < 1) { return null; }
    var data = o.fs.readFileSync(f.file), measured;
    try { measured = o.png.parse(data); }
    catch (e) { lastError = String(e.message || e); attempt.stable = 0; attempt.size = -1; return null; }
    return {file: f.file, dir: attempt.dir, data: data, measured: measured, attempt: attempt.number};
  }

  function poll() {
    timer = null;
    if (finished) { return; }
    var i, result = null;
    try {
      for (i = 0; i < attempts.length && !result; i++) {
        if (attempts[i].alive && attempts[i].sent) { result = check(attempts[i]); }
      }
    } catch (e) {
      if (e.code === 'ALIGN4_MULTIPLE' || (e.code && e.code !== 'ENOENT' && e.code !== 'EBUSY' && e.code !== 'EPERM')) {
        log.error('native.read', String(e.message || e), {code: e.code}, o.job); finish(e); return;
      }
      lastError = String(e.message || e);
    }
    var ms = elapsed();
    if (result) {
      result.elapsed = ms;
      log.info('native.done', 'PNG 完成：' + result.measured.width + '×' + result.measured.height + '，用时 ' + secs(ms) + 's（第 ' + result.attempt + ' 次请求）',
        {bytes: result.data.length, attempts: attempts.length}, o.job);
      finish(null, result); return;
    }
    var alive = attempts.filter(function (a) { return a.alive; }).length;
    var due = cfg.resendAfter[attempts.length - 1];
    var canResend = attempts.length <= cfg.resendAfter.length;
    if ((alive === 0 || (!fileSeen && due != null && ms >= due)) && canResend) {
      if (alive > 0) { log.warn('native.silent', secs(ms) + 's 内没有任何 PNG 出现，判断请求可能被 Generator 丢弃，重发', {attempts: attempts.length}, o.job); }
      issue(attempts.length + 1);
      if (finished) { return; }
    } else if (alive === 0) {
      var gone = new Error('临时导出目录多次丢失，已停止等待。'); gone.code = 'ALIGN4_TEMP_MISSING'; finish(gone); return;
    }
    if (ms >= cfg.timeout) {
      var error = new Error('等待 ' + Math.round(ms / 1000) + ' 秒仍未得到完整 PNG（共发送 ' + attempts.length + ' 次请求' + (fileSeen ? '，文件已开始写入但未完成' : '，没有任何文件出现') + '）。' +
        (lastError ? '读取信息：' + lastError : ''));
      error.code = 'ALIGN4_PNG_TIMEOUT';
      log.error('native.timeout', error.message, {attempts: attempts.length, fileSeen: fileSeen, directories: state.directories}, o.job);
      finish(error); return;
    }
    if (spec.onProgress && ms - lastProgress >= cfg.progressEvery) {
      lastProgress = ms;
      try { spec.onProgress({elapsed: ms, attempts: attempts.length, fileSeen: fileSeen}); } catch (ignore) {}
    }
    state.elapsed = ms;
    schedule(cfg.poll);
  }

  issue(1);
  return {
    state: state,
    cancel: function () {
      if (finished) { return; }
      finished = true; state.phase = 'cancelled';
      if (timer !== null) { o.clearTimeout(timer); timer = null; }
      log.warn('native.cancel', '已取消等待', {elapsed: secs(elapsed())}, o.job);
    }
  };
};

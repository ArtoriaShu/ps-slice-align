'use strict';
// Structured run log: kept in memory for the panel and appended to a daily file
// so a failed export can still be inspected after Photoshop restarts.

var LEVELS = {debug: 10, info: 20, warn: 30, error: 40};

function pad(n, width) { var s = String(n); while (s.length < (width || 2)) { s = '0' + s; } return s; }
function day(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function clock(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3); }

function safeJSON(data) {
  if (data === undefined) { return ''; }
  try { return JSON.stringify(data); } catch (e) { return '"[unserializable]"'; }
}

exports.format = function (entry, withDate) {
  var d = new Date(entry.time);
  var head = (withDate ? day(d) + ' ' : '') + clock(d) + ' ' + (entry.level.toUpperCase() + '     ').slice(0, 5) + ' ';
  var job = entry.job ? '#' + entry.job + ' ' : '';
  var data = safeJSON(entry.data);
  return head + job + entry.event + '  ' + entry.message + (data ? '  ' + data : '');
};

// o: {fs, path, dir, now, keepDays, maxEntries}
exports.create = function (o) {
  var entries = [], listeners = [], maxEntries = o.maxEntries || 3000, writeError = null, ensured = false;
  var now = o.now || Date.now;

  function file(time) { return o.dir ? o.path.join(o.dir, 'align4-' + day(new Date(time || now())) + '.log') : null; }

  function ensure() {
    if (ensured || !o.dir) { return; }
    ensured = true;
    // Manual recursion: CEP 9 ships Node 8, which lacks {recursive: true}.
    (function make(dir) {
      if (o.fs.existsSync(dir)) { return; }
      var parent = o.path.dirname(dir); if (parent !== dir) { make(parent); }
      try { o.fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') { writeError = String(e.message || e); } }
    }(o.dir));
    prune();
  }

  function prune() {
    var keep = (o.keepDays || 7) * 86400000, limit = now() - keep;
    try {
      o.fs.readdirSync(o.dir).forEach(function (name) {
        var m = /^align4-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
        if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < limit) { o.fs.unlinkSync(o.path.join(o.dir, name)); }
      });
    } catch (ignore) {}
  }

  function write(entry) {
    if (!o.dir || !o.fs) { return; }
    ensure();
    try { o.fs.appendFileSync(file(entry.time), exports.format(entry, true) + '\n', 'utf8'); writeError = null; }
    catch (e) { writeError = String(e.message || e); }
  }

  function log(level, event, message, data, job) {
    var entry = {time: now(), level: LEVELS[level] ? level : 'info', event: String(event), message: String(message || ''), data: data, job: job || null};
    entries.push(entry);
    if (entries.length > maxEntries) { entries.splice(0, entries.length - maxEntries); }
    write(entry);
    listeners.forEach(function (fn) { try { fn(entry); } catch (ignore) {} });
    return entry;
  }

  return {
    log: log,
    debug: function (event, message, data, job) { return log('debug', event, message, data, job); },
    info: function (event, message, data, job) { return log('info', event, message, data, job); },
    warn: function (event, message, data, job) { return log('warn', event, message, data, job); },
    error: function (event, message, data, job) { return log('error', event, message, data, job); },
    entries: function (minLevel) {
      var floor = LEVELS[minLevel] || 0;
      return entries.filter(function (e) { return LEVELS[e.level] >= floor; });
    },
    onEntry: function (fn) { listeners.push(fn); },
    file: function () { return file(); },
    dir: o.dir || null,
    writeError: function () { return writeError; }
  };
};

exports.LEVELS = LEVELS;

// A logger that drops everything; used before the real one is configured.
exports.noop = function () {
  function nothing() { return null; }
  return {log: nothing, debug: nothing, info: nothing, warn: nothing, error: nothing,
    entries: function () { return []; }, onEntry: nothing, file: nothing, dir: null, writeError: nothing};
};

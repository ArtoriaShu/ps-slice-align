'use strict';
// Builds the text a user copies and sends back: environment, the plugin's own run
// log, panel state, and the tail of Photoshop's Generator log.

var format = require('./logger').format;

function newest(fs, path, dir, out) {
  try {
    fs.readdirSync(dir).forEach(function (name) {
      if (!/\.(txt|log)$/i.test(name)) { return; }
      var file = path.join(dir, name);
      try { var s = fs.statSync(file); if (s.isFile()) { out.push({file: file, mtime: s.mtimeMs, size: s.size}); } } catch (ignore) {}
    });
  } catch (ignore) {}
}

// Generator writes its logs under %APPDATA%\Adobe\Adobe Photoshop <ver>\Generator\logs
// (some versions omit "logs", some use LOCALAPPDATA; current ones use Logs\Generator).
// Search all; prefer the running Photoshop's folder (o.prefer, e.g. "2020"), then the newest.
exports.findGeneratorLog = function (o) {
  var roots = [], searched = [], files = [];
  [o.env.APPDATA, o.env.LOCALAPPDATA].forEach(function (base) { if (base) { roots.push(o.path.join(base, 'Adobe')); } });
  roots.forEach(function (root) {
    var names = [];
    try { names = o.fs.readdirSync(root); } catch (e) { searched.push(root + '（不存在）'); return; }
    names.filter(function (n) { return /photoshop/i.test(n); }).forEach(function (n) {
      [['Generator', 'logs'], ['Generator'], ['Logs', 'Generator']].forEach(function (parts) {
        var dir = o.path.join.apply(o.path, [root, n].concat(parts)), before = files.length;
        searched.push(dir); newest(o.fs, o.path, dir, files);
        for (var i = before; i < files.length; i++) { files[i].folder = n; files[i].preferred = !!o.prefer && n.indexOf(o.prefer) >= 0; }
      });
    });
  });
  files.sort(function (a, b) { return (b.preferred - a.preferred) || (b.mtime - a.mtime); });
  return {file: files.length ? files[0] : null, searched: searched};
};

// Photoshop's version number -> the year in its folder name (21.x -> "2020").
exports.yearFor = function (appVersion) {
  var major = parseInt(String(appVersion || ''), 10);
  return major >= 20 ? String(major + 1999) : null;
};

exports.tail = function (fs, file, maxLines, maxBytes) {
  var size = fs.statSync(file).size, length = Math.min(size, maxBytes || 65536), buffer = Buffer.alloc(length);
  var fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
  var lines = buffer.toString('utf8').split(/\r?\n/);
  if (length < size) { lines.shift(); } // first line is probably cut
  while (lines.length && !lines[lines.length - 1]) { lines.pop(); }
  return lines.slice(-(maxLines || 80));
};

exports.generatorSection = function (o, maxLines) {
  var found = exports.findGeneratorLog(o);
  if (!found.file) { return '未找到 Generator 日志。已查找：\n  ' + (found.searched.join('\n  ') || '（无 APPDATA）'); }
  var when = new Date(found.file.mtime);
  var head = found.file.file + '（' + found.file.folder + (o.prefer ? (found.file.preferred ? '，与当前 Photoshop 版本一致' : '，未找到 ' + o.prefer + ' 版的日志，这是其它版本的') : '') +
    '，' + Math.round(found.file.size / 1024) + ' KB，最后修改 ' + when.toLocaleString() + '）';
  try { return head + '\n' + exports.tail(o.fs, found.file.file, maxLines || 80).join('\n'); }
  catch (e) { return head + '\n读取失败：' + String(e.message || e); }
};

// parts: {version, environment, state, entries, generator, logFile}
exports.bundle = function (parts) {
  var lines = [];
  lines.push('==== 4 倍数导出 诊断信息 ====');
  lines.push('插件版本：' + parts.version + '    生成时间：' + new Date().toLocaleString());
  lines.push('日志文件：' + (parts.logFile || '（未写入文件）'));
  lines.push('');
  lines.push('---- 环境 ----');
  lines.push(JSON.stringify(parts.environment || null, null, 2));
  lines.push('');
  lines.push('---- 运行日志（最近 ' + parts.entries.length + ' 条） ----');
  parts.entries.forEach(function (e) { lines.push(format(e, true)); });
  lines.push('');
  lines.push('---- 面板状态 ----');
  lines.push(JSON.stringify(parts.state || null, null, 2));
  lines.push('');
  lines.push('---- Generator 日志（末尾） ----');
  lines.push(parts.generator || '（未读取）');
  return lines.join('\n');
};

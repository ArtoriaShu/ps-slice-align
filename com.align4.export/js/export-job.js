'use strict';
// One export, start to finish. Every entry point (any directory, slice or whole
// canvas) runs this same pipeline:
//   native PNG (Generator) -> verify object unchanged -> pad to 4x -> SuperPNG (optional)
//   -> verify again -> write with collision numbering.

function quote(s) { return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

exports.STAGES = {
  native: '等待 Photoshop 生成 PNG',
  verify: '核对对象是否改变',
  pad: '补齐到 4 的倍数',
  superpng: 'SuperPNG 编码',
  write: '写入文件',
  done: '完成'
};

// o: {fs, path, os, png, rules, outputFiles, nativeExport, superPNG, host, now, setTimeout, clearTimeout, log, job}
// request: {scope:'selection'|'canvas', meta (fresh describe result), name, prefix, directory,
//           minWidth, minHeight, anchor, superPNG, onStage(stage, detail)}
// callback(error, record)
exports.run = function (o, request, callback) {
  var meta = request.meta, finished = false, nativeJob = null, started = o.now(), canvas = request.scope === 'canvas';
  var log = o.log;
  var state = {stage: 'native', attempts: 0, elapsed: 0, error: null, cancelled: false};
  var describe = canvas ? 'Align4.describeDocument()' : 'Align4.describeSelection()';

  function stage(name, detail) {
    state.stage = name;
    if (request.onStage) { try { request.onStage(name, detail || {}); } catch (ignore) {} }
  }
  function finish(error, record) {
    if (finished) { return; }
    finished = true; state.elapsed = o.now() - started; state.error = error ? String(error.message || error) : null;
    if (nativeJob) { nativeJob.cancel(); nativeJob = null; }
    callback(error, record);
  }
  function fail(message) { finish(new Error(message)); }

  // The object must be the same one, with the same history state, as when we started.
  function verify(reason, next) {
    stage('verify');
    o.host(describe, function (current) {
      if (finished) { return; }
      if (!current || !current.ok) { fail((current && current.message) || '无法确认当前对象。'); return; }
      if (current.token !== meta.token) { fail(canvas ? '当前文档已改变（' + reason + '），未保存。' : '选择已改变（' + reason + '），未保存，请重新导出。'); return; }
      if (meta.revision != null && current.revision != null && current.revision !== meta.revision) {
        fail('内容在' + reason + '期间被编辑，未保存，请停止编辑后重新导出。'); return;
      }
      if (canvas && (current.width !== meta.width || current.height !== meta.height)) { fail('画布尺寸在导出期间改变，未保存。'); return; }
      next();
    });
  }

  function onNative(error, result) {
    nativeJob = null;
    if (finished) { return; }
    if (error) { finish(error); return; }
    state.attempts = result.attempt;
    verify('生成 PNG', function () { pad(result); });
  }

  function pad(result) {
    stage('pad');
    var measured = result.measured, data, w, h, t0 = o.now();
    try {
      if (canvas && (measured.width !== meta.width || measured.height !== meta.height)) {
        throw new Error('原生输出 ' + measured.width + '×' + measured.height + ' 与画布 ' + meta.width + '×' + meta.height + ' 不一致，未保存。此文档可能使用了画板；整图导出要求单张完整画布。');
      }
      w = o.rules.ceil4(Math.max(measured.width, canvas ? 0 : (request.minWidth || 0)));
      h = o.rules.ceil4(Math.max(measured.height, canvas ? 0 : (request.minHeight || 0)));
      if (!o.rules.valid(w, h, measured.width, measured.height)) { throw new Error('目标尺寸 ' + w + '×' + h + ' 超出支持范围（最大 30000）。'); }
      data = o.png.pad(result.data, w, h, request.anchor || 'center');
    } catch (e) { finish(e); return; }
    log.info('pad', measured.width + '×' + measured.height + ' → ' + w + '×' + h + '（' + (o.now() - t0) + 'ms）', {anchor: request.anchor}, o.job);
    var record = {scope: request.scope, name: request.name, objectName: meta.name, width: w, height: h,
      originalWidth: measured.width, originalHeight: measured.height, encoder: request.superPNG ? 'SuperPNG' : 'PNG',
      directory: request.directory, file: null, attempts: result.attempt};
    encode(data, record);
  }

  function encode(data, record) {
    if (!request.superPNG) { write(data, record); return; }
    stage('superpng');
    var t0 = o.now();
    o.superPNG.encode({fs: o.fs, path: o.path, os: o.os, png: o.png, host: o.host}, data, true, function (error, encoded) {
      if (finished) { return; }
      if (error) { log.error('superpng', 'SuperPNG 失败（' + (o.now() - t0) + 'ms）', {message: String(error.message || error)}, o.job); finish(error); return; }
      log.info('superpng', 'SuperPNG 完成（' + (o.now() - t0) + 'ms）', {bytes: encoded.length}, o.job);
      // SuperPNG briefly activates its own document; check the source again.
      verify('SuperPNG 编码', function () { write(encoded, record); });
    });
  }

  function write(data, record) {
    stage('write');
    try {
      var exportName = o.outputFiles.nameFor(request.prefix, request.name);
      var saved = o.outputFiles.save(o.fs, o.path, o.png, request.directory, exportName, data);
      record.file = saved.path;
    } catch (e) {
      log.error('write', '写入失败：' + request.directory, {message: String(e.message || e)}, o.job);
      finish(e); return;
    }
    log.info('write', '已写入 ' + record.file, {width: record.width, height: record.height}, o.job);
    stage('done');
    finish(null, record);
  }

  stage('native');
  nativeJob = o.nativeExport.run(o, {
    prefix: canvas ? 'align4-canvas-' : 'align4-native-',
    label: canvas ? '整图快速导出' : '快速导出',
    multipleMessage: canvas ? '原生整图导出生成了多个 PNG（可能含多个画板），已停止保存。整图导出只支持单张完整画布。' : '原生导出了多个 PNG，请每次只选一个对象。',
    script: function (dir) { return (canvas ? 'Align4.startNativeCanvas(' : 'Align4.startNative(') + quote(meta.token) + ',' + quote(dir) + ')'; },
    onProgress: function (p) { state.attempts = p.attempts; stage('native', p); }
  }, onNative);

  return {
    state: state,
    cancel: function () {
      if (finished) { return; }
      state.cancelled = true;
      log.warn('export.cancel', '用户取消', {stage: state.stage}, o.job);
      finish(Object.assign(new Error('已取消导出。'), {code: 'ALIGN4_CANCELLED'}));
    }
  };
};

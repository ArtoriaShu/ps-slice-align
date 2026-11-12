'use strict';
// Export-name ownership. A typed name belongs to the selection that was current
// *when it was typed* (asked from Photoshop, not taken from the last UI refresh,
// which can lag behind). It is used only while that object is still selected.

function normalize(value) {
  return String(value == null ? '' : value).replace(/^\s+|\s+$/g, '').replace(/\.png$/i, '').replace(/\s+$/g, '');
}
exports.normalize = normalize;

// o: {query(callback(meta)) -> asks Photoshop for the current selection token,
//     onChange(state)        -> field text should be refreshed,
//     onOwnerResolved()      -> a fresh selection check is worthwhile}
//     transform(name)        -> optional, e.g. translation of the layer name}
exports.create = function (o) {
  var value = '', source = '', sourceToken = null, edited = false, owner = null, lastMeta = null;
  function sourceOf(meta) { var n = normalize(meta.name); return normalize(o.transform ? o.transform(n) : n); }
  var seq = 0, pending = null; // pending: {seq, waiters, error}

  function emit() { if (o.onChange) { o.onChange(state()); } }
  function state() { return {value: value, source: source, edited: edited, owner: owner, pending: !!pending}; }

  // The tracker reports the selection it sees.
  function observe(meta) {
    lastMeta = meta; sourceToken = meta.token; source = sourceOf(meta);
    if (edited && !pending && owner !== meta.token) { edited = false; owner = null; }
    if (!edited) { value = source; }
    emit();
  }

  // The user changed the text. Only real changes rebind ownership.
  function edit(text) {
    text = String(text == null ? '' : text);
    if (text === value) { return; } // focus/blur/keyup without a real change
    value = text; edited = true;
    var mine = ++seq, entry = {seq: mine, waiters: [], error: null};
    pending = entry; emit();
    o.query(function (meta) {
      if (entry.seq === seq) {
        pending = null;
        if (meta && meta.ok) { owner = meta.token; } else { owner = null; entry.error = (meta && meta.message) || '无法确认当前选择。'; }
        emit();
        if (o.onOwnerResolved) { o.onOwnerResolved(); }
      }
      entry.waiters.forEach(function (fn) { fn(); }); entry.waiters = [];
    });
  }

  function reset() { seq++; pending = null; edited = false; owner = null; value = source; emit(); }

  // At export time, with a fresh description of the object being exported.
  // callback(error, name, nameWasCustom)
  function resolve(meta, callback) {
    if (pending) {
      var entry = pending;
      entry.waiters.push(function () { if (pending) { resolve(meta, callback); } else { finish(entry.error); } });
      return;
    }
    finish(null);
    function finish(error) {
      if (error) { callback(new Error(error)); return; }
      if (edited && owner === meta.token) {
        var name = normalize(value);
        // An empty name simply means "use the layer name".
        callback(null, name || normalize(meta.name) || 'image', !!name); return;
      }
      if (edited && owner !== meta.token) { edited = false; owner = null; }
      lastMeta = meta; source = sourceOf(meta); sourceToken = meta.token; value = source; emit();
      callback(null, source || 'image', false);
    }
  }

  // The transform changed (translation switched on/off, glossary edited): recompute the default.
  function retransform() { if (lastMeta) { observe(lastMeta); } }

  return {observe: observe, edit: edit, reset: reset, resolve: resolve, state: state, retransform: retransform,
    sourceToken: function () { return sourceToken; }};
};

'use strict';
// Persistent panel settings in localStorage, with migration from <=1.12 keys.

var KEY = 'align4-settings-v2';

function clean(path) { return String(path || '').replace(/[\\/]+$/, ''); }
function same(a, b) { return clean(a).toLowerCase() === clean(b).toLowerCase(); }
exports.samePath = same;

function defaults() {
  // Whole-canvas export keeps its own directory and SuperPNG switch (off by default).
  return {directories: [], prefix: '', superPNG: false, minWidth: '', minHeight: '', anchor: 'center',
    sizeLocked: false, translate: false, canvasDirectory: '', canvasSuperPNG: false, canvasLastExport: null};
}

function basename(p) { var parts = clean(p).split(/[\\/]/); return parts[parts.length - 1] || p; }
exports.basename = basename;

exports.addDirectory = function (list, path, name) {
  if (!path || list.some(function (d) { return same(d.path, path); })) { return false; }
  list.push({id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), path: path, name: name || basename(path), lastExport: null});
  return true;
};

exports.load = function (storage) {
  var s = defaults(), raw = null;
  function get(k) { try { return storage.getItem(k); } catch (e) { return null; } }
  try { raw = JSON.parse(get(KEY) || 'null'); } catch (e) { raw = null; }
  if (raw && typeof raw === 'object') {
    Object.keys(s).forEach(function (k) { if (raw[k] !== undefined) { s[k] = raw[k]; } });
    s.directories = (Array.isArray(raw.directories) ? raw.directories : []).filter(function (d) { return d && typeof d.path === 'string' && d.path; })
      .map(function (d) { return {id: String(d.id || ('d' + Math.random().toString(36).slice(2, 8))), path: d.path, name: typeof d.name === 'string' && d.name ? d.name : basename(d.path), lastExport: d.lastExport || null}; });
  } else {
    // Migrate 1.x: quick-export presets + main slice directory become one list;
    // the canvas directory stays separate.
    var old = []; try { old = JSON.parse(get('align4-directory-presets') || '[]'); } catch (e) {}
    if (Array.isArray(old)) { old.forEach(function (p) { if (p && typeof p.path === 'string') { exports.addDirectory(s.directories, p.path, p.name); } }); }
    var main = get('align4-export-directory'); if (main) { exports.addDirectory(s.directories, main); }
    s.canvasDirectory = get('align4-canvas-directory') || '';
    s.prefix = (get('align4-filename-prefix') || '').slice(0, 32);
    s.superPNG = get('align4-superpng') === '1';
  }
  s.anchor = 'center'; // padding is always centred
  s.sizeLocked = !!s.sizeLocked; s.translate = !!s.translate; s.superPNG = !!s.superPNG; s.canvasSuperPNG = !!s.canvasSuperPNG; s.canvasDirectory = typeof s.canvasDirectory === 'string' ? s.canvasDirectory : ''; s.prefix = String(s.prefix || '').slice(0, 32);
  return s;
};

exports.save = function (storage, s) {
  try { storage.setItem(KEY, JSON.stringify(s)); return true; } catch (e) { return false; }
};

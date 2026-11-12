'use strict';
// Offline slice-name translation: Chinese names -> English words joined with "_".
// Lookup order for every word: the user's glossary > built-in UI glossary > CC-CEDICT.
// Words found nowhere stay in Chinese (no pinyin), so they are easy to spot and fix.

var CJK = /[㐀-鿿]/;
var MAX_WORD = 8;

// ---------- CSV ----------
exports.parseCSV = function (text) {
  var rows = [], row = [], field = '', i = 0, quoted = false, c;
  text = String(text || '').replace(/^﻿/, '');
  for (; i < text.length; i++) {
    c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; } }
      else { field += c; }
    } else if (c === '"') { quoted = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') { i++; }
      row.push(field); rows.push(row); row = []; field = '';
    } else { field += c; }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
};

function cell(v) { v = String(v == null ? '' : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
exports.csvLine = function (values) { return values.map(cell).join(','); };

// Normalises an English entry: "Chat Room" -> "chat_room"; "-" or "" -> "" (drop the word).
function cleanEnglish(value) {
  var v = String(value || '').trim();
  if (v === '-') { return ''; }
  if (CJK.test(v)) { return v.replace(/\s+/g, '_'); }
  return v.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); // case kept: English is used as written
}

// Glossary CSV -> {中文: english}. First row wins; "#" rows and the header are ignored.
exports.loadGlossary = function (text) {
  var map = {};
  exports.parseCSV(text).forEach(function (row) {
    var zh = String(row[0] || '').trim();
    if (!zh || zh.charAt(0) === '#' || zh === '中文' || row.length < 2) { return; }
    var en = String(row[1] == null ? '' : row[1]).trim();
    if (!en && en !== '') { return; }
    if (!Object.prototype.hasOwnProperty.call(map, zh)) {
      var cleaned = cleanEnglish(en);
      if (cleaned || en === '-') { map[zh] = cleaned; }
    }
  });
  return map;
};

// ---------- Translation ----------
function has(map, key) { return !!map && Object.prototype.hasOwnProperty.call(map, key); }

// o: {user() -> map, builtin: map, dict: map}
exports.create = function (o) {
  function user() { return (o.user && o.user()) || {}; }

  function longest(map, run, i) {
    for (var len = Math.min(MAX_WORD, run.length - i); len > 0; len--) {
      if (has(map, run.substr(i, len))) { return len; }
    }
    return 0;
  }

  // Split a run of Chinese characters into words, preferring glossary words.
  function segment(run, parts) {
    var u = user(), i = 0, pending = '';
    function flush() { if (pending) { parts.push({src: pending, out: pending, source: 'none'}); pending = ''; } }
    while (i < run.length) {
      var lu = longest(u, run, i), lb = longest(o.builtin, run, i), ld = longest(o.dict, run, i);
      var lg = Math.max(lu, lb), len, word;
      // A glossary word of 2+ characters always wins; the dictionary only wins with a longer word.
      if (lg >= 2 || (lg && lg >= ld)) { len = lg; }
      else if (ld) { len = ld; }
      else { pending += run.charAt(i); i++; continue; }
      flush();
      word = run.substr(i, len);
      if (lu === len && has(u, word)) { parts.push({src: word, out: u[word], source: 'user'}); }
      else if (lb === len && has(o.builtin, word)) { parts.push({src: word, out: o.builtin[word], source: 'builtin'}); }
      else { parts.push({src: word, out: o.dict[word], source: 'dict'}); }
      i += len;
    }
    flush();
  }

  function translate(name) {
    name = String(name || '').trim();
    var u = user(), parts = [];
    // A whole-name entry (learned from a correction) is used as-is.
    if (name && has(u, name)) { return result([{src: name, out: u[name], source: 'user'}], name); }
    var tokens = name.match(/[㐀-鿿]+|[A-Za-z0-9]+/g) || [];
    tokens.forEach(function (t) {
      if (CJK.test(t)) { segment(t, parts); }
      else { parts.push({src: t, out: t, source: 'ascii'}); }
    });
    return result(parts, name);
  }

  function result(parts, name) {
    var kept = [], last = null;
    parts.forEach(function (p) {
      if (!p.out) { p.dropped = true; return; }            // e.g. 图 / 的
      if (p.out === last) { p.dropped = true; return; }     // 按钮/按钮_按下 -> btn_pressed
      kept.push(p); last = p.out;
    });
    if (!kept.length) { return {text: name, parts: [{src: name, out: name, source: 'none'}], complete: !CJK.test(name)}; }
    return {text: kept.map(function (p) { return p.out; }).join('_'), parts: kept,
      complete: kept.every(function (p) { return p.source !== 'none'; })};
  }

  // What to remember when the user corrects an automatic name before exporting.
  // Same number of words: learn each changed word. Otherwise: learn the whole name.
  function learn(sourceName, finalName) {
    var auto = translate(sourceName), pairs = [];
    finalName = String(finalName || '').trim();
    if (!finalName || finalName === auto.text) { return pairs; }
    var finalWords = finalName.split('_'), counts = auto.parts.map(function (p) { return p.out.split('_').length; });
    var total = counts.reduce(function (a, b) { return a + b; }, 0);
    if (total === finalWords.length) {
      var at = 0;
      auto.parts.forEach(function (p, k) {
        var now = finalWords.slice(at, at + counts[k]).join('_'); at += counts[k];
        if (now !== p.out && CJK.test(p.src) && now && !CJK.test(now)) { pairs.push([p.src, now]); }
      });
      if (pairs.length) { return pairs; }
    }
    var key = String(sourceName || '').trim();
    if (key && CJK.test(key) && !CJK.test(finalName)) { pairs.push([key, finalName]); }
    return pairs;
  }

  return {translate: translate, learn: learn};
};

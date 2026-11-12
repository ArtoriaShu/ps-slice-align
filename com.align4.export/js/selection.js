'use strict';
// Keeps the panel in step with Photoshop's current selection (or document, in
// canvas mode) using only cheap metadata queries; it never renders pixels.
// Notifications trigger a debounced check; a slow poll recovers lost ones.

// o: {host, setTimeout, clearTimeout, hidden() -> bool, mode() -> 'selection'|'canvas',
//     onChange(meta), onError(message), debounce, interval, errorInterval}
exports.create = function (o) {
  var debounce = o.debounce || 220, interval = o.interval || 1200, errorInterval = o.errorInterval || 5000;
  var timer = null, pollTimer = null, running = false, again = false, paused = 0, stopped = false;
  var last = null, lastError = null, delay = interval;

  function key(meta) { return [meta.token, meta.name, meta.kind, meta.revision, meta.width, meta.height].join('\u0001'); }

  function check() {
    if (stopped || paused || running) { if (running) { again = true; } return; }
    running = true; again = false;
    var mode = o.mode();
    o.host(mode === 'canvas' ? 'Align4.describeDocument()' : 'Align4.describeSelection()', function (meta) {
      running = false;
      if (stopped) { return; }
      if (o.mode() !== mode) { again = true; }
      else if (!meta || !meta.ok) {
        delay = errorInterval; last = null;
        var message = (meta && meta.message) || '无法读取 Photoshop 状态。';
        if (message !== lastError) { lastError = message; o.onError(message); }
      } else {
        delay = interval; lastError = null; meta.mode = mode;
        var k = key(meta);
        if (!last || k !== last) { last = k; o.onChange(meta); }
      }
      if (again) { poke(); }
    });
  }

  function poke() {
    if (stopped) { return; }
    if (paused) { again = true; return; }
    if (timer !== null) { return; } // coalesce bursts without pushing the deadline back
    timer = o.setTimeout(function () { timer = null; check(); }, debounce);
  }

  function schedulePoll() {
    if (stopped || pollTimer !== null) { return; }
    pollTimer = o.setTimeout(function () {
      pollTimer = null;
      if (!paused && !o.hidden() && timer === null) { check(); }
      schedulePoll();
    }, delay);
  }

  return {
    start: function () { stopped = false; poke(); schedulePoll(); },
    poke: poke,
    // Force a fresh report even if nothing changed (e.g. after switching mode).
    refresh: function () { last = null; lastError = null; poke(); },
    pause: function () { paused++; },
    resume: function () { if (paused > 0) { paused--; } if (!paused && again) { again = false; poke(); } },
    stop: function () {
      stopped = true;
      if (timer !== null) { o.clearTimeout(timer); timer = null; }
      if (pollTimer !== null) { o.clearTimeout(pollTimer); pollTimer = null; }
    },
    current: function () { return last; }
  };
};

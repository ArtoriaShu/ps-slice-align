(function (root) {
  'use strict';
  var rules = {
    ceil4: function (n) { return Math.ceil(n / 4) * 4; },
    valid: function (w, h, originalW, originalH) {
      return isFinite(w) && isFinite(h) && w % 1 === 0 && h % 1 === 0 &&
        w >= originalW && h >= originalH && w <= 30000 && h <= 30000 &&
        w > 0 && h > 0 && w % 4 === 0 && h % 4 === 0;
    },
    padding: function (w, h, originalW, originalH, anchor) {
      var x = w - originalW, y = h - originalH;
      var left = anchor === 'topLeft' ? 0 : Math.floor(x / 2);
      var top = anchor === 'topLeft' ? 0 : Math.floor(y / 2);
      return {left:left, top:top, right:x-left, bottom:y-top};
    }
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = rules; }
  // CEP can expose both window and CommonJS module in classic script tags.
  // Publish to the panel even when a Node module object is also present.
  if (root) { root.Align4Rules = rules; }
}(typeof window !== 'undefined' ? window : this));

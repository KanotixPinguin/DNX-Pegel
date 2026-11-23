// Beispiel fuer manuelles Einbinden in .../htdocs/plugins/receiver/init.js:
(function () {
  if (window.__dnxPegelLoader || window.__dnxWfPro) return;
  window.__dnxPegelLoader = true;
  if (!document.querySelector('link[href*="waterfall_pro.css"]')) {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'static/plugins/receiver/waterfall_pro/waterfall_pro.css?v=20261123';
    document.head.appendChild(l);
  }
  if (window.Plugins && typeof Plugins.load === 'function') {
    try { Plugins.load('waterfall_pro'); return; } catch (e) {}
  }
  var s = document.createElement('script');
  s.src = 'static/plugins/receiver/waterfall_pro/waterfall_pro.js?v=' + Date.now();
  s.async = false;
  (document.head || document.documentElement).appendChild(s);
})();

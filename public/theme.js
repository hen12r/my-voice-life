/* Applies the saved theme before the first paint (no flash). Mirrors src/lib/theme.ts.
   Loaded as a same-origin script because the CSP forbids inline scripts. */
(function () {
  var pref = 'system';
  try { var v = localStorage.getItem('mvl-theme'); if (v === 'light' || v === 'dark') pref = v; } catch (e) { /* storage unavailable */ }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();

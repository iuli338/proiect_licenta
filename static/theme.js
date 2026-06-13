/* ============================================================
   Dropwise — comutator temă light / dark
   ============================================================
   Partajat între pagina home şi dashboard. Încărcat SINCRON în
   <head> (înainte de <body>) ca tema să fie aplicată pe <html>
   ÎNAINTE de prima pictare — fără flash de temă greşită (FOUC).

   Sursa preferinţei:
     1. localStorage('dropwise-theme') = 'light' | 'dark'  (alegerea explicită)
     2. dacă lipseşte → preferinţa sistemului (prefers-color-scheme)
   ============================================================ */

(function () {
  'use strict';

  var STORAGE_KEY = 'dropwise-theme';

  /** Tema preferată de sistem ('light' sau 'dark'). */
  function systemTheme() {
    return (window.matchMedia &&
            window.matchMedia('(prefers-color-scheme: light)').matches)
      ? 'light' : 'dark';
  }

  /** Tema curentă: alegerea salvată sau, în lipsă, cea de sistem. */
  function resolveTheme() {
    var saved;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { saved = null; }
    return (saved === 'light' || saved === 'dark') ? saved : systemTheme();
  }

  /** Aplică tema pe <html data-theme> şi marchează dacă e explicită. */
  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'light') {
      root.setAttribute('data-theme', 'light');
    } else {
      // 'dark' e implicit — eliminăm atributul ca :root (dark) să fie activ.
      root.removeAttribute('data-theme');
    }
  }

  // --- Aplicare imediată (pre-paint), înainte de a exista <body>. ---
  applyTheme(resolveTheme());

  /** Notifică restul aplicaţiei că tema s-a schimbat (ex: graficele Chart.js
      pe canvas, care nu moştenesc CSS-ul şi trebuie reconstruite). */
  function emitThemeChange(theme) {
    window.dispatchEvent(new CustomEvent('dropwise:theme-changed',
      { detail: { theme: theme } }));
  }

  /** Comută între light şi dark, salvează alegerea, actualizează butoanele. */
  function toggleTheme() {
    var current = (document.documentElement.getAttribute('data-theme') === 'light')
      ? 'light' : 'dark';
    var next = current === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    applyTheme(next);
    syncButtons();
    emitThemeChange(next);
  }

  /** Actualizează starea (aria-pressed + label) a tuturor butoanelor de temă. */
  function syncButtons() {
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.setAttribute('aria-pressed', isLight ? 'true' : 'false');
      // Eticheta descrie ACŢIUNEA (ce se întâmplă la click).
      var label = isLight ? 'Comută pe tema întunecată' : 'Comută pe tema luminoasă';
      b.setAttribute('aria-label', label);
      b.setAttribute('title', label);
    }
  }

  /** Leagă butoanele [data-theme-toggle] după ce DOM-ul e gata. */
  function initButtons() {
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', toggleTheme);
    }
    syncButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initButtons);
  } else {
    initButtons();
  }

  // Dacă utilizatorul NU a ales explicit, urmărim schimbarea de sistem live.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener(
      'change', function () {
        var saved;
        try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { saved = null; }
        if (saved !== 'light' && saved !== 'dark') {
          var sys = systemTheme();
          applyTheme(sys);
          syncButtons();
          emitThemeChange(sys);
        }
      });
  }

  // Expunem pentru eventuale apeluri externe.
  window.DropwiseTheme = { toggle: toggleTheme, apply: applyTheme, resolve: resolveTheme };
})();

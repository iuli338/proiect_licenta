/* ============================================================
   Dropwise — autentificare prin cod de acces
   ============================================================

   La încărcarea dashboard-ului verificăm dacă cererea are deja un cod
   valid (cookie). Dacă nu, deschidem dialogul de cod — nimic nu
   funcţionează până nu introduci codul de pe cutia hub-ului.

   Codul corect e salvat de server într-un cookie HttpOnly; browserul îl
   trimite automat la fiecare cerere ulterioară. Endpoint-urile private
   răspund 404 fără el.
   ============================================================ */

(function () {
  'use strict';

  let el = {};
  // Callback rulat după ce codul e acceptat (în loc de reload).
  let onSuccess = null;
  // True după ce avem un cod de acces valid (status confirmat sau cod
  // introdus cu succes). Folosit ca poartă pentru polling-ul hub-ului.
  let authenticated = false;

  // ---------- Helpers ----------

  function showError(msg) {
    el.error.textContent = msg || 'A apărut o eroare.';
    el.error.hidden = false;
  }
  function clearError() {
    el.error.hidden = true;
  }

  /**
   * Deschide dialogul de cod.
   * @param cb  callback opţional rulat după cod corect (în loc de reload).
   */
  function openDialog(cb) {
    onSuccess = (typeof cb === 'function') ? cb : null;
    if (!el.dialog.open) {
      clearError();
      el.code.value = '';
      el.dialog.showModal();
      el.code.focus();
    }
  }

  // ---------- Verificare cod ----------

  async function submitCode(ev) {
    ev.preventDefault();
    clearError();

    const code = el.code.value.trim();
    if (!code) {
      showError('Introdu codul de acces.');
      return;
    }

    el.submit.disabled = true;
    el.submit.querySelector('.btn__label').textContent = 'Se verifică…';

    try {
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        // Cod corect — cookie-ul a fost setat de server.
        authenticated = true;
        if (window.Dropwise && window.Dropwise.refreshTabLock) {
          window.Dropwise.refreshTabLock();
        }
        el.dialog.close();
        if (onSuccess) {
          // Continuăm fluxul care a cerut codul (ex: butonul Conectare).
          const cb = onSuccess;
          onSuccess = null;
          cb();
        } else {
          // Cerut la încărcarea paginii — reîncărcăm ca tot dashboard-ul
          // să pornească autentificat.
          location.reload();
        }
      } else {
        showError(j.error || 'Cod greşit.');
      }
    } catch (e) {
      showError('Eroare de reţea: ' + e.message);
    } finally {
      el.submit.disabled = false;
      el.submit.querySelector('.btn__label').textContent = 'Conectează-te';
    }
  }

  // ---------- Stare la încărcare ----------

  async function checkStatus() {
    try {
      const r = await fetch('/api/auth/status', { cache: 'no-store' });
      const j = await r.json();
      authenticated = !!j.authorized;
    } catch (e) {
      authenticated = false;
    }

    // Starea de autentificare s-a stabilit — re-evaluăm blocarea taburilor.
    if (window.Dropwise && window.Dropwise.refreshTabLock) {
      window.Dropwise.refreshTabLock();
    }

    // Dialogul de cod apare la încărcare DOAR pentru un utilizator care
    // revine pe un hub deja provizionat şi nu e încă autentificat — el a
    // trecut deja de Initial Setup şi are nevoie de cod pentru Monitor/
    // Control. Pe un hub neprovizionat (pasul Setup) nu cerem codul:
    // provisioning-ul BLE nu are nevoie de el.
    if (!authenticated) {
      const tabs = document.querySelector('.tabs');
      const provisioned = tabs && tabs.dataset.provisioned === 'true';
      if (provisioned) openDialog();
    }
  }

  // ---------- Init ----------

  function init() {
    const dialog = document.getElementById('auth-dialog');
    if (!dialog) return;

    el = {
      dialog: dialog,
      form: document.getElementById('auth-form'),
      code: document.getElementById('auth-code'),
      submit: document.getElementById('auth-submit'),
      error: document.getElementById('auth-error'),
    };

    el.form.addEventListener('submit', submitCode);

    // Dialogul de cod nu poate fi închis cu Esc — codul e obligatoriu.
    el.dialog.addEventListener('cancel', (ev) => ev.preventDefault());

    // Expunem deschiderea dialogului pentru alte module (ex: butonul
    // "Conectare" din Initial Setup).
    window.Dropwise = window.Dropwise || {};
    window.Dropwise.openAuthDialog = openDialog;
    window.Dropwise.isAuthenticated = function () { return authenticated; };

    // Poartă pentru polling-ul hub-ului: are sens să interogăm /api/hub/status
    // doar dacă suntem autentificaţi (cod valid) ŞI hub-ul e provizionat
    // (avem IP). Altfel primim doar 404, inutil.
    window.Dropwise.canUseHub = function () {
      if (!authenticated) return false;
      const tabs = document.querySelector('.tabs');
      return !!(tabs && tabs.dataset.provisioned === 'true');
    };

    checkStatus();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

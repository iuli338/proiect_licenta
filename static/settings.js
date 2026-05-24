/* ============================================================
   Dropwise — Setări
   ============================================================
   Setarea orei RTC pe hub.
   ============================================================ */

(function () {
  'use strict';

  // ---------- Helpers locali ----------

  async function fetchJSON(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  /** Mic toast inline (refolosit cu pattern-ul din nodes-grid). */
  function showSettingsToast(msg, kind) {
    let t = document.getElementById('settings-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'settings-toast';
      t.className = 'reset-toast';   // reutilizăm stilul din nodes.css
      document.body.appendChild(t);
    }
    t.dataset.kind = kind || 'ok';
    const icon = (kind === 'error')
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true"><path d="M6 6 l12 12 M18 6 L 6 18"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true"><path d="M5 12 l5 5 L 20 7"/></svg>';
    t.innerHTML =
      '<span class="reset-toast__icon">' + icon + '</span>' +
      '<span class="reset-toast__text"></span>';
    t.querySelector('.reset-toast__text').textContent = msg;
    t.classList.add('reset-toast--show');
    clearTimeout(showSettingsToast._timer);
    showSettingsToast._timer = setTimeout(() => {
      t.classList.remove('reset-toast--show');
    }, 4000);
  }

  // ---------- Sincronizare display cu polling /api/hub/status ----------

  function syncDisplay() {
    if (!window.Dropwise || !window.Dropwise.lastHubData) return;
    const disp = document.getElementById('settings-time-display');
    if (!disp) return;
    // Doar dacă utilizatorul NU e în mijlocul editării.
    if (!editMode) {
      const t = window.Dropwise.lastHubData.time;
      disp.textContent = t || '—';
    }
  }

  // ---------- Stare editare ----------

  let editMode = false;

  function enterEdit() {
    editMode = true;
    const disp   = document.getElementById('settings-time-display');
    const input  = document.getElementById('settings-time-input');
    const btnEd  = document.getElementById('settings-time-edit');
    const btnCnl = document.getElementById('settings-time-cancel');
    const btnSv  = document.getElementById('settings-time-save');
    const hint   = document.getElementById('settings-time-hint');

    input.value = (disp.textContent && disp.textContent !== '—')
      ? disp.textContent : '';
    disp.hidden  = true;
    input.hidden = false;
    btnEd.hidden = true;
    btnCnl.hidden = false;
    btnSv.hidden = false;
    hint.hidden  = false;
    input.focus();
    input.select();
  }

  function exitEdit() {
    editMode = false;
    const disp   = document.getElementById('settings-time-display');
    const input  = document.getElementById('settings-time-input');
    const btnEd  = document.getElementById('settings-time-edit');
    const btnCnl = document.getElementById('settings-time-cancel');
    const btnSv  = document.getElementById('settings-time-save');
    const hint   = document.getElementById('settings-time-hint');

    disp.hidden  = false;
    input.hidden = true;
    btnEd.hidden = false;
    btnCnl.hidden = true;
    btnSv.hidden = true;
    hint.hidden  = true;
    // Resetăm spinner-ul dacă rămăsese din vreo trimitere anterioară.
    resetSaveButton();
  }

  function setSaveLoading(on) {
    const btn = document.getElementById('settings-time-save');
    if (!btn) return;
    btn.disabled = !!on;
    if (on) {
      btn.classList.add('btn--loading');
      btn.innerHTML =
        '<span class="btn-spinner" aria-hidden="true"></span>' +
        '<span>Se trimite…</span>';
    } else {
      btn.classList.remove('btn--loading');
      btn.innerHTML = '<span class="btn__label">Setează</span>';
    }
  }

  function resetSaveButton() {
    setSaveLoading(false);
  }

  /** Validează HH:MM strict (4 cifre + ":"), interval 00-23 / 00-59. */
  function isValidHM(v) {
    if (!v || v.length !== 5 || v[2] !== ':') return false;
    if (!/^\d{2}:\d{2}$/.test(v)) return false;
    const hh = parseInt(v.slice(0, 2), 10);
    const mm = parseInt(v.slice(3), 10);
    return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
  }

  async function submitTime() {
    const input = document.getElementById('settings-time-input');
    const v = (input.value || '').trim();
    if (!isValidHM(v)) {
      showSettingsToast('Format invalid. Folosește HH:MM (24h).', 'error');
      input.focus();
      return;
    }
    setSaveLoading(true);
    try {
      await fetchJSON('/api/hub/time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time: v }),
      });
      // Actualizăm afişajul imediat (next polling /status oricum o va
      // confirma) şi ieşim din modul edit.
      const disp = document.getElementById('settings-time-display');
      if (disp) disp.textContent = v;
      exitEdit();
      showSettingsToast('Ora hub-ului a fost schimbată cu succes.', 'ok');
    } catch (e) {
      setSaveLoading(false);
      showSettingsToast('Eroare: ' + e.message, 'error');
    }
  }

  // ---------- Auto-format input (XX:XX) ----------

  function formatInput(ev) {
    const inp = ev.target;
    let raw = inp.value.replace(/\D/g, '').slice(0, 4);
    if (raw.length >= 3) raw = raw.slice(0, 2) + ':' + raw.slice(2);
    inp.value = raw;
  }

  // ---------- Init ----------

  function init() {
    const btnEd = document.getElementById('settings-time-edit');
    if (!btnEd) return;   // panel-ul nu există

    btnEd.addEventListener('click', enterEdit);
    document.getElementById('settings-time-cancel')
      .addEventListener('click', exitEdit);
    document.getElementById('settings-time-save')
      .addEventListener('click', submitTime);
    const input = document.getElementById('settings-time-input');
    input.addEventListener('input', formatInput);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submitTime();
      else if (ev.key === 'Escape') exitEdit();
    });

    // Sincronizăm display-ul când datele de hub se actualizează.
    window.addEventListener('dropwise:hub-status-updated', syncDisplay);
    // Iniţial — în caz că datele au venit deja.
    syncDisplay();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

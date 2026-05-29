/* ============================================================
   Dropwise — Setări
   ============================================================
   Setarea orei RTC pe hub + setarea debitului pompei (persistent
   în EEPROM-ul hub-ului). Ambele panouri folosesc acelaşi tipar de
   editare (display → input → Setează/Anulează/Salvează cu spinner).
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

  /** Mic toast inline. kind: 'ok' | 'error' | 'warn'. */
  function showSettingsToast(msg, kind) {
    let t = document.getElementById('settings-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'settings-toast';
      t.className = 'reset-toast';   // reutilizăm stilul din nodes.css
      document.body.appendChild(t);
    }
    t.dataset.kind = kind || 'ok';
    let icon;
    if (kind === 'error') {
      icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true"><path d="M6 6 l12 12 M18 6 L 6 18"/></svg>';
    } else if (kind === 'warn') {
      icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true"><path d="M12 3 L22 20 H2 Z M12 10 v4 M12 17 h.01"/></svg>';
    } else {
      icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true"><path d="M5 12 l5 5 L 20 7"/></svg>';
    }
    t.innerHTML =
      '<span class="reset-toast__icon">' + icon + '</span>' +
      '<span class="reset-toast__text"></span>';
    t.querySelector('.reset-toast__text').textContent = msg;
    t.classList.add('reset-toast--show');
    clearTimeout(showSettingsToast._timer);
    // Warning-ul stă mai mult (mesaj mai important de citit).
    const dur = (kind === 'warn') ? 7000 : 4000;
    showSettingsToast._timer = setTimeout(() => {
      t.classList.remove('reset-toast--show');
    }, dur);
  }

  // ============================================================
  //  Editor panel — abstractizează tiparul display/input/butoane
  // ============================================================
  //
  // opts:
  //   prefix    — prefixul id-urilor ("settings-time" / "settings-flow")
  //   getValue  — () => string  valoarea curentă din window.Dropwise (display)
  //   validate  — (v) => bool
  //   invalidMsg— mesaj la validare eşuată
  //   format    — (ev) => void  auto-format pe input (opţional)
  //   submit    — async (v) => void  trimite valoarea (aruncă la eroare)
  function makeEditorPanel(opts) {
    const els = {
      disp:  document.getElementById(opts.prefix + '-display'),
      input: document.getElementById(opts.prefix + '-input'),
      edit:  document.getElementById(opts.prefix + '-edit'),
      cancel:document.getElementById(opts.prefix + '-cancel'),
      save:  document.getElementById(opts.prefix + '-save'),
      hint:  document.getElementById(opts.prefix + '-hint'),
    };
    if (!els.edit) return null;   // panel-ul nu există în DOM

    let editMode = false;

    function setSaveLoading(on) {
      const btn = els.save;
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

    function enterEdit() {
      editMode = true;
      els.input.value = (els.disp.textContent && els.disp.textContent !== '—')
        ? els.disp.textContent : '';
      els.disp.hidden  = true;
      els.input.hidden = false;
      els.edit.hidden  = true;
      els.cancel.hidden = false;
      els.save.hidden  = false;
      if (els.hint) els.hint.hidden = false;
      // Unitatea (ex: "ml/s") se ascunde cât timp edităm.
      if (opts.unitEl) opts.unitEl.hidden = true;
      els.input.focus();
      els.input.select();
    }

    function exitEdit() {
      editMode = false;
      els.disp.hidden  = false;
      els.input.hidden = true;
      els.edit.hidden  = false;
      els.cancel.hidden = true;
      els.save.hidden  = true;
      if (els.hint) els.hint.hidden = true;
      if (opts.unitEl) opts.unitEl.hidden = (els.disp.textContent === '—');
      setSaveLoading(false);
    }

    async function submit() {
      const v = (els.input.value || '').trim();
      if (!opts.validate(v)) {
        showSettingsToast(opts.invalidMsg, 'error');
        els.input.focus();
        return;
      }
      setSaveLoading(true);
      try {
        await opts.submit(v);
        exitEdit();
      } catch (e) {
        setSaveLoading(false);
        showSettingsToast('Eroare: ' + e.message, 'error');
      }
    }

    function syncDisplay() {
      if (editMode) return;   // nu deranjăm utilizatorul în mijlocul editării
      const val = opts.getValue();
      els.disp.textContent = (val == null || val === '') ? '—' : val;
      if (opts.unitEl) opts.unitEl.hidden = (els.disp.textContent === '—');
    }

    els.edit.addEventListener('click', enterEdit);
    els.cancel.addEventListener('click', exitEdit);
    els.save.addEventListener('click', submit);
    if (opts.format) els.input.addEventListener('input', opts.format);
    els.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit();
      else if (ev.key === 'Escape') exitEdit();
    });

    return { syncDisplay, setDisplay: (v) => { els.disp.textContent = v; } };
  }

  // ---------- Validatoare + format ----------

  /** HH:MM strict (4 cifre + ":"), interval 00-23 / 00-59. */
  function isValidHM(v) {
    if (!v || v.length !== 5 || v[2] !== ':') return false;
    if (!/^\d{2}:\d{2}$/.test(v)) return false;
    const hh = parseInt(v.slice(0, 2), 10);
    const mm = parseInt(v.slice(3), 10);
    return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
  }

  function formatTimeInput(ev) {
    const inp = ev.target;
    let raw = inp.value.replace(/\D/g, '').slice(0, 4);
    if (raw.length >= 3) raw = raw.slice(0, 2) + ':' + raw.slice(2);
    inp.value = raw;
  }

  /** Debit: număr zecimal în intervalul 0.5–50 ml/s. */
  function isValidFlow(v) {
    if (!/^\d{1,2}([.,]\d{1,2})?$/.test(v)) return false;
    const n = parseFloat(v.replace(',', '.'));
    return !isNaN(n) && n >= 0.5 && n <= 50;
  }

  function formatFlowInput(ev) {
    const inp = ev.target;
    // Permitem doar cifre + un singur separator zecimal (. sau ,).
    let raw = inp.value.replace(/[^\d.,]/g, '').replace(',', '.');
    const parts = raw.split('.');
    if (parts.length > 2) raw = parts[0] + '.' + parts.slice(1).join('');
    // max 2 zecimale
    const m = raw.match(/^(\d{0,2})(\.\d{0,2})?/);
    inp.value = m ? m[0] : raw;
  }

  // ---------- Init ----------

  let timePanel = null;
  let flowPanel = null;

  function syncAll() {
    if (timePanel) timePanel.syncDisplay();
    if (flowPanel) flowPanel.syncDisplay();
  }

  function init() {
    // --- Panel oră ---
    timePanel = makeEditorPanel({
      prefix: 'settings-time',
      getValue: () => {
        const d = window.Dropwise && window.Dropwise.lastHubData;
        return d ? d.time : null;
      },
      validate: isValidHM,
      invalidMsg: 'Format invalid. Folosește HH:MM (24h).',
      format: formatTimeInput,
      submit: async (v) => {
        await fetchJSON('/api/hub/time', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ time: v }),
        });
        if (timePanel) timePanel.setDisplay(v);
        showSettingsToast('Ora hub-ului a fost schimbată cu succes.', 'ok');
      },
    });

    // --- Panel debit ---
    const flowUnit = document.getElementById('settings-flow-unit');
    flowPanel = makeEditorPanel({
      prefix: 'settings-flow',
      unitEl: flowUnit,
      getValue: () => {
        const d = window.Dropwise && window.Dropwise.lastHubData;
        if (!d || d.flow_ml_per_sec == null) return null;
        return Number(d.flow_ml_per_sec).toFixed(2);
      },
      validate: isValidFlow,
      invalidMsg: 'Debit invalid. Introdu o valoare între 0.5 și 50 (ml/s).',
      format: formatFlowInput,
      submit: async (v) => {
        const flow = parseFloat(v.replace(',', '.'));
        const res = await fetchJSON('/api/hub/flow-rate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flow_ml_per_sec: flow }),
        });
        const shown = Number(res.flow_ml_per_sec != null ? res.flow_ml_per_sec : flow)
          .toFixed(2);
        if (flowPanel) flowPanel.setDisplay(shown);
        if (flowUnit) flowUnit.hidden = false;
        // EEPROM lipsă pe hub → debitul s-a aplicat doar în RAM.
        if (res.persisted === false) {
          showSettingsToast(
            'Debit aplicat (' + shown + ' ml/s), dar NU a putut fi salvat ' +
            '(EEPROM indisponibil). Se resetează la următoarea repornire a hub-ului.',
            'warn');
        } else {
          showSettingsToast('Debitul pompei a fost setat la ' + shown + ' ml/s.', 'ok');
        }
      },
    });

    if (!timePanel && !flowPanel) return;   // niciun panel în DOM

    window.addEventListener('dropwise:hub-status-updated', syncAll);
    syncAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

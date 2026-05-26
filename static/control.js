/* ============================================================
   Dropwise — Control manual
   ============================================================

   Două secţiuni:
     A. Toggle GPIO direct  — pompă + 3 valve  (POST /api/hub/toggle/<pin>)
     B. Udare per port      — ciclu automat    (POST /api/hub/water/<act>/<port>)

   Starea reală vine de la hub prin /api/hub/status; UI-ul doar reflectă.
   Toată comunicarea trece prin proxy-ul Flask, nu direct la hub.

   Inspirat din control_v6.html, adaptat la designul Dropwise.
   ============================================================ */

(function () {
  'use strict';

  // Pini GPIO: 16 = pompă, 17/18/19 = valve port 1/2/3.
  const PINS = [16, 17, 18, 19];
  const PORTS = [1, 2, 3];

  // Intervalul de polling al stării hub-ului cât timp tab-ul e activ.
  const POLL_MS = 800;

  let pollTimer = null;
  // Comenzi în curs — cât timp o comandă e "pending", polling-ul nu
  // suprascrie starea vizuală a acelui buton.
  const pinPending = { 16: false, 17: false, 18: false, 19: false };
  const waterPending = { 1: false, 2: false, 3: false };

  // Disclaimer-ul de risc se afişează o singură dată per sesiune browser
  // — persistat în sessionStorage ca să supravieţuiască la refresh, dar
  // să apară din nou la închidere/redeschidere de tab.
  const DISCLAIMER_KEY = 'dropwise.control.disclaimerAccepted';
  let disclaimerAccepted = (function () {
    try { return sessionStorage.getItem(DISCLAIMER_KEY) === 'true'; }
    catch (_) { return false; }
  })();

  let el = {};

  // ---------- Helpers ----------

  /**
   * Activează / dezactivează zona de comenzi.
   * @param disabled  true => butoanele sunt blocate
   * @param showBanner true => afişează şi bannerul "hub offline".
   *        La intrarea pe tab blocăm comenzile dar NU arătăm bannerul,
   *        ca să nu apară un flash înainte de primul răspuns de polling.
   *
   * Orice apel ascunde bannerul de loading — el e vizibil doar până la
   * primul răspuns de polling.
   */
  function setControlsDisabled(disabled, showBanner) {
    el.flow.dataset.disabled = disabled ? 'true' : 'false';
    el.offline.hidden = !(disabled && showBanner);
    el.loading.hidden = true;
  }

  /** Aplică o stare vizuală ('on' | 'off' | 'pending') unui buton. */
  function setBtnState(btn, state, labelText) {
    btn.dataset.state = state;
    const stateEl = btn.querySelector('.gpio-btn__state, .water-btn__state');
    if (stateEl && labelText !== undefined) stateEl.textContent = labelText;
  }

  // ---------- Secţiunea A: Toggle GPIO ----------

  async function togglePin(pin) {
    const btn = document.getElementById('gpio-' + pin);
    if (btn.disabled) return;

    pinPending[pin] = true;
    btn.disabled = true;
    setBtnState(btn, 'pending', 'trimis…');

    try {
      const r = await fetch('/api/hub/toggle/' + pin, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      // Hub-ul răspunde cu starea reală a pinului.
      setBtnState(btn, j.state ? 'on' : 'off', j.state ? 'pornit' : 'oprit');
    } catch (e) {
      // La eroare lăsăm polling-ul să resincronizeze starea.
      el.waterStatus.textContent = 'Comandă eşuată: ' + e.message;
    } finally {
      pinPending[pin] = false;
      btn.disabled = false;
    }
  }

  // ---------- Secţiunea B: Udare per port ----------

  async function toggleWater(port) {
    const btn = document.getElementById('water-' + port);
    if (btn.disabled) return;

    // Dacă portul se udă deja => oprim; altfel => pornim.
    const isOn = btn.dataset.state === 'on';
    const action = isOn ? 'stop' : 'start';

    waterPending[port] = true;
    setBtnState(btn, 'pending', 'trimis…');

    try {
      const r = await fetch('/api/hub/water/' + action + '/' + port, {
        method: 'POST',
      });
      const j = await r.json();
      if (!r.ok) {
        el.waterStatus.textContent =
          'Udare: ' + (j.error || 'comandă respinsă de hub');
      }
    } catch (e) {
      el.waterStatus.textContent = 'Udare eşuată: ' + e.message;
    } finally {
      waterPending[port] = false;
      // Starea finală o stabileşte polling-ul.
    }
  }

  // ---------- Secţiunea A2: Udare cantitate fixă ----------
  //
  // Pornim o udare cu volum exact pe un port. Hub-ul răspunde 200 imediat
  // cu durata estimată (ms); pompa se opreşte automat. Detectăm finalul
  // prin polling pe /status (wateringPort revine la -1).

  // Stare locală a UI-ului de dozare.
  let doseActive = false;        // dozare în curs (UI blocat)
  let doseExpectedTotalMs = 0;   // durata totală anunţată de hub
  let doseStartMs = 0;           // ms (Date.now) la pornire
  let doseAnimTimer = null;      // requestAnimationFrame loop pentru progress
  let doseLastPort = 0;          // ultimul port udat (pentru toast)
  let doseLastMl = 0;            // ultima cantitate (pentru toast)

  async function startDose() {
    if (doseActive) return;
    const port = parseInt(el.dosePort.value, 10);
    const ml = parseInt(el.doseMl.value, 10);
    if (!port || port < 1 || port > 3) return;
    if (!ml || ml < 1 || ml > 500) {
      el.waterStatus.textContent = 'Cantitate invalidă (1..500 ml).';
      return;
    }

    setDoseUiBusy(true, 'Trimite comanda…');
    try {
      const r = await fetch('/api/hub/dose/' + port, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ml: ml }),
      });
      const j = await r.json();
      if (!r.ok) {
        throw new Error(j.error || ('HTTP ' + r.status));
      }
      // Hub-ul a primit comanda — pornim progress-ul cu durata totală.
      doseExpectedTotalMs = j.total_ms || (j.dose_ms ? (j.dose_ms + 3000) : 5000);
      doseStartMs = Date.now();
      doseLastPort = port;
      doseLastMl = ml;
      startDoseProgressLoop(port, ml);
    } catch (e) {
      setDoseUiBusy(false);
      el.waterStatus.textContent = 'Udare eşuată: ' + e.message;
    }
  }

  /** Animaţia progress bar-ului — rulează 30 fps până la final. */
  function startDoseProgressLoop(port, ml) {
    function tick() {
      const elapsed = Date.now() - doseStartMs;
      const pct = Math.min(100, (elapsed / doseExpectedTotalMs) * 100);
      el.doseProgressFill.style.width = pct.toFixed(1) + '%';
      // Etichetă cu secunde rămase + faza estimată.
      const remaining = Math.max(0, doseExpectedTotalMs - elapsed) / 1000;
      let phase;
      if (elapsed < 2000) phase = 'Se deschide valva…';
      else if (elapsed < doseExpectedTotalMs - 1000) phase = 'Se pompează apa…';
      else phase = 'Se închide valva…';
      el.doseProgressLabel.textContent =
        phase + '   (Port ' + port + ' · ' + ml + ' ml · -' +
        remaining.toFixed(1) + 's)';

      // Continuă până când backend-ul ne spune că s-a terminat
      // (wateringPort revine la -1 — detectat în render()), sau ca
      // fallback până ajunge la 100 % + un mic delay de siguranţă.
      if (doseActive) {
        doseAnimTimer = requestAnimationFrame(tick);
      }
    }
    doseAnimTimer = requestAnimationFrame(tick);
  }

  /** Apelată din render() când hub-ul confirmă finalul dozării. */
  function onDoseComplete() {
    if (!doseActive) return;
    setDoseUiBusy(false);
    el.waterStatus.textContent = 'Udare cu cantitate fixă finalizată.';
    showDoseToast(
      'Udare finalizată: Port ' + doseLastPort + ' · ' +
      doseLastMl + ' ml.',
      'ok'
    );
  }

  /**
   * Toast la baza ecranului — refoloseşte stilurile `.reset-toast` din
   * nodes.css (clasă generică în ciuda numelui — apare şi pe resetare nod).
   */
  function showDoseToast(msg, kind) {
    let t = document.getElementById('reset-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'reset-toast';
      t.className = 'reset-toast';
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
    clearTimeout(showDoseToast._timer);
    showDoseToast._timer = setTimeout(() => {
      t.classList.remove('reset-toast--show');
    }, 4500);
  }

  /** Toggle al UI-ului: butoane disabled + spinner + progress vizibil. */
  function setDoseUiBusy(busy, statusText) {
    doseActive = busy;
    el.flow.dataset.doseActive = busy ? 'true' : 'false';
    el.doseStart.disabled = busy;
    el.dosePort.disabled = busy;
    el.doseMl.disabled = busy;

    if (busy) {
      el.doseStart.innerHTML =
        '<span class="btn-spinner" aria-hidden="true"></span>' +
        '<span>' + (statusText || 'Se udă…') + '</span>';
      el.doseProgress.hidden = false;
      el.doseProgressFill.style.width = '0%';
      el.doseProgressLabel.textContent = 'Trimite comanda…';
    } else {
      el.doseStart.innerHTML = '<span class="btn__label">Start udare</span>';
      el.doseProgress.hidden = true;
      if (doseAnimTimer) {
        cancelAnimationFrame(doseAnimTimer);
        doseAnimTimer = null;
      }
      doseExpectedTotalMs = 0;
      doseStartMs = 0;
    }
  }

  // ---------- Polling stare hub ----------

  async function poll() {
    // Fără cod de acces / fără hub provizionat — nu interogăm (am primi
    // doar 404). Blocăm comenzile şi afişăm bannerul.
    if (!(window.Dropwise && window.Dropwise.canUseHub
          && window.Dropwise.canUseHub())) {
      setControlsDisabled(true, true);
      return;
    }
    try {
      const r = await fetch('/api/hub/status', { cache: 'no-store' });
      const j = await r.json();

      if (!j.online || !j.data) {
        // Hub confirmat offline => blocăm + afişăm bannerul.
        setControlsDisabled(true, true);
        return;
      }

      // Hub online => deblocăm comenzile, ascundem bannerul.
      setControlsDisabled(false, false);
      render(j.data);
    } catch (e) {
      setControlsDisabled(true, true);
    }
  }

  // Urmărim wateringPort între cadre ca să detectăm tranziţia "se udă → idle"
  // care semnalează finalul dozării.
  let lastWateringPort = -1;

  /** Reflectă în UI starea raportată de hub. */
  function render(data) {
    const ports = data.ports || [];
    const wateringPort = (data.wateringPort === undefined)
      ? -1 : data.wateringPort;

    // Dozare activă + hub-ul a ajuns la idle => terminat.
    if (doseActive && lastWateringPort > 0 && wateringPort < 0) {
      onDoseComplete();
    }
    lastWateringPort = wateringPort;

    // -- Toggle GPIO: pompă + valve --
    const pinValue = {
      16: !!data.pump,
      17: portValve(ports, 1),
      18: portValve(ports, 2),
      19: portValve(ports, 3),
    };
    PINS.forEach((pin) => {
      if (pinPending[pin]) return;   // comandă în curs — nu suprascriem
      const btn = document.getElementById('gpio-' + pin);
      const on = pinValue[pin];
      setBtnState(btn, on ? 'on' : 'off', on ? 'pornit' : 'oprit');
    });

    // -- Diagrama hidraulică --
    setHydroNode(el.hydroPump, !!data.pump);
    setHydroNode(el.hydroValve1, portValve(ports, 1));
    setHydroNode(el.hydroValve2, portValve(ports, 2));
    setHydroNode(el.hydroValve3, portValve(ports, 3));

    // -- Butoane udare per port --
    PORTS.forEach((port) => {
      if (waterPending[port]) return;
      const btn = document.getElementById('water-' + port);
      const pd = ports.find((p) => p.port === port);

      if (!pd || !pd.confirmed) {
        // Port neconfirmat — udarea nu are sens.
        btn.disabled = true;
        setBtnState(btn, 'off', 'indisponibil');
        return;
      }
      if (wateringPort > 0 && wateringPort !== port) {
        // Alt port se udă — un singur port simultan.
        btn.disabled = true;
        setBtnState(btn, 'off', 'blocat');
        return;
      }
      btn.disabled = false;
      if (wateringPort === port) {
        setBtnState(btn, 'on', 'se udă');
      } else {
        setBtnState(btn, 'off', 'inactiv');
      }
    });

    // -- Mesaj de stare udare --
    if (wateringPort > 0) {
      el.waterStatus.textContent = 'Udare activă pe Port ' + wateringPort;
    } else {
      el.waterStatus.textContent =
        'Selectează un port pentru a porni udarea.';
    }
  }

  /** Valoarea valvei pentru un port (1-based) din lista de porturi. */
  function portValve(ports, port) {
    const pd = ports.find((p) => p.port === port);
    return pd ? !!pd.valve : false;
  }

  /** Aprinde/stinge un nod din diagrama hidraulică. */
  function setHydroNode(node, active) {
    if (node) node.dataset.active = active ? 'true' : 'false';
  }

  // ---------- Disclaimer de risc ----------

  /**
   * Afişează dialogul de avertizare la intrarea pe tab-ul Control.
   * - Confirmare  => rămâne pe Control, porneşte polling-ul.
   * - Anulare/Esc => revine la tab-ul Monitorizare.
   * Se afişează o singură dată per sesiune (disclaimerAccepted).
   */
  function showDisclaimer() {
    const dlg = el.disclaimer;
    if (!dlg || typeof dlg.showModal !== 'function') {
      // Browser fără suport <dialog> — degradăm elegant, fără blocaj.
      disclaimerAccepted = true;
      startPolling();
      return;
    }

    // Resetăm checkbox-ul + butonul la fiecare deschidere.
    el.disclaimerAck.checked = false;
    el.disclaimerConfirm.disabled = true;
    dlg.showModal();
  }

  /** Utilizatorul a confirmat — deblocăm tab-ul Control. */
  function acceptDisclaimer() {
    disclaimerAccepted = true;
    try { sessionStorage.setItem(DISCLAIMER_KEY, 'true'); } catch (_) {}
    el.disclaimer.close();
    startPolling();
  }

  /** Utilizatorul a refuzat — îl trimitem înapoi la Monitorizare. */
  function declineDisclaimer() {
    el.disclaimer.close();
    stopPolling();
    if (window.Dropwise && window.Dropwise.activateTab) {
      window.Dropwise.activateTab('monitor');
    }
  }

  // ---------- Polling lifecycle ----------

  function startPolling() {
    if (pollTimer) return;
    // Stare iniţială: comenzi blocate, banner de loading vizibil,
    // banner offline ascuns — până vine primul răspuns de la poll().
    el.flow.dataset.disabled = 'true';
    el.loading.hidden = false;
    el.offline.hidden = true;
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ---------- Init ----------

  function init() {
    const panel = document.getElementById('panel-control');
    if (!panel) return;

    el = {
      flow: document.getElementById('control-flow'),
      offline: document.getElementById('control-offline'),
      loading: document.getElementById('control-loading'),
      waterStatus: document.getElementById('water-status'),
      hydroPump: document.getElementById('hydro-pump'),
      hydroValve1: document.getElementById('hydro-valve1'),
      hydroValve2: document.getElementById('hydro-valve2'),
      hydroValve3: document.getElementById('hydro-valve3'),
      disclaimer: document.getElementById('control-disclaimer'),
      disclaimerAck: document.getElementById('disclaimer-ack'),
      disclaimerConfirm: document.getElementById('disclaimer-confirm'),
      disclaimerCancel: document.getElementById('disclaimer-cancel'),
      // Udare cantitate fixă
      dosePort: document.getElementById('dose-port'),
      doseMl: document.getElementById('dose-ml'),
      doseStart: document.getElementById('dose-start'),
      doseProgress: document.getElementById('dose-progress'),
      doseProgressFill: document.getElementById('dose-progress-fill'),
      doseProgressLabel: document.getElementById('dose-progress-label'),
    };

    // ----- Dialogul de disclaimer -----
    // Butonul de confirmare se activează doar după bifarea riscului.
    el.disclaimerAck.addEventListener('change', () => {
      el.disclaimerConfirm.disabled = !el.disclaimerAck.checked;
    });
    el.disclaimerConfirm.addEventListener('click', acceptDisclaimer);
    el.disclaimerCancel.addEventListener('click', declineDisclaimer);
    // Închiderea cu Esc (sau orice altă cale) = refuz => înapoi la Monitorizare.
    el.disclaimer.addEventListener('cancel', (ev) => {
      ev.preventDefault();   // gestionăm noi închiderea
      declineDisclaimer();
    });

    // Listener pe butoanele de toggle GPIO.
    PINS.forEach((pin) => {
      const btn = document.getElementById('gpio-' + pin);
      if (btn) btn.addEventListener('click', () => togglePin(pin));
    });

    // Listener pe butoanele de udare.
    PORTS.forEach((port) => {
      const btn = document.getElementById('water-' + port);
      if (btn) btn.addEventListener('click', () => toggleWater(port));
    });

    // Listener pe butonul de udare cu cantitate fixă.
    if (el.doseStart) el.doseStart.addEventListener('click', startDose);

    // Pornim polling-ul doar când tab-ul Control e activ — altfel
    // consumăm inutil cereri către hub. dashboard.js emite evenimentul.
    // La prima accesare per sesiune, afişăm întâi disclaimer-ul de risc.
    window.addEventListener('dropwise:tab-activated', (ev) => {
      if (ev.detail && ev.detail.tab === 'control') {
        if (disclaimerAccepted) {
          startPolling();
        } else {
          showDisclaimer();   // polling-ul porneşte abia după confirmare
        }
      } else {
        stopPolling();
      }
    });

    // Dacă pagina se încarcă direct pe tab-ul Control (hash #control),
    // afişăm disclaimer-ul înainte de orice.
    if (panel.dataset.active === 'true') {
      if (disclaimerAccepted) startPolling();
      else showDisclaimer();
    }

    // Oprim polling-ul când fila browserului trece în fundal.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPolling();
      } else if (panel.dataset.active === 'true' && disclaimerAccepted) {
        startPolling();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();

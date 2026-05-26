/* ============================================================
   Dropwise — Noduri: grila de carduri (Monitor + Noduri)
   ============================================================
   Randarea cardurilor de nod şi polling-ul stării hub-ului.
   Foloseşte namespace-ul partajat window.Dropwise.nodes.
   ============================================================ */

(function () {
  'use strict';

  const nodes = window.Dropwise.nodes;
  const { show, hide, getJSON, canPoll } = nodes;

  // ---------- Polling grilă ----------

  // Cache diagnostic — se invalidează la pierdere de conexiune sau la
  // detectarea unui reboot al hub-ului (uptime scade brusc).
  let receivedBootLog = false;
  let bootLogData = null;
  let lastUptimeMs = 0;

  nodes.pollMonitor = async function () {
    const el = nodes.el;
    // Fără cod / fără hub provizionat — nu interogăm (am primi doar 404).
    if (!canPoll()) {
      setHubCard('pending', null);
      el.nodeGrid.innerHTML = '';
      receivedBootLog = false;
      bootLogData = null;
      updateDiagBadge();
      return;
    }
    try {
      const j = await getJSON('/api/hub/status', { cache: 'no-store' });
      if (!j.online || !j.data) {
        setHubCard('offline', null);
        el.nodeGrid.innerHTML = '';
        receivedBootLog = false;
        bootLogData = null;
        updateDiagBadge();
        return;
      }
      setHubCard('online', j.data);
      renderNodeGrid(j.data.ports || [], el.nodeGrid);

      // Stocăm ultimele date de status într-un global accesibil altor module
      // (ex: settings.js pentru afişarea orei). Plus eveniment custom pentru
      // sincronizare reactivă.
      window.Dropwise = window.Dropwise || {};
      window.Dropwise.lastHubData = j.data;
      window.dispatchEvent(new CustomEvent('dropwise:hub-status-updated'));

      // Detectare boot nou: uptime scade vs. ce ţineam minte.
      const upt = j.data.uptime_ms;
      if (upt != null) {
        if (upt < lastUptimeMs) {
          receivedBootLog = false;   // hub-ul s-a restartat
        }
        lastUptimeMs = upt;
      }
      // Dacă nu am log-ul (prima dată / pierdere conexiune / reboot),
      // îl cerem acum şi îl cache-uim.
      if (!receivedBootLog) fetchBootLog();
    } catch (e) {
      setHubCard('offline', null);
      el.nodeGrid.innerHTML = '';
      receivedBootLog = false;
      bootLogData = null;
      updateDiagBadge();
    }
  };

  async function fetchBootLog() {
    try {
      const j = await getJSON('/api/hub/diagnostics',
                              { cache: 'no-store' });
      if (j.online && j.data) {
        bootLogData = j.data;
        receivedBootLog = true;
        updateDiagBadge();
      }
    } catch (e) { /* lasam pentru polling-ul urmator */ }
  }

  /** True dacă diagnosticul conţine cel puţin un modul în starea "lipsă". */
  function hasDiagIssues(d) {
    if (!d) return false;
    return d.oled === false || d.eeprom === false || d.rtc === false;
  }

  /** Marchează butonul Diagnostic cu un punct roşu dacă există probleme. */
  function updateDiagBadge() {
    const btn = document.getElementById('btn-diagnostics');
    if (!btn) return;
    btn.dataset.hasIssues = hasDiagIssues(bootLogData) ? 'true' : 'false';
  }

  /**
   * Actualizează cardul de stare al hub-ului de pe tab-ul Monitor.
   * @param state 'online' | 'offline' | 'pending'
   * @param data  payload-ul /status (doar la 'online'), pentru IP + canal
   */
  function setHubCard(state, data) {
    const card = nodes.el.hubCard;
    if (!card) return;
    card.dataset.state = state;

    const stateEl = card.querySelector('#hub-card-state');
    const detail  = card.querySelector('#hub-card-detail');
    const ipEl    = card.querySelector('#hub-card-ip');
    const chEl    = card.querySelector('#hub-card-channel');
    const timeEl  = card.querySelector('#hub-card-time');

    if (state === 'online') {
      stateEl.textContent = 'Hub online';
      detail.textContent = 'Hub-ul răspunde — datele sunt actualizate.';
      ipEl.textContent = (data && data.ip) || '—';
      chEl.textContent = (data && data.channel != null)
        ? String(data.channel) : '—';
      if (timeEl) timeEl.textContent = (data && data.time) || '—';
    } else if (state === 'offline') {
      stateEl.textContent = 'Hub-ul nu răspunde';
      detail.textContent = 'Verifică alimentarea şi conexiunea la reţea.';
      ipEl.textContent = '—';
      chEl.textContent = '—';
      if (timeEl) timeEl.textContent = '—';
    } else {
      stateEl.textContent = 'Hub neconectat';
      detail.textContent = 'Introdu codul de acces pentru a vedea starea.';
      ipEl.textContent = '—';
      chEl.textContent = '—';
      if (timeEl) timeEl.textContent = '—';
    }
  }
  nodes.setHubCard = setHubCard;

  /** Poll pentru grila de pe tabul Noduri (când wizardul NU e deschis). */
  nodes.pollNodesGrid = async function () {
    const el = nodes.el;
    // Cât timp wizardul sau statisticile sunt deschise, grila e ascunsă.
    if (!el.wizard.hidden || !el.nodeStats.hidden) return;
    if (!canPoll()) return;
    try {
      const j = await getJSON('/api/hub/status', { cache: 'no-store' });
      if (j.online && j.data) {
        renderNodeGrid(j.data.ports || [], el.nodesGrid);
      }
    } catch (e) { /* lăsăm grila aşa cum e */ }
  };

  /**
   * Sincronizează o grilă de carduri cu starea raportată de hub.
   * Cardurile NU sunt reconstruite la fiecare poll — sunt create o dată şi
   * apoi doar actualizate în loc. Asta elimină flick-ul de re-randare.
   */
  function renderNodeGrid(ports, grid) {
    const seen = new Set();

    // Un card pentru FIECARE port — slot gol inclusiv. Cardul e identificat
    // după numărul portului (numele nodului lipseşte la slot gol).
    ports.forEach((p) => {
      seen.add(String(p.port));
      let card = grid.querySelector('.node-card[data-port="' + p.port + '"]');
      if (!card) {
        card = document.createElement('article');
        card.className = 'node-card';
        card.dataset.port = p.port;
        buildCardSkeleton(card);
        grid.appendChild(card);
      }
      if (p.physical && p.confirmed) {
        updateCard(card, p);
      } else if (p.physical) {
        updateHandshakeCard(card, p);
      } else {
        updateEmptyCard(card, p);
      }
    });

    // Eliminăm cardurile pentru porturi care nu mai sunt raportate.
    grid.querySelectorAll('.node-card').forEach((c) => {
      if (!seen.has(c.dataset.port)) c.remove();
    });
  }
  nodes.renderNodeGrid = renderNodeGrid;

  /** Card de slot gol — niciun nod conectat pe acest port. */
  function updateEmptyCard(card, port) {
    if (card.dataset.state !== 'empty') {
      card.dataset.state = 'empty';
      card.querySelector('.node-card__title').textContent = 'Port ' + port.port;
      card.querySelector('.node-card__badge').hidden = true;
      card.querySelector('.node-card__menu').hidden = true;
      card.querySelector('.node-card__media').hidden = true;
      card.querySelector('.node-card__hint').hidden = true;
      card.querySelector('.node-card__plant').hidden = true;
      card.querySelector('.node-card__soil').hidden = true;
      card.querySelector('.node-card__sensors').hidden = true;
      card.querySelector('.node-card__cfg').hidden = true;
      const gb = card.querySelector('.node-card__graph');
      if (gb) gb.hidden = true;
      card.querySelector('.node-card__handshake').hidden = true;
      card.style.removeProperty('--node-accent');
    }
  }

  /** Card în handshake — nod detectat, se aşteaptă confirmarea hub-ului. */
  function updateHandshakeCard(card, port) {
    if (card.dataset.state !== 'handshake') {
      card.dataset.state = 'handshake';
      card.querySelector('.node-card__title').textContent = 'Port ' + port.port;
      card.querySelector('.node-card__badge').hidden = true;
      card.querySelector('.node-card__menu').hidden = true;
      card.querySelector('.node-card__media').hidden = true;
      card.querySelector('.node-card__hint').hidden = true;
      card.querySelector('.node-card__plant').hidden = true;
      card.querySelector('.node-card__soil').hidden = true;
      card.querySelector('.node-card__sensors').hidden = true;
      card.querySelector('.node-card__cfg').hidden = true;
      const gb2 = card.querySelector('.node-card__graph');
      if (gb2) gb2.hidden = true;
      card.querySelector('.node-card__handshake').hidden = false;
      card.style.removeProperty('--node-accent');
    }
  }

  /** Construieşte o singură dată structura fixă a unui card. */
  function buildCardSkeleton(card) {
    card.innerHTML = `
      <div class="node-card__head">
        <span class="node-card__title"></span>
        <span class="node-card__badge"></span>
        <div class="node-card__menu" hidden>
          <button type="button" class="node-card__menu-btn"
                  aria-label="Opţiuni nod" aria-haspopup="true"
                  aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5"  r="2"/>
              <circle cx="12" cy="12" r="2"/>
              <circle cx="12" cy="19" r="2"/>
            </svg>
          </button>
          <div class="node-card__menu-list" role="menu" hidden>
            <button type="button" class="node-card__menu-item" role="menuitem"
                    data-action="stats">
              <svg class="node-card__menu-icon" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <line x1="6"  y1="20" x2="6"  y2="12"/>
                <line x1="12" y1="20" x2="12" y2="4"/>
                <line x1="18" y1="20" x2="18" y2="14"/>
              </svg>
              <span>Statistici</span>
            </button>
            <button type="button" class="node-card__menu-item" role="menuitem"
                    data-action="graph">
              <svg class="node-card__menu-icon" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <path d="M3 3 v 18 h 18"/>
                <polyline points="7 15 11 10 14 13 20 6"/>
              </svg>
              <span>Grafice</span>
            </button>
            <button type="button" class="node-card__menu-item" role="menuitem"
                    data-action="params">
              <svg class="node-card__menu-icon" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <line x1="4" y1="6"  x2="20" y2="6"/>
                <line x1="4" y1="12" x2="20" y2="12"/>
                <line x1="4" y1="18" x2="20" y2="18"/>
                <circle cx="8"  cy="6"  r="2" fill="currentColor"/>
                <circle cx="16" cy="12" r="2" fill="currentColor"/>
                <circle cx="10" cy="18" r="2" fill="currentColor"/>
              </svg>
              <span>Parametri</span>
            </button>
            <button type="button" class="node-card__menu-item" role="menuitem"
                    data-action="reconfigure">
              <svg class="node-card__menu-icon" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <path d="M21 12 a 9 9 0 1 1 -3 -6.7"/>
                <polyline points="21 4 21 10 15 10"/>
              </svg>
              <span>Reconfigurează</span>
            </button>
            <button type="button"
                    class="node-card__menu-item node-card__menu-item--danger"
                    role="menuitem"
                    data-action="reset">
              <svg class="node-card__menu-icon" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6 l -1 14 a 2 2 0 0 1 -2 2 H 8 a 2 2 0 0 1 -2 -2 L 5 6"/>
                <path d="M10 11 v 6 M 14 11 v 6"/>
                <path d="M9 6 V 4 a 2 2 0 0 1 2 -2 h 2 a 2 2 0 0 1 2 2 v 2"/>
              </svg>
              <span>Resetare</span>
            </button>
          </div>
        </div>
      </div>
      <div class="node-card__media">
        <img class="node-card__img" alt="" hidden />
      </div>
      <p class="node-card__hint"></p>
      <p class="node-card__plant"></p>
      <p class="node-card__soil"></p>
      <div class="node-card__sensors"></div>
      <button type="button" class="btn btn--primary node-card__cfg"></button>
      <button type="button" class="btn btn--ghost node-card__graph" hidden>
        <svg class="node-card__graph-icon" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true">
          <path d="M3 3 v 18 h 18"/>
          <polyline points="7 15 11 10 14 13 20 6"/>
        </svg>
        <span>Vezi grafice</span>
      </button>
      <div class="node-card__handshake" hidden>
        <span>Conectare</span>
        <span class="node-card__dots" aria-hidden="true">
          <span></span><span></span><span></span>
        </span>
      </div>`;

    // Buton mare "Configurează" — vizibil doar pe nodurile neconfigurate.
    card.querySelector('.node-card__cfg').addEventListener('click', () => {
      if (card.dataset.node) nodes.openWizardForNode(card.dataset.node);
    });
    // Buton "Vezi grafic" — vizibil doar pe nodurile configurate (Monitor).
    card.querySelector('.node-card__graph').addEventListener('click', () => {
      if (card.dataset.node) openGraphView(card.dataset.node);
    });

    // Meniul ⋯
    const menu = card.querySelector('.node-card__menu');
    const menuBtn = menu.querySelector('.node-card__menu-btn');
    const menuList = menu.querySelector('.node-card__menu-list');

    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = menuList.hidden;
      closeAllNodeMenus();
      menuList.hidden = !open;
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    menu.querySelector('[data-action="reconfigure"]')
      .addEventListener('click', () => {
        menuList.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        if (card.dataset.node) nodes.openWizardForReconfigure(card.dataset.node);
      });
    menu.querySelector('[data-action="stats"]')
      .addEventListener('click', () => {
        menuList.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        if (card.dataset.node) nodes.openNodeStats(card.dataset.node);
      });
    menu.querySelector('[data-action="graph"]')
      .addEventListener('click', () => {
        menuList.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        if (card.dataset.node) openGraphView(card.dataset.node);
      });
    menu.querySelector('[data-action="params"]')
      .addEventListener('click', () => {
        menuList.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        if (card.dataset.node) nodes.openNodeParams(card.dataset.node);
      });
    menu.querySelector('[data-action="reset"]')
      .addEventListener('click', () => {
        menuList.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        if (card.dataset.node) nodes.confirmResetNode(card.dataset.node);
      });
  }

  /** Închide toate meniurile ⋯ deschise. */
  function closeAllNodeMenus() {
    document.querySelectorAll('.node-card__menu-list').forEach((m) => {
      m.hidden = true;
    });
    document.querySelectorAll('.node-card__menu-btn').forEach((b) => {
      b.setAttribute('aria-expanded', 'false');
    });
  }

  /** Actualizează în loc conţinutul unui card existent (nod confirmat). */
  function updateCard(card, port) {
    const title = card.querySelector('.node-card__title');
    const badge = card.querySelector('.node-card__badge');
    const hint  = card.querySelector('.node-card__hint');
    const plant = card.querySelector('.node-card__plant');
    const soil  = card.querySelector('.node-card__soil');
    const sens  = card.querySelector('.node-card__sensors');
    const btn   = card.querySelector('.node-card__cfg');
    const menu  = card.querySelector('.node-card__menu');
    const media = card.querySelector('.node-card__media');
    const img   = card.querySelector('.node-card__img');
    const hand  = card.querySelector('.node-card__handshake');

    card.dataset.node = port.name;
    hand.hidden = true;

    const titleTxt = 'Port ' + port.port + '  ·  ' + port.name;
    if (title.textContent !== titleTxt) title.textContent = titleTxt;
    badge.hidden = false;

    if (port.configured) {
      // --- Nod configurat ---
      if (card.dataset.state !== 'configured') {
        card.dataset.state = 'configured';
        badge.className = 'node-card__badge node-card__badge--ok';
        badge.textContent = 'activ';
        menu.hidden = false;
        btn.hidden = true;
        hint.hidden = true;
        media.hidden = false;
        plant.hidden = false;
        soil.hidden = false;
        sens.hidden = false;
      }
      const cfg = port.config;
      if (cfg && cfg.plant) {
        if (plant.textContent !== cfg.plant.name) plant.textContent = cfg.plant.name;
        if (soil.textContent !== cfg.soil.name) soil.textContent = cfg.soil.name;
        applyCardColor(card, cfg.color);
        setPlantImage(img, cfg.plant.id, cfg.plant.name);
      }
      // Datele de senzori + butonul "Vezi grafic" — DOAR pe grila Monitor.
      const onMonitor = !!card.closest('#node-grid');
      const graphBtn = card.querySelector('.node-card__graph');
      if (!onMonitor) {
        sens.hidden = true;
        if (graphBtn) graphBtn.hidden = true;
      } else {
        renderSensors(sens, port.sensors, port.config);
        if (graphBtn) graphBtn.hidden = false;
      }
    } else {
      // --- Nod neconfigurat ---
      if (card.dataset.state !== 'unconfigured') {
        card.dataset.state = 'unconfigured';
        badge.className = 'node-card__badge node-card__badge--warn';
        badge.textContent = 'neconfigurat';
        menu.hidden = true;
        btn.hidden = false;
        btn.textContent = 'Configurează';
        hint.hidden = false;
        hint.textContent =
          'Nodul nu este configurat. Sistemul nu udă acest ghiveci ' +
          'până nu alegi planta şi solul.';
        media.hidden = true;
        plant.hidden = true;
        soil.hidden = true;
        sens.hidden = true;
        delete sens.dataset.filled;
        const gb3 = card.querySelector('.node-card__graph');
        if (gb3) gb3.hidden = true;
        card.style.removeProperty('--node-accent');
        img.hidden = true;
        img.removeAttribute('src');
      }
    }
  }

  /**
   * Setează imaginea unei plante (static/plants/<id>.png).
   * La fişier lipsă (onerror), ascunde elementul img elegant.
   */
  function setPlantImage(img, plantId, plantName) {
    const src = '/static/plants/' + plantId + '.png';
    if (img.getAttribute('src') === src) return;
    img.onerror = () => { img.hidden = true; };
    img.onload = () => { img.hidden = false; };
    img.alt = plantName || '';
    img.src = src;
  }

  /** Aplică culoarea aleasă pe tot cardul, prin variabila CSS --node-accent. */
  function applyCardColor(card, colorId) {
    if (!nodes.catalog) return;
    const c = nodes.catalog.colors.find((x) => x.id === colorId);
    if (!c) return;
    if (card.style.getPropertyValue('--node-accent') !== c.accent) {
      card.style.setProperty('--node-accent', c.accent);
    }
  }
  nodes.applyCardColor = applyCardColor;

  // ---------- Modal Diagnostic hub ----------
  //
  // Buton "Vezi diagnostica" pe cardul hub din Monitor → deschide un modal
  // cu log-ul de boot şi statusul modulelor I²C (OLED/EEPROM/RTC). Datele
  // sunt cache-uite local (`bootLogData`); se recer dacă hub-ul a fost
  // offline sau s-a restartat (vezi `pollMonitor`).

  let diagDialog = null;

  function ensureDiagDialog() {
    if (diagDialog) return diagDialog;
    const dlg = document.createElement('dialog');
    dlg.id = 'diag-dialog';
    dlg.className = 'diag-dialog';
    dlg.innerHTML = `
      <div class="diag-dialog__body">
        <header class="diag-dialog__head">
          <h2 class="diag-dialog__title">Diagnostic hub</h2>
          <button type="button" class="diag-dialog__close"
                  aria-label="Închide" data-action="close">×</button>
        </header>
        <div class="diag-dialog__modules">
          <span class="diag-pill" data-mod="oled">OLED</span>
          <span class="diag-pill" data-mod="eeprom">EEPROM</span>
          <span class="diag-pill" data-mod="rtc">RTC</span>
          <span class="diag-pill diag-pill--neutral" data-mod="uptime">Uptime</span>
        </div>
        <textarea class="diag-dialog__log" readonly></textarea>
      </div>
    `;
    document.body.appendChild(dlg);
    dlg.querySelector('[data-action="close"]')
      .addEventListener('click', () => dlg.close());
    diagDialog = dlg;
    return dlg;
  }

  function fmtUptime(ms) {
    if (ms == null) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function openDiagnosticsDialog() {
    const dlg = ensureDiagDialog();
    const data = bootLogData;
    const setPill = (mod, ok) => {
      const el = dlg.querySelector(`[data-mod="${mod}"]`);
      if (!el) return;
      el.dataset.state = ok ? 'ok' : 'missing';
    };
    if (data) {
      setPill('oled',   data.oled);
      setPill('eeprom', data.eeprom);
      setPill('rtc',    data.rtc);
      const upEl = dlg.querySelector('[data-mod="uptime"]');
      upEl.textContent = 'Uptime: ' + fmtUptime(data.uptime_ms);
      dlg.querySelector('.diag-dialog__log').value =
        data.boot_log || '(log gol)';
    } else {
      ['oled','eeprom','rtc'].forEach(m => setPill(m, false));
      dlg.querySelector('[data-mod="uptime"]').textContent = 'Uptime: —';
      dlg.querySelector('.diag-dialog__log').value =
        'Diagnosticul nu a putut fi obţinut de la hub. Verifică ' +
        'conexiunea şi reîncearcă.';
      // Mai încercăm o dată acum, în background.
      fetchBootLog().then(() => {
        if (bootLogData && dlg.open) openDiagnosticsDialog();
      });
    }
    if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
  }

  // ---------- Senzori (afişaţi pe cardurile din tab-ul Monitor) ----------
  //
  // Hub-ul trimite 4 valori per nod în pachetul `/status`:
  //   soil_moisture_pct, air_temp_c, air_humidity_pct, lux
  // Cât timp datele sunt mock, valorile sunt deterministe per nume nod.

  // Definiţia rândurilor: eticheta + cheia din JSON + unitate + zecimale.
  const SENSOR_ROWS = [
    { key: 'soil_moisture_pct', label: 'Umiditate sol',  unit: '%',  dec: 1 },
    { key: 'air_temp_c',        label: 'Temp. aer',      unit: '°C', dec: 1 },
    { key: 'air_humidity_pct',  label: 'Umiditate aer',  unit: '%',  dec: 1 },
    { key: 'lux',               label: 'Lumină',         unit: 'lx', dec: 0 },
  ];

  // SVG triunghi cu semn de exclamare — afişat la stânga valorii în alertă.
  const ALERT_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true">' +
    '<path d="M12 3 L 22 20 H 2 Z"/>' +
    '<path d="M12 10 v 5"/>' +
    '<path d="M12 18 h 0.01"/>' +
    '</svg>';

  /**
   * Verifică pragurile de lumină din config-ul plantei şi întoarce
   * obiectul de alertă (sau null dacă e ok / lipsă config).
   */
  function checkLuxAlert(lux, plantId) {
    if (lux == null || Number.isNaN(lux) || !plantId || !nodes.catalog) return null;
    const p = nodes.catalog.plants.find((x) => x.id === plantId);
    if (!p) return null;
    const min = p.lux_min;
    const max = p.lux_max;
    if (min != null && lux < min) {
      return {
        kind: 'low',
        message:
          `Lumină insuficientă pentru ${p.name}: ${Math.round(lux)} lx ` +
          `(recomandat peste ${min} lx). ` +
          `Mută planta mai aproape de o sursă de lumină sau adaugă o lampă de creştere.`,
      };
    }
    if (max != null && lux > max) {
      return {
        kind: 'high',
        message:
          `Lumină excesivă pentru ${p.name}: ${Math.round(lux)} lx ` +
          `(recomandat sub ${max} lx). ` +
          `Mută planta mai departe de fereastră sau filtrează lumina cu o perdea.`,
      };
    }
    return null;
  }

  function renderSensors(container, sensors, config) {
    if (!sensors) {
      container.innerHTML =
        '<span class="node-card__todo">Date senzori indisponibile</span>';
      return;
    }
    const plantId = config && config.plant ? config.plant.id : null;
    const luxAlert = checkLuxAlert(sensors.lux, plantId);

    // Construim mai întâi un nou snapshot şi-l comparăm cu cel cached
    // pentru a evita reflow-ul inutil la fiecare poll. Snapshot-ul include
    // şi starea de alertă, ca să se re-randeze când planta intră/iese din
    // zona de avertizare. Pentru valori null (senzor lipsă) folosim marcaj
    // special "MISS" — afişat ca badge, nu ca text formatat.
    const values = SENSOR_ROWS.map((r) => {
      const v = sensors[r.key];
      if (v == null || Number.isNaN(v)) return 'MISS';
      return Number(v).toFixed(r.dec);
    });
    const alertKey = luxAlert ? luxAlert.kind + ':' + luxAlert.message : 'ok';
    const snap = values.join('|') + '#' + alertKey;
    if (container.dataset.snap === snap) return;
    container.dataset.snap = snap;

    container.innerHTML = '';
    const dl = document.createElement('dl');
    dl.className = 'sensor-list';
    SENSOR_ROWS.forEach((r, i) => {
      const dt = document.createElement('dt');
      dt.className = 'sensor-list__label';
      dt.textContent = r.label;

      const dd = document.createElement('dd');
      dd.className = 'sensor-list__value';

      const isMissing = values[i] === 'MISS';

      // Alertă (doar pe rândul Lumină) — triunghi cu tooltip pe hover.
      // Nu apare pe valoare lipsă (n-ar avea sens — nu ştim cât e lux).
      if (r.key === 'lux' && luxAlert && !isMissing) {
        dd.classList.add('sensor-list__value--alert');
        const alertWrap = document.createElement('span');
        alertWrap.className = 'sensor-list__alert';
        alertWrap.innerHTML = ALERT_ICON;
        const tip = document.createElement('span');
        tip.className = 'sensor-list__tip';
        tip.textContent = luxAlert.message;
        alertWrap.appendChild(tip);
        // Accesibilitate: tooltip fallback nativ pe titlu.
        alertWrap.setAttribute('title', luxAlert.message);
        dd.appendChild(alertWrap);
      }

      if (isMissing) {
        // Badge "Lipseşte" în locul valorii — fără unitate.
        const badge = document.createElement('span');
        badge.className = 'sensor-list__missing';
        badge.textContent = 'Lipseşte';
        dd.appendChild(badge);
      } else {
        const val = document.createElement('span');
        val.className = 'sensor-list__num';
        val.textContent = values[i];
        const unit = document.createElement('span');
        unit.className = 'sensor-list__unit';
        unit.textContent = r.unit;
        dd.appendChild(val);
        dd.appendChild(unit);
      }

      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    container.appendChild(dl);
  }

  // ---------- Resetare nod ----------
  //
  // Buton "Resetare" în meniul ⋯ → dialog de avertizare → POST la backend
  // → toast de succes. Backend-ul şterge configul din state.json şi (în
  // modul real) trimite /node/Pi/forget la hub ca să zeroizeze slot-ul
  // EEPROM. Operaţie IREVERSIBILĂ.

  // Dialog construit dinamic la prima utilizare şi refolosit.
  let resetDialog = null;
  let resetTarget = null;

  function ensureResetDialog() {
    if (resetDialog) return resetDialog;

    const dlg = document.createElement('dialog');
    dlg.id = 'reset-node-dialog';
    dlg.className = 'reset-dialog';
    dlg.innerHTML = `
      <form method="dialog" class="reset-dialog__form">
        <h2 class="reset-dialog__title">Resetare nod</h2>
        <p class="reset-dialog__lead">
          Eşti pe cale să resetezi nodul <strong id="reset-dialog-node">—</strong>.
          Vor fi şterse <strong>toate datele</strong> asociate: configuraţia
          plantei, parametrii regulatorului şi statisticile salvate.
        </p>
        <p class="reset-dialog__warn">
          Această operaţie este <strong>ireversibilă</strong>. După resetare
          va trebui să reconfigurezi nodul de la zero.
        </p>
        <div class="reset-dialog__actions">
          <button type="button" class="btn btn--ghost"
                  data-action="reset-cancel">Anulează</button>
          <button type="button" class="btn btn--primary reset-dialog__confirm"
                  data-action="reset-confirm">
            <span class="btn__label">Resetare</span>
          </button>
        </div>
      </form>
    `;
    document.body.appendChild(dlg);

    dlg.querySelector('[data-action="reset-cancel"]')
      .addEventListener('click', () => {
        resetTarget = null;
        dlg.close();
      });
    dlg.querySelector('[data-action="reset-confirm"]')
      .addEventListener('click', performReset);

    // Esc => anulare implicită.
    dlg.addEventListener('cancel', () => {
      resetTarget = null;
    });

    resetDialog = dlg;
    return dlg;
  }

  /** Deschide dialogul de confirmare pentru resetarea unui nod. */
  nodes.confirmResetNode = function (nodeName) {
    const dlg = ensureResetDialog();
    resetTarget = nodeName;
    dlg.querySelector('#reset-dialog-node').textContent = nodeName;
    const confirmBtn = dlg.querySelector('[data-action="reset-confirm"]');
    confirmBtn.disabled = false;
    confirmBtn.classList.remove('btn--loading');
    confirmBtn.innerHTML = '<span class="btn__label">Resetare</span>';
    if (typeof dlg.showModal === 'function') {
      dlg.showModal();
    }
  };

  async function performReset() {
    if (!resetTarget) return;
    const dlg = resetDialog;
    const btn = dlg.querySelector('[data-action="reset-confirm"]');
    btn.disabled = true;
    btn.innerHTML =
      '<span class="btn-spinner" aria-hidden="true"></span>' +
      '<span>Se resetează…</span>';
    btn.classList.add('btn--loading');

    const nodeName = resetTarget;
    try {
      const j = await nodes.getJSON(
        '/api/node/' + encodeURIComponent(nodeName) + '/reset',
        { method: 'POST' });
      dlg.close();
      resetTarget = null;
      showResetToast(
        j.warning
          ? `Nodul ${nodeName} a fost resetat local. ${j.warning}`
          : `Nodul ${nodeName} a fost resetat cu succes.`,
        j.warning ? 'warn' : 'ok');
      // Reîmprospătăm grila pe tab-ul Noduri imediat.
      if (nodes.pollNodesGrid) nodes.pollNodesGrid();
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = '<span class="btn__label">Resetare</span>';
      btn.classList.remove('btn--loading');
      showResetToast('Resetare eşuată: ' + e.message, 'error');
    }
  }

  /** Toast inline plasat la baza ecranului — apare 4s şi dispare singur. */
  function showResetToast(msg, kind) {
    let t = document.getElementById('reset-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'reset-toast';
      t.className = 'reset-toast';
      document.body.appendChild(t);
    }
    t.dataset.kind = kind || 'ok';
    // Pictogramă: check pentru succes, ! pentru warning, X pentru eroare.
    const icon = (kind === 'error')
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true"><path d="M6 6 l12 12 M18 6 L 6 18"/></svg>'
      : (kind === 'warn')
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
          + 'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" '
          + 'aria-hidden="true"><path d="M12 9 v 5 M 12 17 h 0.01 '
          + 'M 12 3 L 22 20 H 2 Z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
          + 'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" '
          + 'aria-hidden="true"><path d="M5 12 l5 5 L 20 7"/></svg>';
    t.innerHTML =
      '<span class="reset-toast__icon">' + icon + '</span>' +
      '<span class="reset-toast__text"></span>';
    t.querySelector('.reset-toast__text').textContent = msg;
    t.classList.add('reset-toast--show');
    clearTimeout(showResetToast._timer);
    showResetToast._timer = setTimeout(() => {
      t.classList.remove('reset-toast--show');
    }, 4500);
  }

  // ---------- Init modul ----------

  // ---------- Pagina Grafic ----------
  //
  // Click pe "Vezi grafic" pe un card de Monitor → ascunde restul tab-ului
  // şi afişează 5 grafice (umiditate sol + lux pe rândul 1, cele 3 temp/
  // umiditate aer pe rândul 2). Datele vin de la /api/node/<P>/history,
  // 24 puncte orare. Chart.js încărcat lazy de prima dată când se deschide.

  let chartJsPromise = null;
  let activeCharts = [];
  // Cache pentru download CSV — populat la fiecare openGraphView.
  let lastHistorySamples = null;
  let lastHistoryNodeName = null;
  // Guard care previne recursia: activateTab('monitor') din openGraphView
  // declanşează dropwise:tab-activated → applyMonitorHash → openGraphView.
  let graphViewOpening = false;

  function loadChartJs() {
    if (chartJsPromise) return chartJsPromise;
    chartJsPromise = new Promise((resolve, reject) => {
      if (window.Chart) { resolve(window.Chart); return; }
      // Chart.js servit local din `static/lib/` — proiectul rămâne 100%
      // funcţional fără internet (doar router în LAN). Pentru update:
      // descarcă manual https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js
      const s = document.createElement('script');
      s.src = '/static/lib/chart.umd.min.js';
      s.onload = () => resolve(window.Chart);
      s.onerror = () => reject(new Error('Nu am putut încărca Chart.js (static/lib/)'));
      document.head.appendChild(s);
    });
    return chartJsPromise;
  }

  // Config per metrică: label, unitate, culoare linie, formatter tick.
  const GRAPH_METRICS = {
    soil_moisture_pct: { unit: '%',  color: 'rgba(184,240,201,1)' },
    lux:               { unit: 'lx', color: 'rgba(255,204,102,1)' },
    air_temp_c:        { unit: '°C', color: 'rgba(140,200,255,1)' },
    air_humidity_pct:  { unit: '%',  color: 'rgba(255,160,200,1)' },
  };

  async function openGraphView(nodeName) {
    if (graphViewOpening) return;     // re-entry blocat (vezi guard mai sus)
    graphViewOpening = true;

    const main  = document.getElementById('monitor-main');
    const view  = document.getElementById('node-graph');
    const title = document.getElementById('graph-node-name');
    if (!main || !view || !title) { graphViewOpening = false; return; }

    // Sincronizăm URL-ul. Forma: #monitor/Pi/graph — primul segment îl
    // gestionează dashboard.js pentru tab, restul îl gestionăm aici.
    // Folosim pushState (NU replaceState) ca să creăm un entry nou în
    // istoricul browserului — back-ul fizic va închide pagina Grafice.
    // Push-ul trebuie să se întâmple ÎNAINTE de activateTab, pentru că
    // dashboard.js se uită la curTab şi nu rescrie hash-ul dacă tab-ul
    // se potriveşte deja cu segmentul-rădăcină al URL-ului.
    const targetHash = '#monitor/' + nodeName + '/graph';
    if (window.location.hash !== targetHash) {
      history.pushState(null, '', targetHash);
    }
    // Acum activăm tab-ul Monitor (apel din meniul ⋯ pe tab-ul Noduri:
    // tab-ul curent e încă "nodes" şi trebuie comutat). dashboard.js
    // vede că curTab="monitor" ↔ name="monitor", nu mai atinge hash-ul.
    if (window.Dropwise && window.Dropwise.activateTab) {
      window.Dropwise.activateTab('monitor');
    }

    title.textContent = nodeName;
    main.hidden = true;
    view.hidden = false;
    nodes.stopMonitorPolling && nodes.stopMonitorPolling();

    // Afişăm card-ul de loading în locul graficelor + butonului CSV cât
    // timp aşteptăm Chart.js + datele de la hub. Pe live, fetch-ul către
    // hub poate dura câteva secunde (ESP-NOW + EEPROM read).
    setGraphLoading(true);

    // Curăţăm graficele anterioare (dacă se redeschide pagina).
    activeCharts.forEach((c) => c.destroy());
    activeCharts = [];

    // Încărcăm Chart.js (CDN) + istoric + config nod — paralel.
    // Atenţie: NU folosi `history` ca nume local — face shadow pe
    // window.history şi rupe `history.replaceState` apelat mai sus
    // (temporal dead zone). Folosim `historyData`.
    let chartLib, historyData, nodeCfg;
    try {
      [chartLib, historyData, nodeCfg] = await Promise.all([
        loadChartJs(),
        nodes.getJSON('/api/node/' + encodeURIComponent(nodeName) + '/history'),
        nodes.getJSON('/api/node/' + encodeURIComponent(nodeName)),
      ]);
    } catch (e) {
      view.querySelectorAll('.graph-card__canvas').forEach((c) => {
        c.parentElement.innerHTML = '<p class="setup-hint">Eroare la încărcarea graficelor: ' + e.message + '</p>';
      });
      setGraphLoading(false);
      graphViewOpening = false;
      return;
    }

    const samples = historyData.samples || [];
    lastHistorySamples = samples;
    lastHistoryNodeName = nodeName;

    // Grilă fixă de 24 slot-uri orare, terminând la ora curentă. Asta
    // garantează că axa X arată mereu un interval de 24 ore, chiar dacă
    // nodul are doar câteva sample-uri reale (restul rămân goluri/null).
    // Slot-ul k = ora HH:00 corespunzătoare timpului (acum - (23 - k) ore).
    const HOURS = 24;
    const now = Date.now();
    const nowHour = new Date(now);
    nowHour.setMinutes(0, 0, 0);
    const labels = [];
    const slotEpochs = [];   // epoch-ul (secunde) al fiecărui slot
    for (let i = 0; i < HOURS; i++) {
      const d = new Date(nowHour.getTime() - (HOURS - 1 - i) * 3600 * 1000);
      labels.push(d.getHours().toString().padStart(2, '0') + ':00');
      slotEpochs.push(Math.floor(d.getTime() / 1000));
    }

    // Index sample-urile reale pe ora lor (epoch întreg de oră).
    const sampleByHour = {};
    for (const s of samples) {
      const h = Math.floor(s.ts / 3600) * 3600;
      sampleByHour[h] = s;
    }

    /** Întoarce array-ul de 24 valori pentru o metrică, cu null acolo
        unde nu avem sample. */
    function alignedData(metricKey) {
      return slotEpochs.map((h) => {
        const s = sampleByHour[h];
        return s ? s[metricKey] : null;
      });
    }

    // Praguri pentru linii de referinţă pe grafic:
    //   - umiditate sol: setpoint (mereu vizibil, dashed alb subtil);
    //   - lumină: lux_min / lux_max — controlate de toggle-uri (Min/Max).
    const setpoint = nodeCfg && nodeCfg.regulator
      ? nodeCfg.regulator.setpoint : null;
    let luxMin = null, luxMax = null;
    if (nodeCfg && nodeCfg.plant && nodes.catalog) {
      const pl = nodes.catalog.plants.find((x) => x.id === nodeCfg.plant.id);
      if (pl) {
        luxMin = pl.lux_min != null ? pl.lux_min : null;
        luxMax = pl.lux_max != null ? pl.lux_max : null;
      }
    }

    // Helper: linie de referinţă (valoare constantă, dashed). Foloseşte
    // Chart.js dataset cu pointRadius 0 + borderDash. Etichetă în legendă.
    function referenceLine(label, value, color) {
      return {
        label: label,
        data: new Array(labels.length).fill(value),
        borderColor: color,
        backgroundColor: 'transparent',
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 0,
        pointHitRadius: 0,
        tension: 0,
        fill: false,
        spanGaps: true,
      };
    }

    view.querySelectorAll('.graph-card__canvas').forEach((canvas) => {
      const metric = canvas.dataset.metric;
      const cfg = GRAPH_METRICS[metric];
      if (!cfg) return;
      // 24 valori aliniate la grila orară fixă; null acolo unde lipsesc.
      const data = alignedData(metric);

      // Construim lista de dataset-uri: dataset principal + linii de referinţă.
      // Pentru graficele cu legendă (cele cu referinţe), datasetul principal
      // primeşte şi un label vizibil — apare în legendă, dar e marcat
      // _locked = true, deci click-ul pe el e ignorat (rămâne mereu vizibil).
      const datasets = [{
        label: metric === 'lux' ? 'Lux'
             : metric === 'soil_moisture_pct' ? 'Umiditate sol'
             : '',
        data: data,
        borderColor: cfg.color,
        backgroundColor: cfg.color.replace('1)', '0.15)'),
        fill: true,
        tension: 0.35,
        pointRadius: 2,
        pointHoverRadius: 4,
        borderWidth: 2,
        // Lăsăm gap-uri vizibile acolo unde lipsesc date — utilizatorul
        // vede clar ce slot-uri orare nu au fost încă populate de senzor.
        spanGaps: false,
        _locked: true,    // marker custom: click în legendă pe el = ignorat
      }];
      if (metric === 'soil_moisture_pct' && setpoint != null) {
        datasets.push(referenceLine(
          'Setpoint (' + setpoint + ' %)',
          setpoint,
          'rgba(255,255,255,0.6)'));
      }
      // Pentru lux, liniile Min/Max sunt adăugate ÎNTOTDEAUNA dar
      // `hidden: true` iniţial — utilizatorul le activează din legendă
      // (click pe label "Minim" / "Maxim" → linia apare).
      if (metric === 'lux') {
        if (luxMin != null) {
          const ds = referenceLine(
            'Minim (' + luxMin + ' lx)',
            luxMin,
            'rgba(255,138,138,0.7)');
          ds.hidden = true;
          datasets.push(ds);
        }
        if (luxMax != null) {
          const ds = referenceLine(
            'Maxim (' + luxMax + ' lx)',
            luxMax,
            'rgba(255,138,138,0.7)');
          ds.hidden = true;
          datasets.push(ds);
        }
      }

      // Avem legendă dacă există cel puţin o linie de referinţă (oricare).
      const hasRefLines = datasets.length > 1;

      const c = new chartLib(canvas, {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            // Legenda apare doar când avem linie de referinţă, ca să o
            // identifice; pentru graficele simple rămâne ascunsă.
            legend: hasRefLines
              ? {
                  display: true,
                  position: 'top',
                  align: 'end',
                  labels: {
                    color: 'rgba(255,255,255,0.7)',
                    font: { size: 10 },
                    boxWidth: 18,
                    boxHeight: 2,
                  },
                  // Click pe etichetă comută vizibilitatea dataset-ului,
                  // EXCEPTÂND cele marcate _locked (dataset-ul principal —
                  // datele de lux/umiditate nu trebuie să poată fi ascunse).
                  onClick: (e, legendItem, legend) => {
                    const ci = legend.chart;
                    const ds = ci.data.datasets[legendItem.datasetIndex];
                    if (ds._locked) return;   // ignorăm click-ul
                    ds.hidden = !ds.hidden;
                    ci.update();
                  },
                }
              : { display: false },
            tooltip: {
              backgroundColor: 'rgba(13,31,23,0.95)',
              borderColor: 'rgba(255,255,255,0.1)',
              borderWidth: 1,
              padding: 10,
              // Filtrăm tooltip-ul ca să apară doar valoarea reală,
              // nu liniile de referinţă (au valoare constantă).
              filter: (tooltipItem) => {
                const ds = tooltipItem.dataset;
                return !(ds && Array.isArray(ds.borderDash) && ds.borderDash.length > 0);
              },
              callbacks: {
                label: (ctx) => ctx.parsed.y + ' ' + cfg.unit,
              },
            },
          },
          scales: {
            x: {
              ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 10 }, maxRotation: 0 },
              grid:  { color: 'rgba(255,255,255,0.05)' },
            },
            y: {
              ticks: {
                color: 'rgba(255,255,255,0.5)', font: { size: 10 },
                callback: (v) => v + ' ' + cfg.unit,
              },
              grid:  { color: 'rgba(255,255,255,0.05)' },
            },
          },
        },
      });
      activeCharts.push(c);
    });

    setGraphLoading(false);
    graphViewOpening = false;
  }

  /** Comută între starea de loading (card central) şi conţinutul real
      (grafice + buton CSV) pe pagina Grafice. */
  function setGraphLoading(on) {
    const loader = document.getElementById('graph-loader');
    if (loader) loader.hidden = !on;
    document.querySelectorAll('#node-graph .graph-content').forEach((el) => {
      el.hidden = !!on;
    });
  }

  /**
   * Aplică ruta din hash pentru tabul Monitor.
   * Forme: monitor | monitor/<P>/graph
   * Apelată la activare tab + la hashchange (vezi initGrid).
   */
  nodes.applyMonitorHash = function () {
    const parts = window.location.hash.replace('#', '').split('/');
    if (parts[0] !== 'monitor') return;
    const node = parts[1];
    const view = parts[2];
    if (node && view === 'graph') {
      // Deschidem doar dacă nu suntem deja pe pagina graficului pentru
      // acelaşi nod (evită re-fetch + re-randare la fiecare hashchange).
      const cur = document.getElementById('graph-node-name');
      const onGraph = !document.getElementById('node-graph').hidden;
      if (!onGraph || !cur || cur.textContent !== node) {
        openGraphView(node);
      }
    } else {
      // Nu mai e #monitor/.../graph — închidem pagina dacă era deschisă.
      // (Apel direct la close-ul "tehnic" — istoricul s-a schimbat deja,
      // nu mai e nevoie de history.back).
      const v = document.getElementById('node-graph');
      if (v && !v.hidden) doCloseGraphView();
    }
  };

  /** Generează CSV cu ultimele samples şi declanşează download în browser. */
  function downloadHistoryCsv() {
    if (!lastHistorySamples || !lastHistorySamples.length) return;

    const header = [
      'timestamp', 'datetime',
      'soil_moisture_pct',
      'air_temp_c', 'air_humidity_pct', 'lux',
    ];
    const rows = [header.join(',')];
    for (const s of lastHistorySamples) {
      const d = new Date(s.ts * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const datetime =
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' +
        pad(d.getSeconds());
      rows.push([
        s.ts, datetime,
        s.soil_moisture_pct,
        s.air_temp_c, s.air_humidity_pct, s.lux,
      ].join(','));
    }
    const csv = rows.join('\n') + '\n';

    // Declanşăm download-ul prin Blob + link sintetic.
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `dropwise_${lastHistoryNodeName}_${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function closeGraphView() {
    // Înlocuim hash-ul cu #monitor (replaceState — fără entry nou) ca
    // butonul "Înapoi la monitor" să se comporte predictibil: revine
    // mereu la lista de carduri, indiferent de istoricul anterior
    // (e.g. dacă utilizatorul venise pe Monitor dintr-un alt tab,
    // history.back() ar fi sărit înapoi la acel tab).
    if (window.location.hash !== '#monitor') {
      history.replaceState(null, '', '#monitor');
    }
    doCloseGraphView();
  }

  /** Închidere efectivă, fără să mai umblăm la istoricul browserului. */
  function doCloseGraphView() {
    const main = document.getElementById('monitor-main');
    const view = document.getElementById('node-graph');
    if (!main || !view) return;
    view.hidden = true;
    main.hidden = false;
    activeCharts.forEach((c) => c.destroy());
    activeCharts = [];
    nodes.startMonitorPolling && nodes.startMonitorPolling();
  }

  /** Variantă "silent" — apelată când părăseşti tab-ul Monitor. NU
      modifică hash-ul (dashboard.js îl gestionează deja la tab switch). */
  nodes.closeGraphViewIfOpen = function () {
    const view = document.getElementById('node-graph');
    if (!view || view.hidden) return;
    doCloseGraphView();
  };

  nodes.initGrid = function () {
    // Click în afara unui meniu ⋯ => îl închidem.
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('.node-card__menu')) closeAllNodeMenus();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeAllNodeMenus();
    });

    // Buton "Vezi diagnostica" pe cardul hub din Monitor.
    const diagBtn = document.getElementById('btn-diagnostics');
    if (diagBtn) {
      diagBtn.addEventListener('click', openDiagnosticsDialog);
    }

    // Buton "← Înapoi la monitor" în pagina Grafic.
    const graphClose = document.getElementById('graph-close');
    if (graphClose) {
      graphClose.addEventListener('click', closeGraphView);
    }

    // Buton "Descarcă CSV" în header-ul paginii Grafic.
    const csvBtn = document.getElementById('graph-download-csv');
    if (csvBtn) {
      csvBtn.addEventListener('click', downloadHistoryCsv);
    }
  };
})();

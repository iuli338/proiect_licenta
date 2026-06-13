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

  // ---------- Istoric noduri conectate anterior ----------
  //
  // Păstrăm în localStorage o "amintire" a fiecărui nod care a fost
  // configurat şi activ. Când nodul dispare din lista activă (deconectat
  // fizic sau forget), card-ul rămâne vizibil într-o secţiune separată
  // marcată "Noduri conectate anterior". La reconectare, nodul iese din
  // istoric (lista activă are prioritate).
  //
  // Schema în localStorage:
  //   key   = "dropwise.nodes.history"
  //   value = {
  //     "P1": { name, port, config: {plant, soil, color, ...}, lastSeen }
  //   }

  const HISTORY_KEY = 'dropwise.nodes.history';

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (_) { return {}; }
  }
  function saveHistory(h) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch (_) {}
  }

  // Cache în RAM cu ultimul snapshot per nume nod CÂT TIMP era activ.
  // Folosit la tranzitia activ → dispare: îl mutăm în localStorage cu
  // configul lui ultim. Nu salvăm direct la fiecare polling în
  // localStorage ca să nu lovim disk-ul de 10 ori/secundă.
  const lastActiveSnapshot = {};   // { "P1": {name, port, config, lastSeen} }

  /** Adăugă un snapshot pentru un nod ACTIV (configurat + confirmat). Şi
      îl scoatem din istoric, fiindcă acum e online. */
  function rememberActiveNode(port) {
    if (!port.name || !port.configured || !port.config) return;
    lastActiveSnapshot[port.name] = {
      name: port.name,
      port: port.port,
      config: port.config,
      lastSeen: Date.now(),
    };
    // Iese din istoric — un nod activ NU apare în "Conectate anterior".
    const h = loadHistory();
    if (h[port.name]) {
      delete h[port.name];
      saveHistory(h);
    }
  }

  /** Mută în istoric un nod care a dispărut din lista activă. Apelat
      pentru fiecare nume care era în lastActiveSnapshot dar nu mai
      figurează în lista de porturi confirmate. */
  function archiveDisappeared(activeNames) {
    let changed = false;
    const h = loadHistory();
    for (const name of Object.keys(lastActiveSnapshot)) {
      if (!activeNames.has(name)) {
        h[name] = lastActiveSnapshot[name];
        delete lastActiveSnapshot[name];
        changed = true;
      }
    }
    if (changed) saveHistory(h);
  }

  /** Elimină un nod din istoric — chemat de butonul "Şterge din istoric". */
  function removeFromHistory(nodeName) {
    const h = loadHistory();
    if (h[nodeName]) {
      delete h[nodeName];
      saveHistory(h);
      return true;
    }
    return false;
  }

  // ---------- Buffer LIVE pentru pagina Grafice ----------
  //
  // Schema: { "P1": { samples: [...], lastPushedAt: 0 } }
  // Fiecare sample = { ts, soil_moisture_pct, air_temp_c, air_humidity_pct, lux }
  //
  // Push pe ritm FIX de LIVE_UPDATE_PERIOD_MS — la fiecare poll verificăm
  // dacă a trecut perioada de la ultimul push pentru nodul respectiv.
  // Dacă da, adăugăm valorile curente din `sensors`. Predictibil, simplu,
  // ritm uniform pe axa X indiferent de age_ms-ul SENSE de la firmware.
  const LIVE_UPDATE_PERIOD_MS = 5000;        // push la 5 secunde
  const LIVE_WINDOW_MS        = 5 * 60 * 1000;  // 5 minute rolling
  const liveBuffers = {};                     // per nume nod
  function liveBufferFor(name) {
    if (!liveBuffers[name]) liveBuffers[name] = { samples: [], lastPushedAt: 0 };
    return liveBuffers[name];
  }
  nodes.getLiveBuffer = liveBufferFor;

  /** Push o nouă măsurătoare în buffer-ul live pentru un nod.
      Apelat din pollMonitor. Returnează true dacă s-a adăugat (a trecut
      perioada de update de la ultimul push), false altfel. */
  function pushLiveSample(port) {
    if (!port || !port.name || !port.sensors) return false;
    const buf = liveBufferFor(port.name);
    const now = Date.now();
    if (now - buf.lastPushedAt < LIVE_UPDATE_PERIOD_MS) {
      return false;   // n-a trecut încă perioada — sărim
    }
    buf.lastPushedAt = now;
    const s = port.sensors;
    buf.samples.push({
      ts: now,
      soil_moisture_pct: s.soil_moisture_pct,
      air_temp_c: s.air_temp_c,
      air_humidity_pct: s.air_humidity_pct,
      lux: s.lux,
    });
    // Curăţăm punctele mai vechi de fereastra rolling.
    const cutoff = now - LIVE_WINDOW_MS;
    while (buf.samples.length > 0 && buf.samples[0].ts < cutoff) {
      buf.samples.shift();
    }
    return true;
  }

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

      // Buffer live (5 min rolling) pentru pagina Grafice — populat
      // doar când senzorii trimit valori NOI (age_ms scade).
      let anyLivePush = false;
      (j.data.ports || []).forEach((p) => {
        if (pushLiveSample(p)) anyLivePush = true;
      });
      if (anyLivePush && nodes.refreshLiveGraph) {
        nodes.refreshLiveGraph();   // dacă graficul live e deschis, redraw
      }

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
    // Cât timp un sub-view e deschis (wizard, statistici, parametri,
    // loader/eroare de reconfigurare), grila + istoricul rămân ascunse —
    // sărim peste poll ca să evităm race-condition (renderEm grila peste
    // un loader şi apoi se ascunde din nou → flicker).
    if (!el.wizard.hidden || !el.nodeStats.hidden) return;
    if (el.nodeParams && !el.nodeParams.hidden) return;
    const reconfigLoader = document.getElementById('reconfig-loader');
    if (reconfigLoader && !reconfigLoader.hidden) return;
    const reconfigError = document.getElementById('reconfig-error');
    if (reconfigError && !reconfigError.hidden) return;
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

    // ---- Istoric (DOAR pe grila Noduri, nu pe Monitor) ----
    // Memorăm/expirăm starea istoricului pe baza listei active. Apoi
    // randăm secţiunea "Noduri conectate anterior".
    if (grid === nodes.el.nodesGrid) {
      const activeNames = new Set();
      ports.forEach((p) => {
        if (p.confirmed && p.configured && p.config) {
          activeNames.add(p.name);
          rememberActiveNode(p);
        }
      });
      archiveDisappeared(activeNames);
      renderHistory();
    }
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
      const auto = card.querySelector('.node-card__auto');
      if (auto) { auto.hidden = true; delete auto.dataset.snap; }
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
      const auto2 = card.querySelector('.node-card__auto');
      if (auto2) { auto2.hidden = true; delete auto2.dataset.snap; }
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
            <button type="button" class="node-card__menu-item" role="menuitem"
                    data-action="auto-off" hidden>
              <svg class="node-card__menu-icon" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <circle cx="12" cy="12" r="9"/>
                <line x1="5" y1="5" x2="19" y2="19"/>
              </svg>
              <span>Dezactivează udare auto</span>
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
      <div class="node-card__auto" hidden>
        <!-- conţinut populat dinamic din updateAutoWateringBlock() -->
      </div>
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
    menu.querySelector('[data-action="auto-off"]')
      .addEventListener('click', () => {
        menuList.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        if (card.dataset.node) {
          toggleAutoWatering(card.dataset.node, false);
        }
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
      const autoBox = card.querySelector('.node-card__auto');
      if (!onMonitor) {
        sens.hidden = true;
        if (graphBtn) graphBtn.hidden = true;
        if (autoBox) autoBox.hidden = true;
      } else {
        renderSensors(sens, port.sensors, port.config);
        if (graphBtn) graphBtn.hidden = false;
        // Block "Următoarea udare" — apare doar pe Monitor pentru noduri
        // configurate (atât ON cât şi OFF — fiecare cu UI-ul lui propriu).
        if (autoBox) updateAutoWateringBlock(autoBox, port);
      }
      // Vizibilitatea opţiunii "Dezactivează udare auto" în meniul ⋯
      // se actualizează indiferent de tab (Monitor sau Noduri).
      updateMenuAutoOption(card, port);
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
        const auto3 = card.querySelector('.node-card__auto');
        if (auto3) auto3.hidden = true;
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
    // Marcăm placeholder-ul generic (planta custom) ca să-l putem reda gri
    // pe tema light — vezi .node-card__img--placeholder în nodes.css.
    img.classList.toggle('node-card__img--placeholder', plantId === 'custom');
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

  // ---------- Auto-watering: block pe card + acţiuni ----------
  //
  // Pentru noduri configurate, randăm în zona dedicată informaţii despre
  // udarea automată:
  //   • OFF (default) → text + buton "Activează" mare
  //   • ON            → predicţia "Următoarea udare" + ultima udare
  //                      (dezactivarea se face DOAR din meniul ⋯)
  // Datele de predicţie (next_watering) vin de la backend (mock sau hub).

  /** Format prietenos pentru un interval de minute.
      Ex: 240 → "4 h", 1500 → "1 zi 1 h", 30 → "30 min". */
  function formatTimeUntil(minutes) {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return m + ' min';
    if (m < 24 * 60) {
      const h = m / 60;
      return (h === Math.round(h) ? h : h.toFixed(1)) + ' h';
    }
    const days  = Math.floor(m / (24 * 60));
    const rem_h = Math.round((m - days * 24 * 60) / 60);
    if (rem_h === 0 || rem_h === 24) {
      const d = days + (rem_h === 24 ? 1 : 0);
      return d + (d === 1 ? ' zi' : ' zile');
    }
    return days + (days === 1 ? ' zi ' : ' zile ') + rem_h + ' h';
  }

  /** Format pentru "acum X" — timp scurs. */
  function formatTimeAgo(minutes) {
    if (minutes == null || minutes < 0) return null;
    const m = Math.round(minutes);
    if (m < 1) return 'chiar acum';
    if (m < 60) return 'acum ' + m + ' min';
    if (m < 24 * 60) {
      const h = Math.round(m / 60);
      return 'acum ' + h + ' h';
    }
    const days = Math.round(m / (24 * 60));
    return 'acum ' + days + (days === 1 ? ' zi' : ' zile');
  }

  /** Construieşte conţinutul block-ului auto-watering pe baza stării
      curente a portului (config + next_watering + stats). */
  function updateAutoWateringBlock(box, port) {
    const cfg = port.config || {};
    const reg = cfg.regulator || {};
    const enabled = !!reg.auto_watering_enabled;
    const next = port.next_watering;

    // Snapshot pentru a evita re-render-ul când nimic nu s-a schimbat.
    const snap = JSON.stringify({
      en: enabled,
      nw: next,
      ls: port.stats && port.stats.last_watering,
    });
    if (box.dataset.snap === snap) return;
    box.dataset.snap = snap;

    box.hidden = false;

    if (!enabled) {
      // === OFF ===
      box.innerHTML =
        '<div class="node-card__auto-off">' +
          '<p class="node-card__auto-text">' +
            'Udarea automată este dezactivată.' +
          '</p>' +
          '<button type="button" class="btn btn--primary node-card__auto-on">' +
            'Activează' +
          '</button>' +
        '</div>';
      box.querySelector('.node-card__auto-on')
        .addEventListener('click', () => toggleAutoWatering(port.name, true));
      return;
    }

    // === ON ===
    let html = '<div class="node-card__auto-on-box">';
    // Următoarea udare
    if (next && next.minutes_until != null) {
      html += '<div class="node-card__auto-row">' +
        '<span class="node-card__auto-label">Următoarea udare</span>' +
        '<span class="node-card__auto-value">în ~' +
          formatTimeUntil(next.minutes_until) +
          (next.estimated_dose_ml
            ? ' · ~' + next.estimated_dose_ml + ' ml'
            : '') +
        '</span></div>';
    } else {
      html += '<div class="node-card__auto-row">' +
        '<span class="node-card__auto-label">Următoarea udare</span>' +
        '<span class="node-card__auto-value node-card__auto-value--muted">' +
          'predicţie indisponibilă</span></div>';
    }

    // Ultima udare — din stats dacă există
    const stats = port.stats || {};
    const lastEpoch = Number(stats.last_watering) || 0;
    if (lastEpoch > 0) {
      const nowS = Math.floor(Date.now() / 1000);
      const agoMin = (nowS - lastEpoch) / 60;
      const agoTxt = formatTimeAgo(agoMin) || '—';
      const lastDose = stats.last_dose_ml || 0;
      html += '<div class="node-card__auto-row node-card__auto-row--sub">' +
        '<span class="node-card__auto-label">Ultima udare</span>' +
        '<span class="node-card__auto-value">' + agoTxt +
          (lastDose ? ' (' + lastDose + ' ml)' : '') +
        '</span></div>';
    }
    html += '</div>';
    box.innerHTML = html;
  }

  /** Apel API pentru activare/dezactivare. */
  async function toggleAutoWatering(nodeName, enabled) {
    try {
      await nodes.getJSON(
        '/api/node/' + encodeURIComponent(nodeName) + '/auto-watering',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !!enabled }),
        });
      // După succes, forţăm un poll imediat ca să refacem UI-ul.
      if (nodes.pollMonitor) nodes.pollMonitor();
      if (nodes.pollNodesGrid) nodes.pollNodesGrid();
      // Toast de feedback — confirmare vizuală că schimbarea a fost
      // aplicată pe hub (sau în state-ul mock).
      showResetToast(
        enabled
          ? `Udarea automată a fost activată pentru ${nodeName}.`
          : `Udarea automată a fost dezactivată pentru ${nodeName}.`,
        'ok');
    } catch (e) {
      showResetToast(
        'Nu am putut schimba udarea automată: ' + (e.message || e),
        'error');
    }
  }
  nodes.toggleAutoWatering = toggleAutoWatering;

  /** Actualizează vizibilitatea opţiunii "Dezactivează udare auto" din
      meniul ⋯. Apare DOAR dacă auto e activ; ascunsă altfel. */
  function updateMenuAutoOption(card, port) {
    const item = card.querySelector('[data-action="auto-off"]');
    if (!item) return;
    const enabled = !!(port.config && port.config.regulator &&
                       port.config.regulator.auto_watering_enabled);
    item.hidden = !enabled;
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

  // Citeşte o variabilă CSS de temă (ex: '--chart-tick') de pe <html>.
  // Graficele Chart.js sunt pe canvas, nu moştenesc CSS-ul, aşa că le citim
  // explicit la randare şi reconstruim graficele la schimbarea temei.
  function themeColor(varName, fallback) {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(varName).trim();
    return v || fallback;
  }

  // Config per metrică: unitate + variabila CSS pentru culoarea liniei.
  // Culoarea efectivă se rezolvă la randare prin themeColor() ca să urmeze tema.
  const GRAPH_METRICS = {
    soil_moisture_pct: { unit: '%',  colorVar: '--chart-soil' },
    lux:               { unit: 'lx', colorVar: '--chart-lux' },
    air_temp_c:        { unit: '°C', colorVar: '--chart-temp' },
    air_humidity_pct:  { unit: '%',  colorVar: '--chart-humidity' },
  };

  /** Transformă o culoare 'rgba(r,g,b,1)' în varianta cu alpha dat (pt. fill). */
  function withAlpha(rgba, alpha) {
    return rgba.replace(/rgba?\(([^)]+)\)/, function (_, inner) {
      const parts = inner.split(',').map((s) => s.trim());
      return 'rgba(' + parts[0] + ',' + parts[1] + ',' + parts[2] + ',' + alpha + ')';
    });
  }

  // ---------- Mod istoric vs. live pe pagina Grafice ----------
  //
  // Toggle-ul din header schimbă fereastra de timp:
  //   - "history": 24 ore din /api/node/<P>/history, slot-uri orare
  //   - "live": 5 minute rolling din liveBuffers (push în pollMonitor)
  //
  // currentGraphCtx ţine cache-ul ne-static (nodeName, chartLib, nodeCfg,
  // samples istorice) ca să nu refacem fetch la swap.
  let currentGraphMode = 'history';
  let currentGraphCtx  = null;       // { nodeName, chartLib, nodeCfg, samples }

  /** Construieşte (labels, byMetric) pentru un mod dat. */
  function buildGraphSeries(mode, historySamples) {
    if (mode === 'live') {
      const buf = currentGraphCtx ? liveBufferFor(currentGraphCtx.nodeName) : null;
      const samples = (buf && buf.samples) || [];
      // Etichete = mm:ss faţă de momentul curent (axa X scrolluieşte).
      const labels = samples.map((s) => {
        const d = new Date(s.ts);
        return d.getMinutes().toString().padStart(2, '0') + ':' +
               d.getSeconds().toString().padStart(2, '0');
      });
      const metrics = ['soil_moisture_pct', 'air_temp_c',
                       'air_humidity_pct', 'lux'];
      const byMetric = {};
      metrics.forEach((m) => {
        byMetric[m] = samples.map((s) => (s[m] == null ? null : Number(s[m])));
      });
      return { labels, byMetric };
    }
    // === ISTORIC === (logica veche, 24 slot-uri orare)
    const HOURS = 24;
    const now = Date.now();
    const nowHour = new Date(now);
    nowHour.setMinutes(0, 0, 0);
    const labels = [];
    const slotEpochs = [];
    for (let i = 0; i < HOURS; i++) {
      const d = new Date(nowHour.getTime() - (HOURS - 1 - i) * 3600 * 1000);
      labels.push(d.getHours().toString().padStart(2, '0') + ':00');
      slotEpochs.push(Math.floor(d.getTime() / 1000));
    }
    const sampleByHour = {};
    for (const s of (historySamples || [])) {
      const h = Math.floor(s.ts / 3600) * 3600;
      sampleByHour[h] = s;
    }
    const metrics = ['soil_moisture_pct', 'air_temp_c',
                     'air_humidity_pct', 'lux'];
    const byMetric = {};
    metrics.forEach((m) => {
      byMetric[m] = slotEpochs.map((h) => {
        const s = sampleByHour[h];
        return s ? s[m] : null;
      });
    });
    return { labels, byMetric };
  }

  /** Re-randează datele în graficele Chart.js deja construite, fără a le
      distruge (păstrează scale + tooltip-uri). Apelat la swap mod sau la
      push de nou sample live. */
  function refreshGraphData(mode) {
    if (!currentGraphCtx || activeCharts.length === 0) return;
    const built = buildGraphSeries(mode,
      mode === 'history' ? currentGraphCtx.samples : null);
    document.querySelectorAll('#node-graph .graph-card__canvas')
      .forEach((canvas, idx) => {
        const metric = canvas.dataset.metric;
        const chart = activeCharts[idx];
        if (!chart || !metric) return;
        chart.data.labels = built.labels;
        // Dataset[0] = datele principale. Restul sunt linii de referinţă
        // care nu depind de mod — refacem doar lungimea (la istoric=24,
        // la live=N puncte).
        if (chart.data.datasets[0]) {
          chart.data.datasets[0].data = built.byMetric[metric] || [];
        }
        for (let i = 1; i < chart.data.datasets.length; i++) {
          const ds = chart.data.datasets[i];
          if (ds && Array.isArray(ds.data)) {
            // Linii de referinţă cu valoare constantă — refacem lungimea.
            const v = ds.data[0];
            ds.data = new Array(built.labels.length).fill(v);
          }
        }
        chart.update('none');   // fără animaţie ca să fie smooth pe push
      });
  }

  /** Apelată din pollMonitor după ce a fost adăugat un sample live nou,
      dar doar dacă suntem în mod LIVE pe pagina Grafice. */
  nodes.refreshLiveGraph = function () {
    const view = document.getElementById('node-graph');
    if (!view || view.hidden) return;
    if (currentGraphMode !== 'live') return;
    refreshGraphData('live');
  };

  /** Setează modul activ + actualizează butoanele + reîncarcă datele. */
  function setGraphMode(mode) {
    if (mode !== 'live' && mode !== 'history') return;
    currentGraphMode = mode;
    document.querySelectorAll('.graph-toggle__btn').forEach((b) => {
      const pressed = b.dataset.mode === mode;
      b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
    // Labelul ferestrei de timp în header.
    const lbl = document.getElementById('graph-window-label');
    if (lbl) lbl.textContent = '· ' + (mode === 'live' ? '5 minute (live)' : '24 ore');
    refreshGraphData(mode);
  }

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
    // NU oprim pollMonitor — bufferul live (5 min rolling) e populat
    // din polling-ul de Monitor; dacă oprim, modul Live nu mai primeşte
    // sample-uri noi. Polling-ul rulează în background, costul e mic
    // (un singur GET la 1.5s); când eşti pe pagina grafic vede oricum
    // nimic în mod Istoric, doar populează buffer live.

    // Afişăm card-ul de loading în locul graficelor + butonului CSV cât
    // timp aşteptăm Chart.js + datele de la hub. Pe live, fetch-ul către
    // hub poate dura câteva secunde (ESP-NOW + EEPROM read).
    setGraphLoading(true);

    // Curăţăm graficele anterioare (dacă se redeschide pagina).
    activeCharts.forEach((c) => c.destroy());
    activeCharts = [];

    // Încărcăm Chart.js (CDN) + config nod — obligatorii. Istoricul e
    // OPŢIONAL: dacă endpoint-ul /history nu există pe firmware (404)
    // sau dă alt eroare, mergem cu samples=[] şi pagina rămâne funcţională
    // — modul Live foloseşte oricum bufferul rolling din pollMonitor.
    // Atenţie: NU folosi `history` ca nume local — face shadow pe
    // window.history şi rupe `history.replaceState` apelat mai sus
    // (temporal dead zone). Folosim `historyData`.
    let chartLib, nodeCfg;
    try {
      [chartLib, nodeCfg] = await Promise.all([
        loadChartJs(),
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
    let historyData = { samples: [] };
    try {
      historyData = await nodes.getJSON(
        '/api/node/' + encodeURIComponent(nodeName) + '/history');
    } catch (e) {
      // Endpoint-ul lipseşte pe firmware sau hub-ul nu răspunde.
      // Lăsăm samples=[] — utilizatorul poate folosi modul Live oricum.
      console.warn('History fetch failed:', e.message);
    }

    const samples = historyData.samples || [];
    lastHistorySamples = samples;
    lastHistoryNodeName = nodeName;
    // Stocăm contextul ca să refacem graficele la swap istoric ↔ live
    // fără re-fetch.
    currentGraphCtx = { nodeName: nodeName, chartLib, nodeCfg, samples };

    // Construim graficele pentru modul curent. Extras într-o funcţie ca să
    // poată fi reapelat la schimbarea temei (reconstruim cu noile culori,
    // fără re-fetch — folosim currentGraphCtx deja populat).
    renderChartsFromCtx();
    setGraphLoading(false);
    graphViewOpening = false;
  }

  /** (Re)construieşte graficele Chart.js din currentGraphCtx, pentru modul
      curent (istoric/live) şi tema activă. Distruge graficele existente.
      Apelat la deschiderea paginii şi la schimbarea temei. */
  function renderChartsFromCtx() {
    const view = document.getElementById('node-graph');
    if (!view || !currentGraphCtx || !currentGraphCtx.chartLib) return;
    const chartLib = currentGraphCtx.chartLib;
    const nodeCfg  = currentGraphCtx.nodeCfg;

    // Curăţăm graficele anterioare înainte de a reconstrui.
    activeCharts.forEach((c) => c.destroy());
    activeCharts = [];

    const built = buildGraphSeries(currentGraphMode,
      currentGraphMode === 'history' ? currentGraphCtx.samples : null);
    const labels = built.labels;

    function alignedData(metricKey) { return built.byMetric[metricKey] || []; }

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
      const lineColor = themeColor(cfg.colorVar, 'rgba(184,240,201,1)');
      const datasets = [{
        label: metric === 'lux' ? 'Lux'
             : metric === 'soil_moisture_pct' ? 'Umiditate sol'
             : '',
        data: data,
        borderColor: lineColor,
        backgroundColor: withAlpha(lineColor, '0.15'),
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
          themeColor('--chart-ref', 'rgba(255,255,255,0.6)')));
      }
      // Pentru lux, liniile Min/Max sunt adăugate ÎNTOTDEAUNA dar
      // `hidden: true` iniţial — utilizatorul le activează din legendă
      // (click pe label "Minim" / "Maxim" → linia apare).
      if (metric === 'lux') {
        if (luxMin != null) {
          const ds = referenceLine(
            'Minim (' + luxMin + ' lx)',
            luxMin,
            themeColor('--color-danger-soft', 'rgba(255,138,138,0.7)'));
          ds.hidden = true;
          datasets.push(ds);
        }
        if (luxMax != null) {
          const ds = referenceLine(
            'Maxim (' + luxMax + ' lx)',
            luxMax,
            themeColor('--color-danger-soft', 'rgba(255,138,138,0.7)'));
          ds.hidden = true;
          datasets.push(ds);
        }
      }

      // Avem legendă dacă există cel puţin o linie de referinţă (oricare).
      const hasRefLines = datasets.length > 1;

      // Culori de temă pentru axe / grilă / legendă / tooltip — rezolvate la
      // randare. Graficele se reconstruiesc la schimbarea temei (vezi mai jos).
      const cTick    = themeColor('--chart-tick', 'rgba(255,255,255,0.5)');
      const cGrid    = themeColor('--chart-grid', 'rgba(255,255,255,0.05)');
      const cLegend  = themeColor('--chart-legend', 'rgba(255,255,255,0.7)');
      const cTipBg   = themeColor('--chart-tooltip-bg', 'rgba(13,31,23,0.95)');
      const cTipBord = themeColor('--chart-tooltip-border', 'rgba(255,255,255,0.1)');

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
                    color: cLegend,
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
              backgroundColor: cTipBg,
              borderColor: cTipBord,
              titleColor: cLegend,
              bodyColor: cLegend,
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
              ticks: { color: cTick, font: { size: 10 }, maxRotation: 0 },
              grid:  { color: cGrid },
            },
            y: {
              ticks: {
                color: cTick, font: { size: 10 },
                callback: (v) => v + ' ' + cfg.unit,
              },
              grid:  { color: cGrid },
            },
          },
        },
      });
      activeCharts.push(c);
    });
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

  /** Generează CSV cu sample-urile din modul curent (istoric sau live) şi
      declanşează download în browser. Pentru istoric, ts e în secunde
      (epoch UNIX); pentru live, ts e în milisecunde (Date.now()). */
  function downloadHistoryCsv() {
    // Sursa datelor + scala timestamp-ului depind de modul curent.
    let samples = [];
    let tsMultiplier = 1000;   // pentru new Date(): istoric ts*1000, live ts*1
    let modeSuffix = 'history';
    if (currentGraphMode === 'live' && currentGraphCtx) {
      const buf = liveBufferFor(currentGraphCtx.nodeName);
      samples = (buf && buf.samples) || [];
      tsMultiplier = 1;
      modeSuffix = 'live';
    } else {
      samples = lastHistorySamples || [];
      tsMultiplier = 1000;
    }
    if (!samples.length) return;

    const header = [
      'timestamp', 'datetime',
      'soil_moisture_pct',
      'air_temp_c', 'air_humidity_pct', 'lux',
    ];
    const rows = [header.join(',')];
    for (const s of samples) {
      const d = new Date(s.ts * tsMultiplier);
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

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);
    const nodeName = (currentGraphCtx && currentGraphCtx.nodeName)
                     || lastHistoryNodeName;
    a.href = url;
    a.download = `dropwise_${nodeName}_${modeSuffix}_${today}.csv`;
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
    currentGraphCtx = null;
    currentGraphMode = 'history';   // default la următoarea deschidere
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

    // Resize fereastră: re-aliniem lăţimea card-urilor istoric cu cele
    // active. Throttle simplu via timeout.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (nodes.syncHistoryCardWidth) nodes.syncHistoryCardWidth();
      }, 120);
    });

    // Schimbarea temei (light/dark): graficele sunt pe canvas şi nu moştenesc
    // CSS-ul, deci le reconstruim cu noile culori dacă pagina Grafice e deschisă.
    window.addEventListener('dropwise:theme-changed', () => {
      const view = document.getElementById('node-graph');
      if (view && !view.hidden && currentGraphCtx) {
        renderChartsFromCtx();
      }
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

    // Toggle Istoric ↔ Live în header-ul paginii Grafic.
    document.querySelectorAll('.graph-toggle__btn').forEach((b) => {
      b.addEventListener('click', () => setGraphMode(b.dataset.mode));
    });
  };

  // ---------- Randare secţiune istoric ----------
  //
  // Apelată după renderNodeGrid (doar pe grila Noduri). Construieşte
  // carduri "dim" cu doar informaţiile salvate în localStorage.

  /** Construieşte un card simplu pentru un nod arhivat. Meniu redus la
      doar "Şterge din istoric". */
  function buildHistoryCard(entry) {
    const card = document.createElement('article');
    card.className = 'node-card node-card--history';
    card.dataset.node = entry.name;
    card.dataset.port = String(entry.port || '');

    const cfg = entry.config || {};
    const plant = cfg.plant || {};
    const soil  = cfg.soil  || {};
    const portTxt = entry.port ? ('Port ' + entry.port + '  ·  ') : '';

    card.innerHTML = `
      <div class="node-card__head">
        <h3 class="node-card__title">${portTxt}${escapeHtml(entry.name)}</h3>
        <div class="node-card__menu">
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
            <button type="button"
                    class="node-card__menu-item node-card__menu-item--danger"
                    role="menuitem" data-action="history-remove">
              <svg class="node-card__menu-icon" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6 l -1 14 a 2 2 0 0 1 -2 2 H 8 a 2 2 0 0 1 -2 -2 L 5 6"/>
                <path d="M10 11 v 6 M 14 11 v 6"/>
              </svg>
              <span>Şterge din istoric</span>
            </button>
          </div>
        </div>
      </div>
      <div class="node-card__media">
        <img class="node-card__img" alt="" />
      </div>
      <p class="node-card__plant">${escapeHtml(plant.name || '—')}</p>
      <p class="node-card__soil">${escapeHtml(soil.name || '')}</p>
    `;

    // Imagine plantă (poate lipsi dacă e custom).
    const img = card.querySelector('.node-card__img');
    if (plant.id) setPlantImage(img, plant.id, plant.name);
    else img.hidden = true;

    // Culoare card.
    if (cfg.color) applyCardColor(card, cfg.color);

    // Meniul ⋯
    const menuBtn  = card.querySelector('.node-card__menu-btn');
    const menuList = card.querySelector('.node-card__menu-list');
    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = menuList.hidden;
      closeAllNodeMenus();
      menuList.hidden = !open;
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // Acţiune unică: şterge nodul din istoric şi reîmprospătează grila.
    card.querySelector('[data-action="history-remove"]')
      .addEventListener('click', () => {
        menuList.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        if (removeFromHistory(entry.name)) {
          renderHistory();
        }
      });

    return card;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /** Re-randează secţiunea "Noduri conectate anterior" pe baza
      localStorage-ului. Apelată după fiecare renderNodeGrid pe grila
      Noduri + manual din butonul de ştergere.

      Diffing pe snapshot: dacă set-ul de noduri din istoric nu s-a
      schimbat (acelaşi nume + config + lastSeen), nu reconstruim DOM-ul.
      Asta evită "palpâirea" cauzată de polling-ul de la 1.5s care chema
      renderHistory de fiecare dată. */
  function renderHistory() {
    const section = nodes.el.nodesHistorySection;
    const grid = nodes.el.nodesHistoryGrid;
    if (!section || !grid) return;

    const h = loadHistory();
    const entries = Object.values(h).sort(
      (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

    // Snapshot-ul cuprinde doar identificatori (nu lastSeen, care creşte
    // la fiecare polling — ne-ar invalida snapshot-ul mereu).
    const snap = entries.map((e) => {
      const p = (e.config && e.config.plant && e.config.plant.id) || '';
      const s = (e.config && e.config.soil  && e.config.soil.id)  || '';
      const c = (e.config && e.config.color) || '';
      return e.name + ':' + p + ':' + s + ':' + c;
    }).join('|');

    if (entries.length === 0) {
      if (grid.dataset.snap !== '') {
        section.hidden = true;
        grid.innerHTML = '';
        grid.dataset.snap = '';
      }
      return;
    }

    section.hidden = false;
    if (grid.dataset.snap === snap) return;   // nimic nu s-a schimbat
    grid.dataset.snap = snap;

    grid.innerHTML = '';
    for (const entry of entries) {
      grid.appendChild(buildHistoryCard(entry));
    }

    // Aliniază lăţimea cu un card din grila activă de sus, ca să arate
    // identic. Măsurăm prima coloană din #nodes-grid (cea mai apropiată
    // grilă vizibilă) şi propagăm prin variabila CSS --history-card-width.
    syncHistoryCardWidth();
  }
  nodes.renderNodesHistory = renderHistory;

  /** Sincronizează lăţimea card-urilor din istoric cu cele din grila
      activă (de deasupra). Apelată după render + observă LIVE prin
      ResizeObserver — orice schimbare de lăţime a unui card de sus
      propagă imediat la grila istoric. */
  let historyResizeObserver = null;
  function syncHistoryCardWidth() {
    const grid = nodes.el.nodesHistoryGrid;
    if (!grid) return;
    const sample = (nodes.el.nodesGrid
                     && nodes.el.nodesGrid.querySelector('.node-card'))
                || (nodes.el.nodeGrid
                     && nodes.el.nodeGrid.querySelector('.node-card'));
    if (!sample) {
      // Nu există card de sus — folosim fallback rezonabil (variabila
      // CSS are deja default 360px).
      return;
    }
    const apply = () => {
      const w = Math.round(sample.getBoundingClientRect().width);
      if (w > 0) grid.style.setProperty('--history-card-width', w + 'px');
    };
    apply();
    // Observer LIVE: orice resize al card-ului-sample setează lăţimea.
    // Asta acoperă: schimbare viewport, redraw după animaţii, schimbarea
    // numărului de carduri active care realocă coloanele etc.
    if (historyResizeObserver) {
      historyResizeObserver.disconnect();
    }
    if (typeof ResizeObserver !== 'undefined') {
      historyResizeObserver = new ResizeObserver(apply);
      historyResizeObserver.observe(sample);
    }
  }
  nodes.syncHistoryCardWidth = syncHistoryCardWidth;
})();

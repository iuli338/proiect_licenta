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

  nodes.pollMonitor = async function () {
    const el = nodes.el;
    // Fără cod / fără hub provizionat — nu interogăm (am primi doar 404).
    if (!canPoll()) {
      setHubCard('pending', null);
      el.nodeGrid.innerHTML = '';
      return;
    }
    try {
      const j = await getJSON('/api/hub/status', { cache: 'no-store' });
      if (!j.online || !j.data) {
        setHubCard('offline', null);
        el.nodeGrid.innerHTML = '';
        return;
      }
      setHubCard('online', j.data);
      renderNodeGrid(j.data.ports || [], el.nodeGrid);
    } catch (e) {
      setHubCard('offline', null);
      el.nodeGrid.innerHTML = '';
    }
  };

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

    if (state === 'online') {
      stateEl.textContent = 'Hub online';
      detail.textContent = 'Hub-ul răspunde — datele sunt actualizate.';
      ipEl.textContent = (data && data.ip) || '—';
      chEl.textContent = (data && data.channel != null)
        ? String(data.channel) : '—';
    } else if (state === 'offline') {
      stateEl.textContent = 'Hub-ul nu răspunde';
      detail.textContent = 'Verifică alimentarea şi conexiunea la reţea.';
      ipEl.textContent = '—';
      chEl.textContent = '—';
    } else {
      stateEl.textContent = 'Hub neconectat';
      detail.textContent = 'Introdu codul de acces pentru a vedea starea.';
      ipEl.textContent = '—';
      chEl.textContent = '—';
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
                    data-action="stats">Vezi statistici</button>
            <button type="button" class="node-card__menu-item" role="menuitem"
                    data-action="reconfigure">Reconfigurează</button>
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
      // Datele de senzori — afişate DOAR pe grila Monitor, nu pe Noduri.
      const onMonitor = !!card.closest('#node-grid');
      if (!onMonitor) {
        sens.hidden = true;
      } else if (!sens.dataset.filled) {
        // TODO(live): randare valori reale de senzori de la nod.
        sens.innerHTML = port.sensors
          ? ''
          : '<span class="node-card__todo">Date senzori — în curând</span>';
        sens.dataset.filled = '1';
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

  // ---------- Init modul ----------

  nodes.initGrid = function () {
    // Click în afara unui meniu ⋯ => îl închidem.
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('.node-card__menu')) closeAllNodeMenus();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeAllNodeMenus();
    });
  };
})();

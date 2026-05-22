/* ============================================================
   Dropwise — Monitorizare noduri + wizard de configurare
   ============================================================

   Două zone, în taburi diferite, dar strâns legate:
     - Monitor (tab "monitor"): carduri pentru fiecare nod, cu stare
       configurat / neconfigurat. Butonul "Configurează" redirecţionează
       la tabul "noduri" şi preselectează nodul.
     - Wizard (tab "noduri"): paşi plantă -> sol -> sumar -> culoare ->
       trimitere -> confirmare.

   Identitatea nodului = NUMELE lui (P1/P2/P3). Configuraţia urmează nodul,
   nu portul. În mod test totul e mock pe server (DROPWISE_HUB_MODE=mock).
   ============================================================ */

(function () {
  'use strict';

  const MONITOR_POLL_MS = 1500;

  // Cataloagele (plante/soluri/culori) — încărcate o dată de la server.
  let catalog = null;

  // Starea wizardului.
  const wiz = {
    node: null,        // numele nodului configurat (P1/P2/P3)
    plant: null,       // {id, name, water_need, custom}
    soil: null,        // {id, name, retention, custom}
    color: 'mint',
  };

  let monitorTimer = null;
  let nodesTimer = null;
  let el = {};

  // ---------- Utilitare ----------

  function show(n) { if (n) n.hidden = false; }
  function hide(n) { if (n) n.hidden = true; }

  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  // ============================================================
  //  MONITOR — carduri noduri
  // ============================================================

  /** True dacă are sens să interogăm hub-ul (autentificat + provizionat). */
  function canPoll() {
    return !!(window.Dropwise && window.Dropwise.canUseHub
              && window.Dropwise.canUseHub());
  }

  async function pollMonitor() {
    // Fără cod / fără hub provizionat — nu interogăm (am primi doar 404).
    if (!canPoll()) {
      show(el.monitorOffline);
      el.nodeGrid.innerHTML = '';
      return;
    }
    try {
      const j = await getJSON('/api/hub/status', { cache: 'no-store' });
      if (!j.online || !j.data) {
        show(el.monitorOffline);
        el.nodeGrid.innerHTML = '';
        return;
      }
      hide(el.monitorOffline);
      renderNodeGrid(j.data.ports || [], el.nodeGrid);
    } catch (e) {
      show(el.monitorOffline);
      el.nodeGrid.innerHTML = '';
    }
  }

  /** Poll pentru grila de pe tabul Noduri (când wizardul NU e deschis). */
  async function pollNodesGrid() {
    // Cât timp wizardul e deschis, grila e ascunsă — nu o actualizăm.
    if (!el.wizard.hidden) return;
    // Fără cod / fără hub provizionat — nu interogăm.
    if (!canPoll()) return;
    try {
      const j = await getJSON('/api/hub/status', { cache: 'no-store' });
      if (j.online && j.data) {
        renderNodeGrid(j.data.ports || [], el.nodesGrid);
      }
    } catch (e) { /* lăsăm grila aşa cum e */ }
  }

  /**
   * Sincronizează o grilă de carduri cu starea raportată de hub.
   * Cardurile NU sunt reconstruite la fiecare poll — sunt create o dată şi
   * apoi doar actualizate în loc. Asta elimină flick-ul de re-randare.
   * @param ports lista de porturi din /status
   * @param grid  elementul-container al grilei
   */
  function renderNodeGrid(ports, grid) {
    const seen = new Set();

    // Afişăm un card pentru FIECARE port — slot gol inclusiv. Cardul e
    // identificat după numărul portului (nu după numele nodului, care
    // lipseşte la slot gol).
    ports.forEach((p) => {
      seen.add(String(p.port));
      let card = grid.querySelector(
        '.node-card[data-port="' + p.port + '"]');

      if (!card) {
        card = document.createElement('article');
        card.className = 'node-card';
        card.dataset.port = p.port;
        buildCardSkeleton(card);
        grid.appendChild(card);
      }

      if (p.physical && p.confirmed) {
        // Nod identificat de hub.
        updateCard(card, p);
      } else if (p.physical) {
        // Nod detectat fizic, dar neconfirmat — handshake în curs.
        updateHandshakeCard(card, p);
      } else {
        // Slot gol.
        updateEmptyCard(card, p);
      }
    });

    // Eliminăm cardurile pentru porturi care nu mai sunt raportate.
    grid.querySelectorAll('.node-card').forEach((c) => {
      if (!seen.has(c.dataset.port)) c.remove();
    });
  }

  /** Card de slot gol — niciun nod conectat pe acest port. */
  function updateEmptyCard(card, port) {
    if (card.dataset.state !== 'empty') {
      card.dataset.state = 'empty';
      // Doar titlul "Port X"; restul conţinutului ascuns.
      card.querySelector('.node-card__title').textContent =
        'Port ' + port.port;
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
      card.querySelector('.node-card__title').textContent =
        'Port ' + port.port;
      card.querySelector('.node-card__badge').hidden = true;
      card.querySelector('.node-card__menu').hidden = true;
      card.querySelector('.node-card__media').hidden = true;
      card.querySelector('.node-card__hint').hidden = true;
      card.querySelector('.node-card__plant').hidden = true;
      card.querySelector('.node-card__soil').hidden = true;
      card.querySelector('.node-card__sensors').hidden = true;
      card.querySelector('.node-card__cfg').hidden = true;
      // "Conectare ..." cu punctele animate, în centru.
      card.querySelector('.node-card__handshake').hidden = false;
      card.style.removeProperty('--node-accent');
    }
  }

  /** Construieşte o singură dată structura fixă a unui card.
   * Layout vertical: rând titlu (sus) + imagine pătrată centrată +
   * tip plantă + tip sol + date senzori.
   * Numele nodului se citeşte la click din card.dataset.node — un nod poate
   * fi mutat pe alt port, deci nu îl fixăm la construirea cardului. */
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

    // Butonul mare "Configurează" — vizibil doar pe nodurile neconfigurate.
    card.querySelector('.node-card__cfg').addEventListener('click', () => {
      if (card.dataset.node) openWizardForNode(card.dataset.node);
    });

    // Meniul ⋯ — deschidere/închidere + acţiunea de reconfigurare.
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
        if (card.dataset.node) openWizardForNode(card.dataset.node);
      });
  }

  /** Închide toate meniurile ⋯ deschise (la click în afara lor). */
  function closeAllNodeMenus() {
    document.querySelectorAll('.node-card__menu-list').forEach((m) => {
      m.hidden = true;
    });
    document.querySelectorAll('.node-card__menu-btn').forEach((b) => {
      b.setAttribute('aria-expanded', 'false');
    });
  }

  /** Actualizează în loc conţinutul unui card existent. */
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

    // Numele nodului — citit de butoanele de configurare din card.
    card.dataset.node = port.name;
    hand.hidden = true;   // nod confirmat — fără indicator de handshake

    // Rândul de titlu: "Port X · PY".
    const titleTxt = 'Port ' + port.port + '  ·  ' + port.name;
    if (title.textContent !== titleTxt) title.textContent = titleTxt;
    badge.hidden = false;   // restaurat dacă venea din stare "empty"

    if (port.configured) {
      // --- Nod configurat ---
      if (card.dataset.state !== 'configured') {
        card.dataset.state = 'configured';
        badge.className = 'node-card__badge node-card__badge--ok';
        badge.textContent = 'activ';
        // Reconfigurarea trece în meniul ⋯; butonul mare dispare.
        menu.hidden = false;
        btn.hidden = true;
        hint.hidden = true;
        media.hidden = false;
        plant.hidden = false;
        soil.hidden = false;
        sens.hidden = false;
      }
      // Config vine inline în /status — fără fetch separat, fără flash.
      const cfg = port.config;
      if (cfg && cfg.plant) {
        if (plant.textContent !== cfg.plant.name) {
          plant.textContent = cfg.plant.name;
        }
        if (soil.textContent !== cfg.soil.name) {
          soil.textContent = cfg.soil.name;
        }
        applyCardColor(card, cfg.color);
        // Imaginea plantei — doar dacă există fişier pentru acest id.
        setPlantImage(img, cfg.plant.id, cfg.plant.name);
      }
      // Datele de senzori — încă TODO (vin de la nod prin hub).
      if (!sens.dataset.filled) {
        sens.innerHTML = port.sensors
          ? ''   // TODO(live): randare valori reale de senzori
          : '<span class="node-card__todo">Date senzori — în curând</span>';
        sens.dataset.filled = '1';
      }
    } else {
      // --- Nod neconfigurat ---
      if (card.dataset.state !== 'unconfigured') {
        card.dataset.state = 'unconfigured';
        badge.className = 'node-card__badge node-card__badge--warn';
        badge.textContent = 'neconfigurat';
        // Buton mare "Configurează"; meniul ⋯ ascuns.
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
        card.style.removeProperty('--node-accent');  // fără accent
        // Fără plantă cunoscută => fără imagine.
        img.hidden = true;
        img.removeAttribute('src');
      }
    }
  }

  /**
   * Setează imaginea unei plante (static/plants/<id>.png).
   * Dacă fişierul lipseşte (onerror), ascunde elementul img elegant.
   */
  function setPlantImage(img, plantId, plantName) {
    const src = '/static/plants/' + plantId + '.png';
    if (img.getAttribute('src') === src) return;   // deja setată
    img.onerror = () => { img.hidden = true; };
    img.onload = () => { img.hidden = false; };
    img.alt = plantName || '';
    img.src = src;
  }

  /** Aplică culoarea aleasă pe tot cardul, prin variabila CSS
   * --node-accent (HSL). Margine, fundal şi badge se colorează în CSS.
   * Idempotent — nu rescrie dacă valoarea nu s-a schimbat. */
  function applyCardColor(card, colorId) {
    if (!catalog) return;
    const c = catalog.colors.find((x) => x.id === colorId);
    if (!c) return;
    if (card.style.getPropertyValue('--node-accent') !== c.accent) {
      card.style.setProperty('--node-accent', c.accent);
    }
  }

  // ============================================================
  //  WIZARD — configurare nod
  // ============================================================

  /**
   * Deschide wizardul pentru un nod. Comută la tabul "noduri", ascunde
   * grila de carduri şi porneşte wizardul de la primul pas.
   */
  function openWizardForNode(nodeName) {
    wiz.node = nodeName;
    wiz.plant = null;
    wiz.soil = null;
    wiz.color = 'mint';

    if (window.Dropwise && window.Dropwise.activateTab) {
      window.Dropwise.activateTab('nodes');
    }

    // Cardurile dispar, apare wizardul.
    hide(el.nodesGrid);
    show(el.wizard);
    hide(el.wizardError);
    el.wizardNodeName.textContent = nodeName;
    buildPlantStep();
    buildSoilStep();
    buildColorStep();
    setWizardStep('plant');
  }

  /** Închide wizardul şi readuce grila de carduri. */
  function closeWizard() {
    hide(el.wizard);
    show(el.nodesGrid);
    pollNodesGrid();   // reîmprospătăm imediat starea cardurilor
  }

  /** Comută pasul vizibil al wizardului. */
  function setWizardStep(step) {
    el.wizard.dataset.step = step;
    el.wizard.querySelectorAll('[data-wizard-section]').forEach((s) => {
      s.hidden = s.dataset.wizardSection !== step;
    });
    // Indicatorul de paşi
    el.wizard.querySelectorAll('.wizard__steps li').forEach((li) => {
      li.dataset.active = li.dataset.wstep === step ? 'true' : 'false';
    });
  }

  function wizardError(msg) {
    el.wizardErrorMsg.textContent = msg || 'A apărut o eroare.';
    show(el.wizardError);
  }

  // ----- Pas 1: Planta -----

  function buildPlantStep() {
    const grid = document.getElementById('plant-list');
    grid.innerHTML = '';

    catalog.plants.forEach((pl) => {
      grid.appendChild(makeChoice(pl.name, waterLabel(pl.water_need), () => {
        wiz.plant = { id: pl.id, name: pl.name,
                      water_need: pl.water_need, custom: false };
        hide(document.getElementById('plant-custom'));
        markChosen(grid, pl.id);
        document.getElementById('plant-next').disabled = false;
      }, pl.id, null, '/static/plants/' + pl.id + '.png'));
    });

    // Opţiunea "Altă plantă" — deschide formularul custom.
    grid.appendChild(makeChoice('Altă plantă', 'adaugă manual', () => {
      markChosen(grid, '__custom__');
      show(document.getElementById('plant-custom'));
      wiz.plant = null;
      document.getElementById('plant-next').disabled = true;
      syncPlantCustom();
    }, '__custom__', 'add'));
  }

  /** Citeşte formularul de plantă custom şi validează. */
  function syncPlantCustom() {
    const name = document.getElementById('plant-custom-name').value.trim();
    const lvl = currentLevel('water');
    const ok = name && lvl;
    if (ok) {
      wiz.plant = { id: 'custom', name: name,
                    water_need: lvl, custom: true };
    } else {
      wiz.plant = null;
    }
    document.getElementById('plant-next').disabled = !ok;
  }

  // ----- Pas 2: Solul -----

  function buildSoilStep() {
    const grid = document.getElementById('soil-list');
    grid.innerHTML = '';

    catalog.soils.forEach((so) => {
      grid.appendChild(makeChoice(so.name, retentionLabel(so.retention), () => {
        wiz.soil = { id: so.id, name: so.name,
                     retention: so.retention, custom: false };
        hide(document.getElementById('soil-custom'));
        markChosen(grid, so.id);
        document.getElementById('soil-next').disabled = false;
      }, so.id, null, '/static/soils/' + so.id + '.jpg'));
    });

    grid.appendChild(makeChoice('Alt sol', 'adaugă manual', () => {
      markChosen(grid, '__custom__');
      show(document.getElementById('soil-custom'));
      wiz.soil = null;
      document.getElementById('soil-next').disabled = true;
      syncSoilCustom();
    }, '__custom__', 'add'));
  }

  function syncSoilCustom() {
    const name = document.getElementById('soil-custom-name').value.trim();
    const lvl = currentLevel('retention');
    const ok = name && lvl;
    if (ok) {
      wiz.soil = { id: 'custom', name: name,
                   retention: lvl, custom: true };
    } else {
      wiz.soil = null;
    }
    document.getElementById('soil-next').disabled = !ok;
  }

  // ----- Pas 3: Sumar -----

  async function buildSummaryStep() {
    const list = document.getElementById('summary-list');
    list.innerHTML = '<li class="setup-hint">Se calculează…</li>';
    hide(el.wizardError);

    try {
      const j = await getJSON(
        '/api/node/' + encodeURIComponent(wiz.node) + '/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plant: wiz.plant, soil: wiz.soil }),
        });
      list.innerHTML = '';
      (j.explanation || []).forEach((line) => {
        const li = document.createElement('li');
        li.textContent = line;
        list.appendChild(li);
      });
    } catch (e) {
      list.innerHTML = '';
      wizardError('Nu s-a putut calcula sumarul: ' + e.message);
    }
  }

  // ----- Pas 4: Culoare -----

  function buildColorStep() {
    const grid = document.getElementById('color-list');
    grid.innerHTML = '';

    catalog.colors.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.dataset.color = c.id;
      btn.title = c.name;
      // Pastila afişează culoarea reală (HSL din catalog).
      btn.style.background = 'hsl(' + c.accent + ')';
      btn.setAttribute('aria-selected', c.id === wiz.color ? 'true' : 'false');
      btn.addEventListener('click', () => {
        wiz.color = c.id;
        grid.querySelectorAll('.color-swatch').forEach((s) => {
          s.setAttribute('aria-selected',
            s.dataset.color === c.id ? 'true' : 'false');
        });
      });
      grid.appendChild(btn);
    });
  }

  // ----- Trimitere către ESP32 -----

  async function sendConfig() {
    setWizardStep('working');
    hide(el.wizardError);

    try {
      const j = await getJSON('/api/node/' + encodeURIComponent(wiz.node), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plant: wiz.plant, soil: wiz.soil, color: wiz.color,
        }),
      });
      pollConfigJob(j.job.id);
    } catch (e) {
      setWizardStep('color');
      wizardError('Trimitere eşuată: ' + e.message);
    }
  }

  /** Polling pe job-ul de trimitere a configuraţiei. */
  function pollConfigJob(jobId) {
    const timer = setInterval(async () => {
      try {
        const j = await getJSON('/api/node/job/' + jobId,
                                { cache: 'no-store' });
        if (j.message) {
          document.getElementById('wizard-working-msg').textContent = j.message;
        }
        if (j.status === 'success') {
          clearInterval(timer);
          setWizardStep('done');
        } else if (j.status === 'error') {
          clearInterval(timer);
          setWizardStep('color');
          wizardError(j.message || 'Trimitere eşuată.');
        }
      } catch (e) {
        clearInterval(timer);
        setWizardStep('color');
        wizardError('Pierdere contact cu serverul: ' + e.message);
      }
    }, 700);
  }

  // ----- Componente UI reutilizabile -----

  /**
   * Card de alegere (plantă / sol) cu titlu + subtitlu.
   * variant 'add' => card de acţiune (contur punctat + iconiţă "+").
   * imageSrc     => dacă e setat, afişează imaginea (cale completă) în stânga.
   */
  function makeChoice(title, sub, onClick, id, variant, imageSrc) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice' + (variant === 'add' ? ' choice--add' : '');
    btn.dataset.choice = id;

    let html = '';
    if (variant === 'add') {
      // Iconiţă "+" pentru cardul de adăugare manuală.
      html += '<span class="choice__icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.5" stroke-linecap="round">' +
        '<path d="M12 5 v14"/><path d="M5 12 h14"/></svg></span>';
    } else if (imageSrc) {
      // Imaginea (plantă sau sol) în stânga cardului.
      html += '<span class="choice__media">' +
        '<img class="choice__img" alt="" /></span>';
    }
    html += '<span class="choice__text">' +
            '<span class="choice__title"></span>' +
            '<span class="choice__sub"></span></span>';
    btn.innerHTML = html;

    btn.querySelector('.choice__title').textContent = title;
    btn.querySelector('.choice__sub').textContent = sub;

    if (imageSrc && variant !== 'add') {
      const img = btn.querySelector('.choice__img');
      // Dacă fişierul lipseşte, ascundem doar imaginea (cardul rămâne).
      img.onerror = () => {
        const m = btn.querySelector('.choice__media');
        if (m) m.style.display = 'none';
      };
      img.src = imageSrc;
    }

    btn.addEventListener('click', onClick);
    return btn;
  }

  function markChosen(grid, id) {
    grid.querySelectorAll('.choice').forEach((c) => {
      c.setAttribute('aria-selected',
        c.dataset.choice === id ? 'true' : 'false');
    });
  }

  /** Nivelul selectat într-un grup .level-pick (water / retention). */
  function currentLevel(kind) {
    const grp = document.querySelector('.level-pick[data-level="' + kind + '"]');
    const active = grp && grp.querySelector('[aria-selected="true"]');
    return active ? active.dataset.value : null;
  }

  function waterLabel(lvl) {
    return { scazut: 'necesar scăzut de apă', mediu: 'necesar mediu',
             ridicat: 'necesar ridicat' }[lvl] || lvl;
  }
  function retentionLabel(lvl) {
    return { scazut: 'reţine puţină apă', mediu: 'retenţie medie',
             ridicat: 'reţine multă apă' }[lvl] || lvl;
  }

  // ============================================================
  //  Init
  // ============================================================

  function bindLevelPick(kind, onChange) {
    const grp = document.querySelector('.level-pick[data-level="' + kind + '"]');
    if (!grp) return;
    grp.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        grp.querySelectorAll('button').forEach((x) =>
          x.setAttribute('aria-selected', 'false'));
        b.setAttribute('aria-selected', 'true');
        onChange();
      });
    });
  }

  async function init() {
    const monitorPanel = document.getElementById('panel-monitor');
    const nodesPanel = document.getElementById('panel-nodes');
    if (!monitorPanel || !nodesPanel) return;

    el = {
      nodeGrid: document.getElementById('node-grid'),       // grila Monitor
      nodesGrid: document.getElementById('nodes-grid'),     // grila Noduri
      monitorOffline: document.getElementById('monitor-offline'),
      wizard: document.getElementById('wizard'),
      wizardNodeName: document.getElementById('wizard-node-name'),
      wizardError: document.getElementById('wizard-error'),
      wizardErrorMsg: document.getElementById('wizard-error-msg'),
    };

    // Catalogul — necesar atât pentru wizard cât şi pentru culorile cardurilor.
    try {
      catalog = await getJSON('/api/catalog');
    } catch (e) {
      catalog = { plants: [], soils: [], colors: [] };
    }

    // ---- Buton de revenire din wizard ----
    document.getElementById('wizard-close')
      .addEventListener('click', closeWizard);

    // ---- Navigarea wizardului ----
    document.getElementById('plant-next').addEventListener('click', () => {
      setWizardStep('soil');
    });
    document.getElementById('soil-back').addEventListener('click', () => {
      setWizardStep('plant');
    });
    document.getElementById('soil-next').addEventListener('click', () => {
      buildSummaryStep();
      setWizardStep('summary');
    });
    document.getElementById('summary-back').addEventListener('click', () => {
      setWizardStep('soil');
    });
    document.getElementById('summary-next').addEventListener('click', () => {
      setWizardStep('color');
    });
    document.getElementById('color-back').addEventListener('click', () => {
      setWizardStep('summary');
    });
    document.getElementById('color-finish').addEventListener('click', sendConfig);
    document.getElementById('wizard-to-monitor').addEventListener('click', () => {
      // Închidem wizardul (grila Noduri redevine vizibilă pentru data viitoare)
      // şi comutăm la Monitor.
      closeWizard();
      if (window.Dropwise && window.Dropwise.activateTab) {
        window.Dropwise.activateTab('monitor');
      }
    });

    // ---- Formulare custom ----
    document.getElementById('plant-custom-name')
      .addEventListener('input', syncPlantCustom);
    document.getElementById('soil-custom-name')
      .addEventListener('input', syncSoilCustom);
    bindLevelPick('water', syncPlantCustom);
    bindLevelPick('retention', syncSoilCustom);

    // Click în afara unui meniu ⋯ => îl închidem.
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('.node-card__menu')) closeAllNodeMenus();
    });
    // Esc închide meniurile deschise.
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeAllNodeMenus();
    });

    // ---- Polling pe tabul activ ----
    // Monitor şi Noduri afişează amândouă grila de carduri; fiecare are
    // propriul poll, pornit doar cât tabul respectiv e activ.
    window.addEventListener('dropwise:tab-activated', (ev) => {
      const tab = ev.detail && ev.detail.tab;
      if (tab === 'monitor') {
        startMonitorPolling();
        stopNodesPolling();
      } else if (tab === 'nodes') {
        stopMonitorPolling();
        startNodesPolling();
      } else {
        stopMonitorPolling();
        stopNodesPolling();
      }
    });
    if (monitorPanel.dataset.active === 'true') startMonitorPolling();
    if (nodesPanel.dataset.active === 'true') startNodesPolling();
  }

  function startMonitorPolling() {
    if (monitorTimer) return;
    pollMonitor();
    monitorTimer = setInterval(pollMonitor, MONITOR_POLL_MS);
  }
  function stopMonitorPolling() {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  }

  function startNodesPolling() {
    if (nodesTimer) return;
    pollNodesGrid();
    nodesTimer = setInterval(pollNodesGrid, MONITOR_POLL_MS);
  }
  function stopNodesPolling() {
    if (nodesTimer) { clearInterval(nodesTimer); nodesTimer = null; }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

/* ============================================================
   Dropwise — Noduri: wizard de configurare / reconfigurare
   ============================================================
   Paşii plantă → sol → sumar → culoare → trimitere → confirmare.
   Foloseşte namespace-ul partajat window.Dropwise.nodes.
   ============================================================ */

(function () {
  'use strict';

  const nodes = window.Dropwise.nodes;
  const { show, hide, getJSON } = nodes;
  const wiz = nodes.wiz;

  // ============================================================
  //  Deschidere / închidere wizard
  // ============================================================

  /** Deschide wizardul pentru CONFIGURARE iniţială — paşi goi. */
  nodes.openWizardForNode = function (nodeName) {
    wiz.node = nodeName;
    wiz.plant = null;
    wiz.soil = null;
    wiz.color = 'mint';
    wiz.edit = false;
    showWizard(nodeName, 'Configurare');
    setWizardStep('plant');
    nodes.setNodesHash(nodeName + '/configure');
  };

  /** Deschide wizardul pentru RECONFIGURARE — pre-completat, navigare liberă.
      Pe live, configul vine fresh de la hub (EEPROM); afişăm un loader card
      cât aşteptăm fetch-ul. */
  nodes.openWizardForReconfigure = async function (nodeName) {
    if (window.Dropwise.activateTab) window.Dropwise.activateTab('nodes');
    nodes.setNodesHash(nodeName + '/reconfigure');

    // Afişăm loader card ascunzând grila/antetul; wizardul real apare
    // după ce avem configul.
    showReconfigLoader(nodeName);

    let cfg = {};
    let fetchError = null;
    try {
      cfg = await getJSON('/api/node/' + encodeURIComponent(nodeName));
    } catch (e) {
      fetchError = e;
      cfg = {};
    }

    hideReconfigLoader();

    if (fetchError) {
      // Pe live, dacă hub-ul nu răspunde, nu avem ce să afişăm — wizardul
      // de reconfigurare are nevoie de date reale. Arătăm o eroare şi
      // închidem wizardul.
      showReconfigError(nodeName, fetchError.message);
      return;
    }

    wiz.node = nodeName;
    wiz.plant = cfg.plant || null;
    wiz.soil = cfg.soil || null;
    wiz.color = cfg.color || 'mint';
    wiz.edit = true;
    showWizard(nodeName, 'Reconfigurare');
    setWizardStep('plant');
  };

  /** Card de loading afişat cât aşteptăm configul de la hub. */
  function showReconfigLoader(nodeName) {
    const el = nodes.el;
    hide(el.wizard);
    hide(el.nodeStats);
    hide(el.nodeParams);
    show(el.nodesHeader);
    show(el.nodesGrid);

    let loader = document.getElementById('reconfig-loader');
    if (!loader) {
      loader = document.createElement('div');
      loader.id = 'reconfig-loader';
      loader.className = 'panel reconfig-loader';
      loader.innerHTML =
        '<span class="btn-spinner" aria-hidden="true"></span>' +
        '<span class="reconfig-loader__text">' +
        'Se încarcă configurarea pentru <strong></strong> de la hub…</span>';
      el.nodesGrid.parentNode.insertBefore(loader, el.nodesGrid);
    }
    loader.querySelector('strong').textContent = nodeName;
    loader.hidden = false;
    hide(el.nodesGrid);
  }

  function hideReconfigLoader() {
    const loader = document.getElementById('reconfig-loader');
    if (loader) loader.hidden = true;
    show(nodes.el.nodesGrid);
  }

  function showReconfigError(nodeName, message) {
    const el = nodes.el;
    let err = document.getElementById('reconfig-error');
    if (!err) {
      err = document.createElement('div');
      err.id = 'reconfig-error';
      err.className = 'panel reconfig-error';
      err.innerHTML =
        '<p class="reconfig-error__title">Nu am putut citi configul nodului</p>' +
        '<p class="reconfig-error__msg"></p>' +
        '<button type="button" class="btn btn--ghost">' +
        '<span aria-hidden="true">←</span> Înapoi la noduri</button>';
      err.querySelector('button').addEventListener('click', () => {
        err.hidden = true;
        show(el.nodesGrid);
        if (window.location.hash !== '#nodes') {
          history.replaceState(null, '', '#nodes');
        }
      });
      el.nodesGrid.parentNode.insertBefore(err, el.nodesGrid);
    }
    err.querySelector('.reconfig-error__msg').textContent =
      `Hub-ul nu a răspuns pentru ${nodeName}: ${message}. Verifică conexiunea ` +
      `şi reîncearcă.`;
    err.hidden = false;
    hide(el.nodesGrid);
  }

  /** Afişează wizardul: ascunde grila, construieşte paşii, setează titlul. */
  function showWizard(nodeName, titleWord) {
    const el = nodes.el;
    if (window.Dropwise.activateTab) window.Dropwise.activateTab('nodes');
    hide(el.nodesHeader);
    hide(el.nodesGrid);
    show(el.wizard);
    hide(el.wizardError);
    el.wizardNodeName.textContent = nodeName;
    if (el.wizardTitleWord) el.wizardTitleWord.textContent = titleWord;
    el.wizard.dataset.edit = wiz.edit ? 'true' : 'false';

    // La configurare iniţială "Continuă" porneşte blocat — se deblochează doar
    // după o selecţie. La reconfigurare totul e pre-completat, deci rămâne liber.
    document.getElementById('plant-next').disabled = !wiz.edit;
    document.getElementById('soil-next').disabled = !wiz.edit;

    buildPlantStep();
    buildSoilStep();
    buildColorStep();
  }

  /** Închide wizardul (apel din butonul "Înapoi la noduri"). Înlocuieşte
      hash-ul cu #nodes (replaceState) — revine mereu la lista de carduri,
      indiferent de istoricul anterior. */
  nodes.closeWizard = function () {
    if (window.location.hash !== '#nodes') {
      history.replaceState(null, '', '#nodes');
    }
    nodes.doCloseWizard();
  };

  /** Închidere efectivă fără manipulare istoric — folosită din
      applyNodesHash() (hash-ul s-a schimbat deja). */
  nodes.doCloseWizard = function () {
    const el = nodes.el;
    hide(el.wizard);
    show(el.nodesHeader);
    show(el.nodesGrid);
    nodes.pollNodesGrid();
  };

  // ============================================================
  //  Navigarea paşilor
  // ============================================================

  /** Comută pasul vizibil al wizardului. */
  function setWizardStep(step) {
    const el = nodes.el;
    el.wizard.dataset.step = step;
    el.wizard.querySelectorAll('[data-wizard-section]').forEach((s) => {
      s.hidden = s.dataset.wizardSection !== step;
    });
    el.wizard.querySelectorAll('.wizard__step').forEach((b) => {
      b.dataset.active = b.dataset.wstep === step ? 'true' : 'false';
    });
    // Pasul "Sumar" se recalculează la fiecare intrare.
    if (step === 'summary') buildSummaryStep();
  }
  nodes.setWizardStep = setWizardStep;

  function wizardError(msg) {
    nodes.el.wizardErrorMsg.textContent = msg || 'A apărut o eroare.';
    show(nodes.el.wizardError);
  }

  // ============================================================
  //  Pas 1: Planta
  // ============================================================

  function buildPlantStep() {
    const grid = document.getElementById('plant-list');
    grid.innerHTML = '';

    nodes.catalog.plants.forEach((pl) => {
      grid.appendChild(makeChoice(pl.name, waterLabel(pl.water_need), () => {
        wiz.plant = { id: pl.id, name: pl.name,
                      water_need: pl.water_need, custom: false };
        hide(document.getElementById('plant-custom'));
        markChosen(grid, pl.id);
        document.getElementById('plant-next').disabled = false;
      }, pl.id, null, '/static/plants/' + pl.id + '.png'));
    });

    grid.appendChild(makeChoice('Altă plantă', 'adaugă manual', () => {
      markChosen(grid, '__custom__');
      show(document.getElementById('plant-custom'));
      wiz.plant = null;
      document.getElementById('plant-next').disabled = true;
      syncPlantCustom();
    }, '__custom__', 'add'));

    if (wiz.edit && wiz.plant) preselectPlant();
  }

  /** Pre-selectează planta din wiz.plant (la reconfigurare). */
  function preselectPlant() {
    const grid = document.getElementById('plant-list');
    const custom = wiz.plant.custom;
    markChosen(grid, custom ? '__custom__' : wiz.plant.id);
    const form = document.getElementById('plant-custom');
    if (custom) {
      show(form);
      document.getElementById('plant-custom-name').value = wiz.plant.name;
      setLevel('water', wiz.plant.water_need);
    } else {
      hide(form);
    }
    document.getElementById('plant-next').disabled = false;
  }

  // Lungimea maximă (octeţi UTF-8) pentru numele custom — limitată de
  // dimensiunea câmpurilor din EEPROM (char[32], minus \0 = 31 utili).
  const NAME_MAX_BYTES = 31;

  /** Lungimea unui string în octeţi UTF-8 (nu caractere). */
  function utf8ByteLen(s) {
    return new TextEncoder().encode(s).length;
  }

  /** Actualizează contorul + culoarea în funcţie de lungime. */
  function updateNameCounter(inputId, counterId, errorId) {
    const inp     = document.getElementById(inputId);
    const counter = document.getElementById(counterId);
    const errorEl = document.getElementById(errorId);
    if (!inp || !counter) return false;
    const len = utf8ByteLen(inp.value.trim());
    const over = len > NAME_MAX_BYTES;
    counter.textContent = len + '/' + NAME_MAX_BYTES;
    counter.classList.toggle('field__counter--over', over);
    if (errorEl) errorEl.hidden = !over;
    inp.classList.toggle('field__input--invalid', over);
    return !over;
  }

  /** Citeşte formularul de plantă custom şi validează. */
  function syncPlantCustom() {
    const name = document.getElementById('plant-custom-name').value.trim();
    const lvl = currentLevel('water');
    const fits = updateNameCounter(
      'plant-custom-name', 'plant-name-counter', 'plant-name-error');
    const ok = name && lvl && fits;
    wiz.plant = ok
      ? { id: 'custom', name: name, water_need: lvl, custom: true }
      : null;
    document.getElementById('plant-next').disabled = !ok;
  }

  // ============================================================
  //  Pas 2: Solul
  // ============================================================

  function buildSoilStep() {
    const grid = document.getElementById('soil-list');
    grid.innerHTML = '';

    nodes.catalog.soils.forEach((so) => {
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

    if (wiz.edit && wiz.soil) preselectSoil();
  }

  /** Pre-selectează solul din wiz.soil (la reconfigurare). */
  function preselectSoil() {
    const grid = document.getElementById('soil-list');
    const custom = wiz.soil.custom;
    markChosen(grid, custom ? '__custom__' : wiz.soil.id);
    const form = document.getElementById('soil-custom');
    if (custom) {
      show(form);
      document.getElementById('soil-custom-name').value = wiz.soil.name;
      setLevel('retention', wiz.soil.retention);
    } else {
      hide(form);
    }
    document.getElementById('soil-next').disabled = false;
  }

  function syncSoilCustom() {
    const name = document.getElementById('soil-custom-name').value.trim();
    const lvl = currentLevel('retention');
    const fits = updateNameCounter(
      'soil-custom-name', 'soil-name-counter', 'soil-name-error');
    const ok = name && lvl && fits;
    wiz.soil = ok
      ? { id: 'custom', name: name, retention: lvl, custom: true }
      : null;
    document.getElementById('soil-next').disabled = !ok;
  }

  // ============================================================
  //  Pas 3: Sumar
  // ============================================================

  async function buildSummaryStep() {
    const list = document.getElementById('summary-list');
    list.innerHTML = '<li class="setup-hint">Se calculează…</li>';
    hide(nodes.el.wizardError);

    try {
      const j = await getJSON(
        '/api/node/' + encodeURIComponent(wiz.node) + '/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plant: wiz.plant, soil: wiz.soil }),
        });
      list.innerHTML = '';
      // Backend-ul trimite linii ca obiecte {group, text} — afişăm grupul
      // ca etichetă colorată în faţa textului. Fallback la string simplu
      // dacă vine vreodată în formatul vechi.
      (j.explanation || []).forEach((line) => {
        const li = document.createElement('li');
        if (typeof line === 'string') {
          li.textContent = line;
        } else {
          li.dataset.group = line.group || '';
          const tag = document.createElement('span');
          tag.className = 'summary-list__tag';
          tag.textContent = summaryTagLabel(line.group);
          const txt = document.createElement('span');
          txt.className = 'summary-list__text';
          txt.textContent = line.text || '';
          li.appendChild(tag);
          li.appendChild(txt);
        }
        list.appendChild(li);
      });
    } catch (e) {
      list.innerHTML = '';
      wizardError('Nu s-a putut calcula sumarul: ' + e.message);
    }
  }

  // ============================================================
  //  Pas 4: Culoare
  // ============================================================

  function buildColorStep() {
    const grid = document.getElementById('color-list');
    grid.innerHTML = '';

    nodes.catalog.colors.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.dataset.color = c.id;
      btn.title = c.name;
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

  // ============================================================
  //  Trimitere către ESP32
  // ============================================================

  async function sendConfig() {
    setWizardStep('working');
    hide(nodes.el.wizardError);

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

  // ============================================================
  //  Componente UI reutilizabile
  // ============================================================

  /**
   * Card de alegere (plantă / sol) cu titlu + subtitlu.
   * variant 'add' => card de acţiune (contur punctat + iconiţă "+").
   * imageSrc     => dacă e setat, afişează imaginea în stânga.
   */
  function makeChoice(title, sub, onClick, id, variant, imageSrc) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice' + (variant === 'add' ? ' choice--add' : '');
    btn.dataset.choice = id;

    let html = '';
    if (variant === 'add') {
      html += '<span class="choice__icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.5" stroke-linecap="round">' +
        '<path d="M12 5 v14"/><path d="M5 12 h14"/></svg></span>';
    } else if (imageSrc) {
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

  /** Setează nivelul activ într-un grup .level-pick (la pre-completare). */
  function setLevel(kind, value) {
    const grp = document.querySelector('.level-pick[data-level="' + kind + '"]');
    if (!grp) return;
    grp.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-selected',
        b.dataset.value === value ? 'true' : 'false');
    });
  }

  function waterLabel(lvl) {
    return { scazut: 'necesar scăzut de apă', mediu: 'necesar mediu',
             ridicat: 'necesar ridicat' }[lvl] || lvl;
  }
  function summaryTagLabel(group) {
    return { sol: 'Sol', planta: 'Plantă',
             functionare: 'Funcţionare' }[group] || '';
  }
  function retentionLabel(lvl) {
    return { scazut: 'reţine puţină apă', mediu: 'retenţie medie',
             ridicat: 'reţine multă apă' }[lvl] || lvl;
  }

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

  // ============================================================
  //  Init modul
  // ============================================================

  nodes.initWizard = function () {
    const el = nodes.el;

    document.getElementById('wizard-close')
      .addEventListener('click', nodes.closeWizard);

    // Navigarea paşilor
    document.getElementById('plant-next').addEventListener('click',
      () => setWizardStep('soil'));
    document.getElementById('soil-back').addEventListener('click',
      () => setWizardStep('plant'));
    document.getElementById('soil-next').addEventListener('click',
      () => setWizardStep('summary'));
    document.getElementById('summary-back').addEventListener('click',
      () => setWizardStep('soil'));
    document.getElementById('summary-next').addEventListener('click',
      () => setWizardStep('color'));
    document.getElementById('color-back').addEventListener('click',
      () => setWizardStep('summary'));
    document.getElementById('color-finish').addEventListener('click', sendConfig);

    // Indicator de paşi clicabil (doar în mod editare).
    el.wizard.querySelectorAll('.wizard__step').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (el.wizard.dataset.edit === 'true') setWizardStep(btn.dataset.wstep);
      });
    });

    document.getElementById('wizard-to-monitor').addEventListener('click', () => {
      nodes.closeWizard();
      if (window.Dropwise.activateTab) window.Dropwise.activateTab('monitor');
    });

    // Formulare custom
    document.getElementById('plant-custom-name')
      .addEventListener('input', syncPlantCustom);
    document.getElementById('soil-custom-name')
      .addEventListener('input', syncSoilCustom);
    bindLevelPick('water', syncPlantCustom);
    bindLevelPick('retention', syncSoilCustom);
  };
})();

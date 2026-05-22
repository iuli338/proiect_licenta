/* ============================================================
   Dropwise — Noduri: vedere parametri (model + regulator)
   ============================================================
   Afişează parametrii derivaţi pentru un nod configurat:
     - Modelul de sol (K, τ) — vine din retenţia solului.
     - Acordarea PI (setpoint, λ, Kp, Ki) — vine din planta aleasă.
     - Funcţionare (prag de declanşare, blocaj, volum estimat).
   Suportă MOD EDITARE: butonul "Editează" deblochează inputurile;
   butonul "Actualizează" trimite suprascrierile la nod prin
   POST /api/node/<P> cu cheia `regulator_override`.
   Vezi misc/model_regulator.md pentru fundamentul teoretic.
   ============================================================ */

(function () {
  'use strict';

  const nodes = window.Dropwise.nodes;
  const { show, hide, getJSON } = nodes;

  // Configuraţia completă a nodului curent — folosită ca punct de pornire
  // pentru editare şi ca payload de bază la trimitere.
  let currentCfg = null;
  // Valorile iniţiale (cum vin de la server) — referinţă pentru a detecta
  // ce s-a modificat. Cheia = numele câmpului din schema backend
  // (ex: "setpoint", "model.K"); valoarea = numeric.
  let initialValues = {};
  // True cât timp utilizatorul editează.
  let editMode = false;

  // Schema câmpurilor afişate — sursa de adevăr pentru rendering şi pentru
  // construirea override-ului. Trebuie să corespundă cu _OVERRIDE_SCHEMA din
  // backend (node_config.py). `path` = cheia trimisă la server.
  const FIELDS = {
    sol: [
      { path: 'model.K',          label: 'Câştig K',
        unit: '%/ml',  step: 0.001, dec: 3,
        hint: 'creşterea umidităţii per ml de apă' },
      { path: 'model.tau_h',      label: 'Constantă de timp τ',
        unit: 'h',     step: 0.1,   dec: 1,
        hint: 'cât rezistă solul fără udare' },
    ],
    planta: [
      { path: 'setpoint',         label: 'Setpoint umiditate',
        unit: '%',     step: 1,     dec: 0,
        hint: 'valoarea menţinută în jurul căreia lucrează PI-ul' },
      { path: 'lambda_h',         label: 'λ (constanta în b.î.)',
        unit: 'h',     step: 1,     dec: 0,
        hint: 'cât de prompt reacţionează regulatorul' },
      { path: 'Kp',               label: 'Kp (proporţional)',
        unit: '',      step: 0.001, dec: 3,
        hint: 'cât adaugă din eroarea curentă' },
      { path: 'Ki',               label: 'Ki (integral)',
        unit: '/h',    step: 0.0001, dec: 4,
        hint: 'cât adaugă din eroarea acumulată' },
    ],
    functionare: [
      { path: 'hysteresis',       label: 'Histerezis',
        unit: '%',     step: 1,     dec: 0,
        hint: 'lăţimea benzii de toleranţă' },
      { path: 'min_interval_min', label: 'Blocaj între udări',
        unit: 'min',   step: 1,     dec: 0,
        hint: 'timpul minim între două udări consecutive',
        displayAsHours: true },
      { path: 'dose_estimat_ml',  label: 'Volum estimat per udare',
        unit: 'ml',    step: 1,     dec: 0,
        hint: 'PI-ul ajustează dinamic în funcţie de eroare' },
    ],
  };

  // ============================================================
  //  Deschidere / închidere
  // ============================================================

  /** Deschide vederea de parametri a unui nod. */
  nodes.openNodeParams = async function (nodeName) {
    const el = nodes.el;
    if (window.Dropwise.activateTab) window.Dropwise.activateTab('nodes');
    hide(el.nodesHeader);
    hide(el.nodesGrid);
    hide(el.wizard);
    hide(el.nodeStats);
    show(el.nodeParams);
    nodes.setNodesHash(nodeName + '/params');
    el.paramsNodeName.textContent = nodeName;
    el.paramsSections.innerHTML =
      '<p class="setup-hint">Se încarcă parametrii…</p>';
    setEditMode(false);

    try {
      const cfg = await getJSON(
        '/api/node/' + encodeURIComponent(nodeName));
      currentCfg = cfg;
      captureInitialValues(cfg);
      renderParams();
    } catch (e) {
      el.paramsSections.innerHTML =
        '<p class="setup-hint">Parametrii nu sunt disponibili.</p>';
    }
  };

  /** Închide vederea, readuce grila. */
  function closeNodeParams() {
    const el = nodes.el;
    hide(el.nodeParams);
    show(el.nodesHeader);
    show(el.nodesGrid);
    setEditMode(false);
    nodes.setNodesHash('');
    nodes.pollNodesGrid();
  }

  // ============================================================
  //  Mod afişare / editare
  // ============================================================

  function setEditMode(on) {
    editMode = !!on;
    nodes.el.nodeParams.dataset.edit = editMode ? 'true' : 'false';
  }

  /** Salvează valorile iniţiale (cele din server) pentru a detecta modificări. */
  function captureInitialValues(cfg) {
    initialValues = {};
    const reg = cfg.regulator || {};
    Object.values(FIELDS).flat().forEach((f) => {
      initialValues[f.path] = readPath(reg, f.path);
    });
  }

  function readPath(obj, path) {
    return path.split('.').reduce(
      (o, k) => (o == null ? undefined : o[k]), obj);
  }

  // ============================================================
  //  Randare
  // ============================================================

  function renderParams() {
    const el = nodes.el;
    const cfg = currentCfg || {};
    const plant = cfg.plant || {};
    const soil = cfg.soil || {};

    el.paramsPlant.textContent = plant.name || '—';
    el.paramsSoil.textContent = soil.name || '';

    el.paramsSections.innerHTML = '';

    // Notă explicativă — context despre rolul solului/plantei. Se ascunde
    // când apare un toast (de succes/eroare), care îi ia locul vizual.
    const note = document.createElement('p');
    note.id = 'params-note';
    note.className = 'params-note';
    note.textContent =
      'Solul stabileşte parametrii modelului procesului, ' +
      'iar planta — parametrii regulatorului. Aceştia se ' +
      'recalculează la fiecare reconfigurare.';
    el.paramsSections.appendChild(note);

    // Bara de acţiuni (Editează / Actualizează / Anulează) — sub notă, ca
    // utilizatorul să citească contextul înainte de buton.
    el.paramsSections.appendChild(renderToolbar());

    // Toast pentru confirmare/eroare — plasat SUB toolbar. La apariţie,
    // nota informativă de mai sus se ascunde, iar mesajul îi ia locul.
    const toast = document.createElement('div');
    toast.id = 'params-toast';
    toast.className = 'params-toast';
    el.paramsSections.appendChild(toast);

    // Avertisment full-width — apare DOAR în mod edit, după bara orizontală
    // a primei secţiuni, înainte de "Model sol".
    if (editMode) {
      const warn = document.createElement('p');
      warn.className = 'params-note params-note--warn';
      warn.textContent =
        'Modifici parametrii regulatorului direct. Aceste schimbări ' +
        'se aplică pe propriul tău risc — valorile derivate automat ' +
        'sunt acordate matematic pe modelul solului identificat.';
      el.paramsSections.appendChild(warn);
    }

    renderSection('Model sol', 'sol', FIELDS.sol);
    renderSection('Acordare regulator', 'planta', FIELDS.planta);
    renderSection('Funcţionare', 'functionare', FIELDS.functionare);

    refreshUpdateButton();
  }

  /** Construieşte bara de butoane Edit/Actualizează/Anulează. */
  function renderToolbar() {
    const bar = document.createElement('div');
    bar.className = 'params-toolbar';

    if (!editMode) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn--ghost params-toolbar__edit';
      editBtn.innerHTML =
        '<svg class="params-toolbar__icon" viewBox="0 0 24 24" ' +
        'fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 20h9"/>' +
        '<path d="M16.5 3.5 a 2.121 2.121 0 0 1 3 3 L 7 19 l -4 1 1 -4 12.5 -12.5z"/>' +
        '</svg><span>Editează</span>';
      editBtn.addEventListener('click', () => {
        setEditMode(true);
        renderParams();
      });
      bar.appendChild(editBtn);
    } else {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn--ghost';
      cancelBtn.textContent = 'Anulează';
      cancelBtn.addEventListener('click', () => {
        setEditMode(false);
        renderParams();
      });

      const updateBtn = document.createElement('button');
      updateBtn.type = 'button';
      updateBtn.id = 'params-update';
      updateBtn.className = 'btn btn--primary';
      updateBtn.disabled = true;
      updateBtn.textContent = 'Actualizează';
      updateBtn.addEventListener('click', submitOverride);

      bar.appendChild(cancelBtn);
      bar.appendChild(updateBtn);
    }
    return bar;
  }

  /** Randează o secţiune (titlu + listă de câmpuri). */
  function renderSection(title, group, fields) {
    const container = nodes.el.paramsSections;
    const sec = document.createElement('div');
    sec.className = 'params-section';
    sec.dataset.group = group;

    const h = document.createElement('h3');
    h.className = 'params-section__title';
    h.textContent = title;
    sec.appendChild(h);

    const dl = document.createElement('dl');
    dl.className = 'params-list';
    fields.forEach((f) => {
      const initial = initialValues[f.path];

      // Etichetă + hint
      const dt = document.createElement('dt');
      dt.className = 'params-list__label';
      const lblText = document.createElement('span');
      lblText.className = 'params-list__name';
      lblText.textContent = f.label;
      dt.appendChild(lblText);
      const hintEl = document.createElement('span');
      hintEl.className = 'params-list__hint';
      hintEl.textContent = f.hint;
      dt.appendChild(hintEl);

      // Valoare — afişare sau input
      const dd = document.createElement('dd');
      dd.className = 'params-list__value';

      if (editMode) {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = String(f.step);
        input.dataset.path = f.path;
        input.className = 'params-input';
        input.value = initial != null ? Number(initial) : '';
        input.addEventListener('input', refreshUpdateButton);
        dd.appendChild(input);
        // Span de unitate adăugat mereu (cu lăţime fixă rezervată), chiar
        // dacă unitatea e goală — aşa toate inputurile se aliniază vertical.
        const unit = document.createElement('span');
        unit.className = 'params-input__unit';
        unit.textContent = f.unit || '';
        dd.appendChild(unit);
      } else {
        dd.textContent = formatValue(initial, f);
      }

      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    sec.appendChild(dl);
    container.appendChild(sec);
  }

  // ============================================================
  //  Detectare modificări + trimitere
  // ============================================================

  /** Citeşte inputurile şi întoarce override-ul: doar câmpurile schimbate
      şi cu valoare validă (număr finit). */
  function collectOverride() {
    const override = {};
    let invalid = false;
    nodes.el.paramsSections.querySelectorAll('input.params-input').forEach((inp) => {
      const path = inp.dataset.path;
      const raw = inp.value.trim();
      if (raw === '') {
        // Câmp gol în mod edit = invalid.
        invalid = true;
        inp.classList.add('params-input--invalid');
        return;
      }
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        invalid = true;
        inp.classList.add('params-input--invalid');
        return;
      }
      inp.classList.remove('params-input--invalid');
      // Comparăm cu valoarea iniţială (toleranţă pentru float).
      const init = initialValues[path];
      if (init == null || Math.abs(num - Number(init)) > 1e-9) {
        override[path] = num;
      }
    });
    return { override, invalid };
  }

  /** Activează "Actualizează" doar dacă există modificări valide. */
  function refreshUpdateButton() {
    const btn = document.getElementById('params-update');
    if (!btn) return;
    const { override, invalid } = collectOverride();
    const hasChanges = Object.keys(override).length > 0;
    btn.disabled = invalid || !hasChanges;
  }

  /** Comută butonul "Actualizează" în starea de încărcare (spinner + text). */
  function setUpdateButtonLoading(btn, on) {
    if (!btn) return;
    if (on) {
      btn.disabled = true;
      btn.classList.add('btn--loading');
      btn.innerHTML =
        '<span class="btn-spinner" aria-hidden="true"></span>' +
        '<span>Se trimite…</span>';
    } else {
      btn.classList.remove('btn--loading');
      btn.textContent = 'Actualizează';
    }
  }

  async function submitOverride() {
    const btn = document.getElementById('params-update');
    if (!btn || btn.disabled) return;

    const { override, invalid } = collectOverride();
    if (invalid || Object.keys(override).length === 0) return;

    setUpdateButtonLoading(btn, true);

    const nodeName = nodes.el.paramsNodeName.textContent;
    const payload = {
      plant: currentCfg.plant,
      soil:  currentCfg.soil,
      color: currentCfg.color,
      regulator_override: override,
    };

    try {
      const j = await getJSON('/api/node/' + encodeURIComponent(nodeName), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      // Polling pe job — la fel ca în wizard.
      pollJob(j.job.id, j.config);
    } catch (e) {
      showToast('Trimitere eşuată: ' + e.message, 'error');
      setUpdateButtonLoading(btn, false);
      btn.disabled = false;
    }
  }

  function pollJob(jobId, newConfig) {
    const timer = setInterval(async () => {
      try {
        const j = await getJSON('/api/node/job/' + jobId,
                                { cache: 'no-store' });
        if (j.status === 'success') {
          clearInterval(timer);
          // Salvăm configul nou, ieşim din mod editare, randăm fresh,
          // apoi afişăm toast peste.
          currentCfg = newConfig || currentCfg;
          captureInitialValues(currentCfg);
          setEditMode(false);
          renderParams();
          showToast('Parametri actualizaţi cu succes. ' +
                    'Nodul a confirmat primirea.', 'ok');
        } else if (j.status === 'error') {
          clearInterval(timer);
          resetUpdateButton();
          showToast(j.message || 'Trimitere eşuată.', 'error');
        }
      } catch (e) {
        clearInterval(timer);
        resetUpdateButton();
        showToast('Pierdere contact cu serverul: ' + e.message, 'error');
      }
    }, 700);
  }

  function resetUpdateButton() {
    const btn = document.getElementById('params-update');
    if (!btn) return;
    setUpdateButtonLoading(btn, false);
    btn.disabled = false;
  }

  function showToast(msg, kind) {
    const t = document.getElementById('params-toast');
    if (!t) return;
    kind = kind || 'ok';
    // Pictogramă: check pentru succes, X pentru eroare.
    const iconSvg = kind === 'ok'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true"><path d="M5 12 l5 5 L 20 7"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true"><path d="M6 6 l12 12 M18 6 L 6 18"/></svg>';
    t.innerHTML =
      '<span class="params-toast__icon">' + iconSvg + '</span>' +
      '<span class="params-toast__text"></span>';
    t.querySelector('.params-toast__text').textContent = msg;
    t.dataset.kind = kind;
    t.classList.add('params-toast--show');
    // Cât timp toast-ul e vizibil, ascundem nota informativă — mesajul îi
    // ia locul vizual sub butonul "Editează".
    const note = document.getElementById('params-note');
    if (note) note.hidden = true;
    // Asigurăm că toast-ul e în câmpul vizual.
    if (typeof t.scrollIntoView === 'function') {
      t.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      t.classList.remove('params-toast--show');
      const noteAtEnd = document.getElementById('params-note');
      if (noteAtEnd) noteAtEnd.hidden = false;
    }, 4500);
  }

  // ============================================================
  //  Formatare
  // ============================================================

  function formatValue(v, f) {
    if (v == null || Number.isNaN(v)) return '—';
    const n = Number(v);
    if (f.displayAsHours && f.unit === 'min') {
      // Afişare prietenoasă pentru blocaj: 1440 min → "24 h".
      if (n >= 60) {
        const h = n / 60;
        return (h === Math.round(h) ? h : h.toFixed(1)) + ' h';
      }
      return n + ' min';
    }
    return n.toFixed(f.dec) + (f.unit ? ' ' + f.unit : '');
  }

  // ============================================================
  //  Init modul
  // ============================================================

  nodes.initParams = function () {
    document.getElementById('params-close')
      .addEventListener('click', closeNodeParams);
  };
})();

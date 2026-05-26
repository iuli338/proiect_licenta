/* ============================================================
   Dropwise — Noduri: vedere statistici + rutare prin hash
   ============================================================
   Statisticile unui nod (data creării, total udări, ml etc.) şi
   rutarea sub-vederilor prin hash (#nodes/P1/stats, #nodes/P1/config).
   Foloseşte namespace-ul partajat window.Dropwise.nodes.
   ============================================================ */

(function () {
  'use strict';

  const nodes = window.Dropwise.nodes;
  const { show, hide, getJSON } = nodes;

  // ============================================================
  //  Rutare prin hash
  // ============================================================

  // Cât timp aplicăm o rută din hash, nu rescriem hash-ul înapoi
  // (evită bucle hashchange).
  let applyingHash = false;

  /**
   * Scrie sub-calea tabului Noduri în hash (ex: "P1/stats" sau "").
   * @param sub  sub-calea (ex: "P1/config"); "" sau null = doar "#nodes".
   * @param push dacă true (default), foloseşte pushState — adaugă entry
   *   în istoric, deci back-ul browserului închide pagina. Pentru
   *   `replaceState` (înlocuieşte entry-ul curent, nu apare back), pass `false`.
   */
  nodes.setNodesHash = function (sub, push) {
    if (applyingHash) return;
    const h = sub ? '#nodes/' + sub : '#nodes';
    if (window.location.hash === h) return;
    if (push === false) {
      history.replaceState(null, '', h);
    } else {
      history.pushState(null, '', h);
    }
  };

  /**
   * Aplică ruta din hash pentru tabul Noduri.
   * Forme: nodes | nodes/<P>/configure | nodes/<P>/reconfigure |
   *        nodes/<P>/stats | nodes/<P>/params
   *
   * Garda `applyingHash` trebuie să acopere TOATĂ operaţia, inclusiv
   * await-urile din openWizard/openNodeStats — altfel deschiderea cedează
   * controlul la primul await, garda se ridică, iar activateTab() apelat
   * dinăuntru re-declanşează applyNodesHash → buclă infinită de fetch-uri.
   */
  nodes.applyNodesHash = async function () {
    if (applyingHash) return;

    const parts = window.location.hash.replace('#', '').split('/');
    if (parts[0] !== 'nodes') return;

    const node = parts[1];
    const view = parts[2];
    applyingHash = true;
    try {
      if (node && view === 'stats') {
        await nodes.openNodeStats(node);
      } else if (node && view === 'params' && nodes.openNodeParams) {
        await nodes.openNodeParams(node);
      } else if (node && view === 'configure') {
        nodes.openWizardForNode(node);
      } else if (node && view === 'reconfigure') {
        await nodes.openWizardForReconfigure(node);
      } else {
        closeSubViews();
      }
    } finally {
      applyingHash = false;
    }
  };

  /** Închide wizardul/statisticile/parametrii fără a rescrie hash-ul. */
  function closeSubViews() {
    const el = nodes.el;
    hide(el.wizard);
    hide(el.nodeStats);
    hide(el.nodeParams);
    show(el.nodesHeader);
    show(el.nodesGrid);
    if (nodes.renderNodesHistory) nodes.renderNodesHistory();
  }

  // ============================================================
  //  Vedere statistici
  // ============================================================

  // Cache pe sesiune: dacă utilizatorul deschide aceeaşi pagină de stats
  // de mai multe ori fără să schimbe nimic, refolosim datele primite.
  // Invalidat la închidere ca să facem fetch fresh la următoarea deschidere
  // (asta era cerinţa explicită: "nu mai facem alt fetch decât la următoarea
  // deschidere de stats").
  let statsCache = null;       // {node, data} sau null

  /** Deschide vederea de statistici a unui nod. */
  nodes.openNodeStats = async function (nodeName) {
    const el = nodes.el;
    if (window.Dropwise.activateTab) window.Dropwise.activateTab('nodes');
    hide(el.nodesHeader);
    hide(el.nodesGrid);
    hide(el.nodesHistorySection);
    hide(el.wizard);
    hide(el.nodeParams);
    show(el.nodeStats);
    nodes.setNodesHash(nodeName + '/stats');
    el.statsNodeName.textContent = nodeName;

    // Stare iniţială: loader vizibil, conţinut + eroare ascunse.
    setStatsState('loading');

    // Dacă avem deja în cache pentru acelaşi nod, refolosim instant.
    if (statsCache && statsCache.node === nodeName) {
      renderStats(statsCache.data);
      setStatsState('content');
      return;
    }

    try {
      const j = await getJSON(
        '/api/node/' + encodeURIComponent(nodeName) + '/stats');
      statsCache = { node: nodeName, data: j };
      renderStats(j);
      setStatsState('content');
    } catch (e) {
      statsCache = null;
      showStatsError(e.message || 'Hub-ul nu a răspuns.');
    }
  };

  /** Comută între stările loader / content / error. */
  function setStatsState(state) {
    const loader  = document.getElementById('stats-loader');
    const content = document.getElementById('stats-content');
    const errBox  = document.getElementById('stats-error');
    if (loader)  loader.hidden  = state !== 'loading';
    if (content) content.hidden = state !== 'content';
    if (errBox)  errBox.hidden  = state !== 'error';
  }

  function showStatsError(message) {
    const errBox = document.getElementById('stats-error');
    if (errBox) {
      errBox.querySelector('.stats-error__msg').textContent =
        'Detalii: ' + message;
    }
    setStatsState('error');
  }

  /** Închide vederea de statistici (apel din butonul "Înapoi"). Înlocuieşte
      hash-ul cu #nodes (replaceState) — revine mereu la lista de carduri. */
  function closeNodeStats() {
    if (window.location.hash !== '#nodes') {
      history.replaceState(null, '', '#nodes');
    }
    doCloseNodeStats();
  }

  /** Închidere efectivă, fără manipulare istoric. */
  function doCloseNodeStats() {
    const el = nodes.el;
    hide(el.nodeStats);
    show(el.nodesHeader);
    show(el.nodesGrid);
    if (nodes.renderNodesHistory) nodes.renderNodesHistory();
    // Invalidăm cache-ul — următoarea deschidere face fetch fresh.
    statsCache = null;
    nodes.pollNodesGrid();
  }
  nodes.doCloseNodeStats = doCloseNodeStats;

  /** Randează lista de statistici primită de la server. */
  function renderStats(data) {
    const el = nodes.el;
    const cfg = data.config || {};
    const s = data.stats || {};

    el.statsPlant.textContent = (cfg.plant && cfg.plant.name) || '—';
    el.statsSoil.textContent = (cfg.soil && cfg.soil.name) || '';

    const rows = [
      ['Data configurării',   fmtDate(s.created_at)],
      ['Ultima conectare',    fmtRelative(s.last_seen)],
      ['Zile de funcţionare', s.uptime_days != null ? s.uptime_days + ' zile' : '—'],
      ['Total udări',         s.total_waterings != null ? String(s.total_waterings) : '—'],
      ['Total apă livrată',   s.total_ml != null ? fmtMl(s.total_ml) : '—'],
      ['Medie per udare',     s.avg_ml_per_watering != null ? s.avg_ml_per_watering + ' ml' : '—'],
      ['Ultima udare',        fmtRelative(s.last_watering)],
    ];

    el.statsList.innerHTML = '';
    rows.forEach(([label, value]) => {
      const dt = document.createElement('dt');
      dt.className = 'stats-list__label';
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.className = 'stats-list__value';
      dd.textContent = value;
      el.statsList.appendChild(dt);
      el.statsList.appendChild(dd);
    });
  }

  // ----- Formatare valori -----

  /** Timestamp (secunde) -> dată locală scurtă. */
  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleDateString('ro-RO',
      { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /** Timestamp -> text relativ ("acum 3 ore", "ieri"...). */
  function fmtRelative(ts) {
    if (!ts) return '—';
    const diff = Date.now() / 1000 - ts;
    if (diff < 90) return 'chiar acum';
    if (diff < 3600) return 'acum ' + Math.round(diff / 60) + ' min';
    if (diff < 86400) return 'acum ' + Math.round(diff / 3600) + ' h';
    const days = Math.round(diff / 86400);
    return days === 1 ? 'acum o zi' : 'acum ' + days + ' zile';
  }

  /** Mililitri -> "X.X L" peste 1000, altfel "X ml". */
  function fmtMl(ml) {
    if (ml >= 1000) return (ml / 1000).toFixed(1) + ' L';
    return ml + ' ml';
  }

  // ============================================================
  //  Init modul
  // ============================================================

  nodes.initStats = function () {
    document.getElementById('stats-close')
      .addEventListener('click', closeNodeStats);
  };
})();

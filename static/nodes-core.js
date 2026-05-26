/* ============================================================
   Dropwise — Noduri: nucleu comun
   ============================================================

   Tab-ul "Noduri" + grila de pe "Monitor" sunt împărţite în 4 fişiere
   care comunică printr-un namespace partajat: window.Dropwise.nodes (NS).
   Ordinea de încărcare în dashboard.html:
     nodes-core.js  →  nodes-grid.js  →  nodes-wizard.js  →  nodes-stats.js

   Acest fişier conţine: starea partajată, utilitarele şi orchestrarea
   (init + polling). Celelalte module îşi ataşează funcţiile la NS.
   ============================================================ */

(function () {
  'use strict';

  // Namespace partajat — puntea între modulele de noduri.
  const NS = (window.Dropwise = window.Dropwise || {});
  NS.nodes = NS.nodes || {};
  const nodes = NS.nodes;

  // ---------- Stare partajată ----------

  nodes.MONITOR_POLL_MS = 1500;

  // Cataloagele (plante/soluri/culori) — încărcate o dată de la server.
  nodes.catalog = null;

  // Starea wizardului.
  nodes.wiz = {
    node: null,        // numele nodului configurat (P1/P2/P3)
    plant: null,       // {id, name, water_need, custom}
    soil: null,        // {id, name, retention, custom}
    color: 'mint',
    edit: false,       // true = reconfigurare (pre-completat, navigare liberă)
  };

  // Referinţe DOM — populate în init().
  nodes.el = {};

  // Timere de polling.
  let monitorTimer = null;
  let nodesTimer = null;

  // ---------- Utilitare partajate ----------

  nodes.show = function (n) { if (n) n.hidden = false; };
  nodes.hide = function (n) { if (n) n.hidden = true; };

  nodes.getJSON = async function (url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  };

  /** True dacă are sens să interogăm hub-ul (autentificat + provizionat). */
  nodes.canPoll = function () {
    return !!(window.Dropwise && window.Dropwise.canUseHub
              && window.Dropwise.canUseHub());
  };

  // ---------- Polling ----------

  nodes.startMonitorPolling = function () {
    if (monitorTimer) return;
    nodes.pollMonitor();
    monitorTimer = setInterval(nodes.pollMonitor, nodes.MONITOR_POLL_MS);
  };
  nodes.stopMonitorPolling = function () {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  };

  nodes.startNodesPolling = function () {
    if (nodesTimer) return;
    nodes.pollNodesGrid();
    nodesTimer = setInterval(nodes.pollNodesGrid, nodes.MONITOR_POLL_MS);
  };
  nodes.stopNodesPolling = function () {
    if (nodesTimer) { clearInterval(nodesTimer); nodesTimer = null; }
  };

  // ---------- Init ----------

  async function init() {
    const monitorPanel = document.getElementById('panel-monitor');
    const nodesPanel = document.getElementById('panel-nodes');
    if (!monitorPanel || !nodesPanel) return;

    nodes.el = {
      nodeGrid: document.getElementById('node-grid'),       // grila Monitor
      nodesGrid: document.getElementById('nodes-grid'),     // grila Noduri
      nodesHeader: document.getElementById('nodes-header'), // antet tab
      nodesHistorySection: document.getElementById('nodes-history-section'),
      nodesHistoryGrid: document.getElementById('nodes-history-grid'),
      hubCard: document.getElementById('hub-card'),         // card stare hub
      wizard: document.getElementById('wizard'),
      wizardNodeName: document.getElementById('wizard-node-name'),
      wizardTitleWord: document.getElementById('wizard-title-word'),
      wizardError: document.getElementById('wizard-error'),
      wizardErrorMsg: document.getElementById('wizard-error-msg'),
      nodeStats: document.getElementById('node-stats'),
      statsNodeName: document.getElementById('stats-node-name'),
      statsPlant: document.getElementById('stats-plant'),
      statsSoil: document.getElementById('stats-soil'),
      statsList: document.getElementById('stats-list'),
      nodeParams: document.getElementById('node-params'),
      paramsNodeName: document.getElementById('params-node-name'),
      paramsPlant: document.getElementById('params-plant'),
      paramsSoil: document.getElementById('params-soil'),
      paramsSections: document.getElementById('params-sections'),
    };

    // Catalogul — necesar pentru wizard şi pentru culorile cardurilor.
    try {
      nodes.catalog = await nodes.getJSON('/api/catalog');
    } catch (e) {
      nodes.catalog = { plants: [], soils: [], colors: [] };
    }

    // Lăsăm fiecare modul să-şi lege evenimentele proprii.
    if (nodes.initGrid) nodes.initGrid();
    if (nodes.initWizard) nodes.initWizard();
    if (nodes.initStats) nodes.initStats();
    if (nodes.initParams) nodes.initParams();

    // Randează istoricul o dată la încărcare — pentru tab-ul Noduri, ca să
    // apară chiar şi când hub-ul e offline / fără cod de acces.
    if (nodes.renderNodesHistory) nodes.renderNodesHistory();

    // ---- Polling pe tabul activ ----
    window.addEventListener('dropwise:tab-activated', (ev) => {
      const tab = ev.detail && ev.detail.tab;
      if (tab === 'monitor') {
        nodes.startMonitorPolling();
        nodes.stopNodesPolling();
        // Deschide pagina Grafice dacă hash-ul cere asta (deep-link).
        if (nodes.applyMonitorHash) nodes.applyMonitorHash();
      } else if (tab === 'nodes') {
        nodes.stopMonitorPolling();
        nodes.startNodesPolling();
        nodes.applyNodesHash();   // deschide wizard/statistici după hash
        // Părăsim Monitor-ul → curăţăm pagina Grafice dacă era deschisă.
        if (nodes.closeGraphViewIfOpen) nodes.closeGraphViewIfOpen();
      } else {
        nodes.stopMonitorPolling();
        nodes.stopNodesPolling();
        if (nodes.closeGraphViewIfOpen) nodes.closeGraphViewIfOpen();
      }
    });

    // Deep-link: reacţionăm la schimbarea hash-ului.
    window.addEventListener('hashchange', () => {
      if (nodesPanel.dataset.active === 'true') nodes.applyNodesHash();
      if (monitorPanel.dataset.active === 'true' && nodes.applyMonitorHash) {
        nodes.applyMonitorHash();
      }
    });

    if (monitorPanel.dataset.active === 'true') {
      nodes.startMonitorPolling();
      if (nodes.applyMonitorHash) nodes.applyMonitorHash();
    }
    if (nodesPanel.dataset.active === 'true') {
      nodes.startNodesPolling();
      nodes.applyNodesHash();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

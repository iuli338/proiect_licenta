/* ============================================================
   Dropwise Dashboard — shell JS
   - Switching între taburi (cu hash în URL)
   - Polling status hub în topbar
   Codul specific fiecărui tab va fi adăugat ulterior, modular.
   ============================================================ */

(function () {
  'use strict';

  // ---------- Tab switching ----------

  const VALID_TABS = ['setup', 'monitor', 'nodes', 'control', 'settings'];
  const DEFAULT_TAB = 'setup';

  function getTabFromHash() {
    const hash = (window.location.hash || '').replace('#', '');
    return VALID_TABS.includes(hash) ? hash : DEFAULT_TAB;
  }

  // Un tab e "blocat" cât timp hub-ul nu a fost configurat (data-lockable
  // + disabled). Până la prima conectare reuşită, doar "setup" e accesibil.
  function isTabLocked(name) {
    const btn = document.querySelector('.tab[data-tab="' + name + '"]');
    return !!(btn && btn.hasAttribute('data-lockable') && btn.disabled);
  }

  function activateTab(name) {
    if (!VALID_TABS.includes(name)) name = DEFAULT_TAB;

    // Tab blocat → cad înapoi pe "setup". Asta acoperă şi accesul direct
    // prin hash (ex: cineva pune #monitor în URL înainte de configurare).
    if (isTabLocked(name)) name = DEFAULT_TAB;

    // Marchez butonul activ
    document.querySelectorAll('.tab').forEach((btn) => {
      const isActive = btn.dataset.tab === name;
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    // Afișez panel-ul activ
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.dataset.active = panel.id === 'panel-' + name ? 'true' : 'false';
    });

    // Sincronizez hash-ul fără să declanșez scroll
    if (window.location.hash.replace('#', '') !== name) {
      history.replaceState(null, '', '#' + name);
    }

    // Eveniment custom — taburile individuale pot asculta pentru "lazy init"
    window.dispatchEvent(new CustomEvent('dropwise:tab-activated', {
      detail: { tab: name }
    }));
  }

  function initTabs() {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });

    window.addEventListener('hashchange', () => {
      activateTab(getTabFromHash());
    });

    activateTab(getTabFromHash());
  }

  // ---------- Status hub în topbar ----------

  const STATUS_POLL_MS = 3000;
  let pollTimer = null;

  async function pollHubStatus() {
    const pill = document.querySelector('#hub-status');
    const label = document.querySelector('#hub-status-label');
    if (!pill || !label) return;

    try {
      const r = await fetch('/api/hub/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();

      if (j.online) {
        pill.className = 'status-pill status-pill--online';
        label.textContent = 'hub online';
      } else if (j.error === 'hub_ip_not_set') {
        pill.className = 'status-pill status-pill--pending';
        label.textContent = 'hub neconfigurat';
      } else {
        pill.className = 'status-pill status-pill--offline';
        label.textContent = 'hub offline';
      }
    } catch (e) {
      pill.className = 'status-pill status-pill--offline';
      label.textContent = 'eroare';
    }
  }

  function startPolling() {
    pollHubStatus();
    pollTimer = setInterval(pollHubStatus, STATUS_POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Opresc polling-ul când tab-ul browserului e în background
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else startPolling();
  });

  // ---------- API public pentru taburile individuale ----------

  // Deblochează toate taburile (apelat de setup.js după prima conectare
  // reuşită a hub-ului).
  function unlockTabs() {
    document.querySelectorAll('.tab[data-lockable]').forEach((btn) => {
      btn.disabled = false;
      btn.removeAttribute('aria-disabled');
    });
    const tabs = document.querySelector('.tabs');
    if (tabs) tabs.dataset.provisioned = 'true';
  }

  window.Dropwise = window.Dropwise || {};
  window.Dropwise.unlockTabs = unlockTabs;
  window.Dropwise.activateTab = activateTab;

  // ---------- Init ----------

  document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    startPolling();
  });
})();

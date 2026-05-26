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
    // Hash-ul poate avea sub-căi: "#nodes/P1/stats". Tab-ul e primul
    // segment; restul e gestionat de modulul tabului (ex: nodes.js).
    const hash = (window.location.hash || '').replace('#', '');
    const tab = hash.split('/')[0];
    return VALID_TABS.includes(tab) ? tab : DEFAULT_TAB;
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

    // Sincronizez hash-ul. Dacă hash-ul curent e deja pe acest tab (cu sau
    // fără sub-cale, ex: "nodes/P1/stats"), îl las neatins — sub-calea e
    // gestionată de modulul tabului. Doar la schimbare de tab îl rescriu.
    const curTab = window.location.hash.replace('#', '').split('/')[0];
    if (curTab !== name) {
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

  // Starea hub-ului se afişează acum într-un card pe tab-ul Monitor
  // (vezi nodes-grid.js), nu în topbar.

  // ---------- Blocarea taburilor ----------
  //
  // Taburile Monitor/Noduri/Control/Setări sunt accesibile doar când hub-ul
  // e provizionat ŞI codul de acces a fost introdus. Altfel rămân disabled —
  // n-ar funcţiona oricum (API-urile dau 404 fără cod).

  function tabsProvisioned() {
    const tabs = document.querySelector('.tabs');
    return !!(tabs && tabs.dataset.provisioned === 'true');
  }

  function tabsAuthenticated() {
    return !!(window.Dropwise && window.Dropwise.isAuthenticated
              && window.Dropwise.isAuthenticated());
  }

  /** Re-evaluează blocarea taburilor după starea curentă. */
  function refreshTabLock() {
    const unlocked = tabsProvisioned() && tabsAuthenticated();
    document.querySelectorAll('.tab[data-lockable]').forEach((btn) => {
      btn.disabled = !unlocked;
      if (unlocked) btn.removeAttribute('aria-disabled');
      else btn.setAttribute('aria-disabled', 'true');
    });
  }

  /** Marchează hub-ul ca provizionat şi re-evaluează blocarea. */
  function markProvisioned() {
    const tabs = document.querySelector('.tabs');
    if (tabs) tabs.dataset.provisioned = 'true';
    refreshTabLock();
  }

  /** Marchează hub-ul ca NEprovizionat (după "Deconectează şi uită"). */
  function markUnprovisioned() {
    const tabs = document.querySelector('.tabs');
    if (tabs) tabs.dataset.provisioned = 'false';
    refreshTabLock();
  }

  window.Dropwise = window.Dropwise || {};
  window.Dropwise.activateTab = activateTab;
  // markProvisioned — apelat de setup.js după "Conectare".
  window.Dropwise.unlockTabs = markProvisioned;
  // markUnprovisioned — apelat de setup.js după "Deconectează şi uită".
  window.Dropwise.lockTabs = markUnprovisioned;
  // refreshTabLock — apelat de auth.js după ce codul a fost validat.
  window.Dropwise.refreshTabLock = refreshTabLock;

  // ---------- Init ----------

  document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    refreshTabLock();   // stare iniţială (poate fi deja provizionat din server)
  });
})();

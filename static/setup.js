/* ============================================================
   Dropwise — Initial Setup (detecţie BLE + aprovizionare WiFi)
   ============================================================

   Flux:
     1. Scanare BLE        → POST /api/setup/scan
     2. Selectare hub      → trecere la formularul de credenţiale
     3. Trimitere creden.  → POST /api/setup/provision  (returnează job_id)
     4. Polling job        → GET  /api/setup/job/<id>   cât timp UI-ul e blocat
     5. Succes → "Conectare"→ POST /api/setup/connect    (salvează IP, deblochează)

   Toată logica reală (BLE) rulează pe Python; aici doar afişăm starea.
   ============================================================ */

(function () {
  'use strict';

  // Intervalul de polling al job-ului de provisioning.
  const JOB_POLL_MS = 800;

  // Referinţe DOM — rezolvate la init.
  let el = {};

  // Hub-ul selectat curent: { name, address, rssi }
  let selectedDevice = null;
  // Timer-ul de polling activ.
  let pollTimer = null;
  // Rezultatul ultimului job reuşit (pentru pasul "Conectare").
  let lastResult = null;

  // ---------- Helpers ----------

  function show(node) { if (node) node.hidden = false; }
  function hide(node) { if (node) node.hidden = true; }

  /**
   * Parsează răspunsul ca JSON. Dacă serverul a întors altceva (ex: pagină
   * 404 HTML), dă o eroare lizibilă în loc de "JSON.parse: unexpected...".
   */
  async function readJSON(r) {
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      if (r.status === 404) throw new Error('Endpoint indisponibil (404).');
      throw new Error('Răspuns invalid de la server (HTTP ' + r.status + ').');
    }
  }

  /**
   * Comută pasul vizibil al fluxului:
   * 'scan' | 'form' | 'working' | 'done' | 'connected'.
   */
  function setStep(step) {
    el.flow.dataset.step = step;
    el.flow.querySelectorAll('[data-setup-section]').forEach((sec) => {
      sec.hidden = sec.dataset.setupSection !== step;
    });
  }

  /** Blochează / deblochează interacţiunea cu animaţie de loading. */
  function setBusy(busy) {
    el.flow.dataset.busy = busy ? 'true' : 'false';
  }

  function showError(msg) {
    el.errorMsg.textContent = msg || 'A apărut o eroare.';
    show(el.error);
  }

  function clearError() {
    hide(el.error);
  }

  /** Mapează RSSI (dBm) la puterea semnalului 1..3 pentru indicatorul vizual. */
  function rssiToStrength(rssi) {
    if (rssi >= -55) return 3;
    if (rssi >= -75) return 2;
    return 1;
  }

  // ---------- Pasul 1: Scanare BLE ----------

  async function scanForHubs() {
    clearError();
    el.btnScan.disabled = true;
    el.btnScan.querySelector('.btn__label').textContent = 'Se scanează…';
    el.scanHint.textContent = 'Căutare hub-uri Bluetooth în apropiere…';
    hide(el.deviceList);

    try {
      const r = await fetch('/api/setup/scan', { method: 'POST' });
      const j = await readJSON(r);
      if (!r.ok) throw new Error(j.error || 'Scanare eşuată.');
      renderDevices(j.devices || []);
    } catch (e) {
      showError('Scanare eşuată: ' + e.message);
      el.scanHint.textContent = 'Apasă „Scanează Bluetooth" pentru a reîncerca.';
    } finally {
      el.btnScan.disabled = false;
      el.btnScan.querySelector('.btn__label').textContent = 'Scanează din nou';
    }
  }

  /** Construieşte lista de dispozitive găsite. */
  function renderDevices(devices) {
    el.deviceList.innerHTML = '';

    if (!devices.length) {
      el.scanHint.textContent =
        'Niciun hub găsit. Verifică dacă hub-ul este pornit şi reîncearcă.';
      return;
    }

    el.scanHint.textContent =
      devices.length + ' hub găsit. Selectează-l pentru a continua.';

    devices.forEach((dev) => {
      const li = document.createElement('li');
      const strength = rssiToStrength(dev.rssi);

      // <button> ca element interactiv accesibil în interiorul <li>.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'device-item';
      btn.innerHTML = `
        <span class="device-item__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 7 l10 10 -5 5 V2 l5 5 L7 17"/>
          </svg>
        </span>
        <span class="device-item__info">
          <span class="device-item__name"></span>
          <span class="device-item__addr"></span>
        </span>
        <span class="device-item__rssi">
          <span class="device-item__signal" data-strength="${strength}">
            <span></span><span></span><span></span>
          </span>
          ${dev.rssi} dBm
        </span>`;
      // Text injectat separat — evită orice problemă de escaping.
      btn.querySelector('.device-item__name').textContent = dev.name;
      btn.querySelector('.device-item__addr').textContent = dev.address;

      btn.addEventListener('click', () => selectDevice(dev));
      li.appendChild(btn);
      el.deviceList.appendChild(li);
    });

    show(el.deviceList);
  }

  // ---------- Pasul 2: Selectare hub + formular ----------

  function selectDevice(dev) {
    selectedDevice = dev;
    el.selectedName.textContent = dev.name + '  ·  ' + dev.address;
    clearError();
    setStep('form');
  }

  function backToScan() {
    selectedDevice = null;
    clearError();
    setStep('scan');
  }

  // ---------- Pasul 3: Trimitere credenţiale + polling ----------

  async function submitProvision(ev) {
    ev.preventDefault();
    clearError();

    if (!selectedDevice) {
      showError('Niciun hub selectat.');
      return;
    }

    const ssid = el.ssid.value.trim();
    const password = el.pass.value;

    if (!ssid) {
      showError('Introdu numele reţelei WiFi (SSID).');
      el.ssid.focus();
      return;
    }

    // Trecem la pasul de loading şi blocăm interfaţa.
    setStep('working');
    setBusy(true);
    el.workingTitle.textContent = 'Se conectează hub-ul la reţea…';
    el.workingMsg.textContent = 'Transmitem credenţialele prin Bluetooth.';

    try {
      const r = await fetch('/api/setup/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: selectedDevice.address,
          ssid: ssid,
          password: password,
        }),
      });
      const j = await readJSON(r);
      if (!r.ok) throw new Error(j.error || 'Provisioning eşuat.');

      // Pornim polling-ul pe job-ul returnat.
      pollJob(j.job.id);
    } catch (e) {
      failProvision('Nu s-a putut porni transmiterea: ' + e.message);
    }
  }

  /** Interoghează periodic starea job-ului de provisioning. */
  function pollJob(jobId) {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/setup/job/' + jobId, { cache: 'no-store' });
        const j = await readJSON(r);
        if (!r.ok) throw new Error(j.error || 'Job inexistent.');

        // Actualizăm textul de loading cu mesajul curent de la backend.
        if (j.message) el.workingMsg.textContent = j.message;

        if (j.status === 'success') {
          stopPolling();
          succeedProvision(j);
        } else if (j.status === 'error') {
          stopPolling();
          failProvision(j.message || 'Hub-ul nu s-a putut conecta.');
        }
        // pending / scanning / connecting / waiting → continuăm polling-ul.
      } catch (e) {
        stopPolling();
        failProvision('Pierdere contact cu serverul: ' + e.message);
      }
    }, JOB_POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /** Job reuşit — afişăm pasul de succes cu butonul "Conectare". */
  function succeedProvision(job) {
    lastResult = { ip: job.hub_ip, ssid: job.ssid };
    setBusy(false);
    el.doneMsg.textContent =
      'Hub-ul este online în reţea. Adresă IP: ' + (job.hub_ip || '—');
    setStep('done');
  }

  /** Job eşuat — deblocăm interfaţa şi întoarcem la formular cu eroare. */
  function failProvision(msg) {
    stopPolling();
    setBusy(false);
    setStep('form');
    showError(msg);
  }

  // ---------- Pasul 4: Conectare (cod de acces + salvare IP) ----------

  /**
   * Butonul "Conectare": cere întâi codul de acces (dialog), apoi — după
   * cod corect — salvează IP-ul hub-ului şi deblochează taburile.
   */
  function confirmConnect() {
    if (!lastResult || !lastResult.ip) {
      showError('Lipseşte adresa IP a hub-ului.');
      return;
    }
    clearError();
    // Codul de acces e obligatoriu înainte de a finaliza conectarea.
    if (window.Dropwise && window.Dropwise.openAuthDialog) {
      window.Dropwise.openAuthDialog(doConnect);
    } else {
      doConnect();
    }
  }

  /** Finalizează conectarea — rulat după ce codul a fost acceptat. */
  async function doConnect() {
    el.btnConnect.disabled = true;
    try {
      const r = await fetch('/api/setup/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: lastResult.ip, ssid: lastResult.ssid }),
      });
      const j = await readJSON(r);
      if (!r.ok) throw new Error(j.error || 'Salvare eşuată.');

      // Deblocăm celelalte taburi.
      if (window.Dropwise && window.Dropwise.unlockTabs) {
        window.Dropwise.unlockTabs();
      }
      el.flow.dataset.provisioned = 'true';

      // Tab-ul Initial Setup îşi schimbă aspectul în cardul de stare
      // "hub conectat" — vizibil la revenirea ulterioară pe acest tab.
      renderConnected(lastResult.ip, lastResult.ssid);

      // Trecem utilizatorul direct la tab-ul Monitorizare.
      if (window.Dropwise && window.Dropwise.activateTab) {
        window.Dropwise.activateTab('monitor');
      }
    } catch (e) {
      showError('Conectare eşuată: ' + e.message);
      el.btnConnect.disabled = false;
    }
  }

  /** Afişează cardul de stare "hub conectat" cu IP-ul şi reţeaua salvate. */
  function renderConnected(ip, ssid) {
    if (el.connectedIp) el.connectedIp.textContent = ip || '—';
    if (el.connectedSsid) el.connectedSsid.textContent = ssid || '—';
    clearError();
    setStep('connected');
  }

  /** "Reconfigurează" — reia fluxul de detecţie BLE de la scanare. */
  function reconfigure() {
    selectedDevice = null;
    lastResult = null;
    el.btnConnect.disabled = false;
    el.ssid.value = '';
    el.pass.value = '';
    el.deviceList.innerHTML = '';
    hide(el.deviceList);
    el.scanHint.textContent =
      'Apasă „Scanează Bluetooth" pentru a căuta hub-uri în apropiere.';
    clearError();
    setStep('scan');
  }

  // ---------- Init ----------

  function init() {
    const flow = document.getElementById('setup-flow');
    if (!flow) return;   // nu suntem pe pagina dashboard

    el = {
      flow: flow,
      btnScan: document.getElementById('btn-scan'),
      deviceList: document.getElementById('device-list'),
      scanHint: document.getElementById('scan-hint'),
      selectedName: document.getElementById('selected-device-name'),
      form: document.getElementById('provision-form'),
      ssid: document.getElementById('wifi-ssid'),
      pass: document.getElementById('wifi-pass'),
      btnBack: document.getElementById('btn-back'),
      btnProvision: document.getElementById('btn-provision'),
      workingTitle: document.getElementById('working-title'),
      workingMsg: document.getElementById('working-msg'),
      doneMsg: document.getElementById('done-msg'),
      btnConnect: document.getElementById('btn-connect'),
      btnReconfigure: document.getElementById('btn-reconfigure'),
      connectedIp: document.getElementById('connected-ip'),
      connectedSsid: document.getElementById('connected-ssid'),
      error: document.getElementById('setup-error'),
      errorMsg: document.getElementById('setup-error-msg'),
    };

    el.btnScan.addEventListener('click', scanForHubs);
    el.btnBack.addEventListener('click', backToScan);
    el.form.addEventListener('submit', submitProvision);
    el.btnConnect.addEventListener('click', confirmConnect);
    el.btnReconfigure.addEventListener('click', reconfigure);

    // Dacă hub-ul e deja configurat (revenire pe pagină), tab-ul afişează
    // direct cardul de stare "conectat". Valorile IP/SSID sunt deja
    // pre-randate de server în HTML — nu le suprascriem.
    if (flow.dataset.provisioned === 'true') {
      setStep('connected');
    } else {
      setStep('scan');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

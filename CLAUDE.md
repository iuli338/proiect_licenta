# Dropwise

Sistem de irigare inteligentă pentru plantele de apartament: un **dashboard web Flask**
+ un **hub ESP32** + **noduri-senzor ESP32**.

Esenţialul:
- **Provisioning BLE** — hub-ul se configurează prin Bluetooth (cu callback HTTP după
  conectare, fiindcă BLE-ul pică în timpul `WiFi.begin`), apoi trece pe WiFi (vezi
  `ble_provisioning.py`, `routes/setup.py`).
- **Autentificare prin cod de acces** — cookie HttpOnly + header `X-Access-Code`;
  endpoint-urile private răspund 404 fără cod (`auth.py`).
- **Wizard de configurare per nod** — plantă + sol + culoare, din catalog editabil
  (`static/nodes-wizard.js`, `data/catalog.json`).
- **Model + regulator parametrizate** — modelul de sol (ordin 1, K + τ) identificat
  din date experimentale (vezi `misc/`); PI acordat IMC pe plantă (setpoint + λ).
  Sol → parametrii modelului, plantă → parametrii regulatorului. Pagina nouă
  "Parametri" permite editarea manuală a oricărui câmp (`static/nodes-params.js`).
- **Persistenţă pe hub în EEPROM AT24C256 (I2C, 32 KB)** — config + parametri +
  statistici per port, scrise prin endpoint-uri noi pe firmware (`hub_storage.ino`,
  `hub_http_node.ino`). Bus I2C partajat cu OLED-ul (0x50 vs 0x3C).
- **Moduri de test** — `DROPWISE_BLE_MODE=sim` şi `DROPWISE_HUB_MODE=mock` permit
  rularea completă fără hardware.
- **Build desktop** — `build_exe.bat` împachetează aplicaţia ca `.exe` (PyInstaller +
  pywebview).

## Reguli (a nu se uita niciodată)

- **NU reseta `data/state.json` după teste** — e sursa de adevăr a dashboard-ului
  şi e gitignored. Lasă-l cu datele lui.
- **Endpoint privat = `@login_required`** (din `routes/pages.py`); fără cod răspunde
  **404**, nu 401 — ascunde existenţa rutei. Endpoint public DOAR pentru date de
  referinţă citite înainte de cod: `/api/catalog`, `/api/auth`, `/api/auth/status`.
- **Codul de acces** circulă: cookie HttpOnly `dropwise_code` → header `X-Access-Code`
  spre hub. În mock se compară cu `TEST_ACCESS_CODE = "284095"`; în real hub-ul decide.
- **Validează `node_name` faţă de `VALID_NODE_NAMES`** (`P1/P2/P3`) la începutul
  fiecărui handler de nod → `400` dacă e invalid.
- **`core.py` nu importă nimic din restul aplicaţiei** — evită importurile circulare.
  Toate blueprint-urile importă din `core`, nu invers.
- **Stare scrisă atomic** prin `save_state()` (`.tmp` + rename). Nu scrie direct în
  `STATE_FILE`.
- **Rute noi** intră într-un blueprint din `routes/`, nu în `app.py`; se înregistrează
  prin `register_blueprints`.
- **Căi de fişiere** prin constantele din `core.py` (`BUNDLE_DIR` resurse read-only,
  `BASE_DIR` date persistente) — nu hardcoda; build-ul `.exe` depinde de asta.
- **Totul trebuie să meargă fără hardware**: orice cod nou de hub/BLE respectă
  `DROPWISE_HUB_MODE=mock` şi `DROPWISE_BLE_MODE=sim`.
- **Firmware ESP**: fişierele `.ino` dintr-un sketch sunt concatenate de Arduino IDE
  — la editare ai grijă la acolade şi la funcţii întregi, nu tăia între intervale.
- **EEPROM AT24C256**: layout versionat prin header `DROPv0X` la offset 0x0000.
  La schimbarea structurilor (`NodeConfig`/`RegParams`/`NodeStats`) incrementează
  `EEPROM_LAYOUT_VERSION` ca să se zeroizeze automat slot-urile vechi corupte.
  Page write de 64 B + delay 10 ms (NU ACK polling — uneori dă fals pe AT24C);
  retry 3× pe NACK fiindcă bus-ul I2C e partajat cu OLED-ul (drawCircles).
- **Comentarii şi cod în română**, ca restul proiectului. Mesaje de commit scurte,
  la subiect, fără umplutură şi fără `Co-Authored-By`.

## Working tree

```
LICENTA/
├── app.py                      # punctul de intrare Flask, înregistrează blueprint-urile
├── core.py                     # stare (load/save state.json), căi, constante
├── auth.py                     # cod de acces: verify_code, require_code, cookie/header
├── ble_provisioning.py         # provisioning BLE (bleak/GATT), mod sim sau real
├── node_config.py              # configurarea nodurilor
├── run_app.py                  # lansator desktop (pywebview)
├── make_icon.py                # generează favicon-ul
├── build_exe.bat               # build .exe (PyInstaller)
├── Dropwise.spec               # spec PyInstaller
├── requirements.txt
├── .env.example
├── README.md
├── ATTRIBUTIONS.md
│
├── routes/                     # blueprint-uri Flask
│   ├── __init__.py
│   ├── pages.py                # paginile (home, dashboard)
│   ├── setup.py                # provisioning / setup iniţial
│   ├── hub.py                  # API hub (status, watering)
│   └── nodes.py                # API noduri + catalog
│
├── data/
│   ├── catalog.json            # catalog editabil: plante / soluri / culori
│   └── state.json              # starea persistată (gitignored)
│
├── misc/                       # anexă licenţă (NU intră în aplicaţie)
│   ├── soil_data_complete.csv  # 10 zile de date senzor cu 2 udări controlate
│   ├── identificare_model.py   # fitting ordin 1 + acordare IMC (numpy)
│   └── model_regulator.md      # sinteză: date → model → regulator
│
├── templates/
│   ├── index.html              # pagina home
│   ├── dashboard.html          # shell-ul SPA
│   └── tabs/                   # partial-uri Jinja per tab
│       ├── setup.html
│       ├── monitor.html
│       ├── nodes.html
│       ├── control.html
│       └── settings.html
│
├── static/
│   ├── dashboard.{js,css}      # shell: switching taburi, blocare taburi
│   ├── auth.{js,css}           # dialog cod de acces
│   ├── setup.{js,css}          # flux de setup iniţial
│   ├── control.{js,css}        # tab Control
│   ├── nodes-core.js           # noduri: nucleu (stare, polling, init)
│   ├── nodes-grid.js           # noduri: grilă carduri + card stare hub
│   ├── nodes-wizard.js         # noduri: wizard de configurare
│   ├── nodes-stats.js          # noduri: statistici per nod + rutare hash
│   ├── nodes-params.js         # noduri: pagina Parametri model + regulator
│   ├── nodes.css
│   ├── global_styles.css       # variabile + stiluri globale + btn-spinner
│   ├── dashboard_theme.css
│   ├── index.css
│   ├── plants/                 # imagini plante (catalog)
│   └── soils/                  # imagini soluri (catalog)
│
└── cod esp arduino ide/        # firmware ESP32 (sketch-uri Arduino multi-fişier)
    ├── esp32_hub_v6/
    │   ├── esp32_hub_v6.ino    # setup/loop hub + constante layout EEPROM
    │   ├── hub_auth.ino        # cod de acces pe hub
    │   ├── hub_display.ino     # ecran OLED
    │   ├── hub_eeprom.ino      # driver AT24C256 (I2C, page write, retry)
    │   ├── hub_espnow.ino      # ESP-NOW către noduri
    │   ├── hub_http.ino        # server HTTP + CORS (status, water, toggle)
    │   ├── hub_http_node.ino   # endpoint-uri /node/Pi/config|stats|forget
    │   ├── hub_nvs.ino         # persistenţă NVS (doar credenţiale WiFi)
    │   ├── hub_provisioning.ino# provisioning BLE + rute HTTP normal mode
    │   ├── hub_storage.ino     # layout EEPROM: header DROPv02 + slot-uri
    │   └── hub_watering.ino    # logica de udare
    └── esp32_node_v4/
        └── esp32_node_v4.ino   # firmware nod-senzor
```

# Dropwise

Sistem de irigare inteligentă pentru plantele de apartament: un **dashboard web Flask**
+ un **hub ESP32** + **noduri-senzor ESP32**.

Esenţialul:
- **Provisioning BLE** — nodurile şi hub-ul se configurează prin Bluetooth, apoi hub-ul
  trece pe WiFi (vezi `ble_provisioning.py`, `routes/setup.py`).
- **Autentificare prin cod de acces** — cookie HttpOnly + header `X-Access-Code`;
  endpoint-urile private răspund 404 fără cod (`auth.py`).
- **Wizard de configurare per nod** — plantă + sol + culoare, din catalog editabil
  (`static/nodes-wizard.js`, `data/catalog.json`).
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
│   ├── nodes-stats.js          # noduri: statistici per nod
│   ├── nodes.css
│   ├── global_styles.css       # variabile + stiluri globale
│   ├── dashboard_theme.css
│   ├── index.css
│   ├── plants/                 # imagini plante (catalog)
│   └── soils/                  # imagini soluri (catalog)
│
└── cod esp arduino ide/        # firmware ESP32 (sketch-uri Arduino multi-fişier)
    ├── esp32_hub_v6/
    │   ├── esp32_hub_v6.ino    # setup/loop hub
    │   ├── hub_auth.ino        # cod de acces pe hub
    │   ├── hub_display.ino     # ecran
    │   ├── hub_espnow.ino      # ESP-NOW către noduri
    │   ├── hub_http.ino        # server HTTP + CORS
    │   ├── hub_nvs.ino         # persistenţă NVS
    │   ├── hub_provisioning.ino# provisioning BLE
    │   └── hub_watering.ino    # logica de udare
    └── esp32_node_v4/
        └── esp32_node_v4.ino   # firmware nod-senzor
```

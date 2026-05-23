# Dropwise

Sistem inteligent de irigare pentru plante de apartament. Hub ESP32 + până la
3 noduri senzori, controlate dintr-un dashboard web. Lucrare de licență —
Automatică și Informatică Aplicată.

## Arhitectură

```
Browser ──HTTP──> Flask (app.py) ──┬── BLE (bleak) ────> ESP32 HUB    [provisioning]
                                   └── HTTP proxy ─────> ESP32 HUB    [operare]
                                                            │  │
                                                            │  └── I²C ──> AT24C256 (32KB)
                                                            │              [config + params
                                                            │               + stats per port]
                                                          ESP-NOW
                                                            │
                                              ESP32 NODE x3 (senzori, valve)
```

- **Dashboard (Flask)** — server web local; nu vorbește niciodată direct cu
  hardware-ul din browser, totul trece prin backend Python.
- **Hub (ESP32)** — server HTTP în rețea + coordonator ESP-NOW pentru noduri.
  Persistă configul + parametrii regulatorului + statisticile pentru fiecare
  port în EEPROM-ul extern AT24C256 (I²C). Layout versionat cu header `DROPv0X`.
- **Noduri (ESP32)** — câte unul per ghiveci; comunică cu hub-ul prin ESP-NOW.

## Componente

| Cale | Rol |
|---|---|
| `app.py` | Server Flask: înregistrează blueprint-urile, încarcă `.env` |
| `core.py` | Stare persistentă (`state.json`, atomic write), căi, constante |
| `auth.py` | Cod de acces: cookie HttpOnly + header `X-Access-Code` |
| `ble_provisioning.py` | Detecție BLE + provisioning WiFi; sim / real (bleak) |
| `node_config.py` | Catalog, derivare model + regulator, send config la hub |
| `routes/` | Blueprint-uri Flask: `pages`, `setup`, `hub`, `nodes` |
| `templates/` | `index.html`, `dashboard.html` + `tabs/*.html` (Jinja2) |
| `static/` | CSS modular + JS per tab |
| `data/catalog.json` | Catalog editabil: plante / soluri / culori |
| `data/state.json` | Stare persistentă (IP hub, provisioning, config noduri) |
| `misc/` | Anexă licență: date experimentale + identificare model |
| `cod esp arduino ide/esp32_hub_v6/` | Firmware hub (10 fișiere `.ino`) |
| `cod esp arduino ide/esp32_node_v4/` | Firmware nod senzor |

CSS: `global_styles.css` (design tokens) → `dashboard.css` → `dashboard_theme.css`
(temă dark, suprascrie token-uri pe `.page-dashboard`). JS per tab: `setup.js`,
`control.js`, peste `dashboard.js` (switching taburi + polling). Pentru tabul
Noduri sunt 5 module care lucrează pe namespace-ul `window.Dropwise.nodes`:
`nodes-core.js` (stare + polling), `nodes-grid.js` (grila), `nodes-wizard.js`
(configurare), `nodes-stats.js` (statistici + rutare hash), `nodes-params.js`
(pagina Parametri model + regulator cu mod editare).

## Provisioning BLE

ESP32 are WiFi și BLE pe același cip. Hub-ul are două moduri, alese la boot
după existența credențialelor în NVS (flash intern):

1. **Provisioning** (fără credențiale) — server GATT BLE numit `Dropwise HUB`,
   LED intern palpâie. Primește `SSID\nPAROLA` pe o caracteristică WRITE,
   testează WiFi, raportează `OK <ip>` / `FAIL <motiv>` pe o caracteristică
   NOTIFY, salvează în NVS, reboot.
2. **Normal** (credențiale prezente) — WiFi + ESP-NOW + HTTP + OLED. BLE oprit.

Reset provisioning: buton BOOT ținut ~3s la pornire, sau `POST /reset` din rețea.

Contract GATT (sursă unică de adevăr — `ble_provisioning.py`, replicat în firmware):

| | UUID |
|---|---|
| Service | `8e7c0001-9b1a-4f3e-a2d4-0c1b2a3d4e5f` |
| Char WRITE (credențiale) | `8e7c0002-...` |
| Char NOTIFY (status) | `8e7c0003-...` |

Provisioning-ul rulează asincron într-un thread; frontend-ul face polling pe un
`job_id` cât timp interfața e blocată cu animație de loading.

### Mod simulat vs real

`DROPWISE_BLE_MODE=sim` folosește `SimulatedHub` — reproduce temporizarea și
stările fără hardware, pentru dezvoltarea UI. `real` folosește `RealHub` (bleak).

## API REST

Toate endpoint-urile sub `/api/` sunt protejate cu codul de acces (cookie
HttpOnly `dropwise_code` + header `X-Access-Code` spre hub). Fără cod
valid răspund **404** (ascund existența rutei), nu 401.

**Publice** (citite înainte de cod):

| Endpoint | Rol |
|---|---|
| `POST /api/auth` | Verifică codul, setează cookie-ul |
| `GET  /api/auth/status` | Spune dacă sesiunea curentă e autentificată |
| `GET  /api/catalog` | Plante / soluri / culori — date de referință |

**Private** (cer cod valid):

| Endpoint | Rol |
|---|---|
| `POST /api/setup/scan` | Scanare BLE după hub-uri Dropwise |
| `POST /api/setup/provision` | Pornește transmiterea credențialelor → `job_id` |
| `GET  /api/setup/job/<id>` | Polling stare provisioning |
| `POST /api/setup/connect` | Salvează IP-ul hub-ului, deblochează taburile |
| `GET  /api/hub/status` | Proxy `/status` — porturi, pompă, valve, canal |
| `POST /api/hub/toggle/<pin>` | Proxy toggle GPIO (control manual) |
| `POST /api/hub/water/<start\|stop>/<port>` | Proxy ciclu de udare |
| `GET\|POST /api/node/<P>` | Citește / salvează configurația unui nod |
| `POST /api/node/<P>/preview` | Calculează parametri regulator, fără salvare |
| `GET  /api/node/<P>/stats` | Statistici (mock dacă `DROPWISE_HUB_MODE=mock`) |
| `GET  /api/node/job/<id>` | Polling job trimitere config la hub |
| `GET  /api/state` | Întreaga stare persistentă (debug / iniţializare UI) |

**Hub ESP32** expune direct (toate cer header `X-Access-Code`):

| Endpoint | Rol |
|---|---|
| `POST /auth` | Verificare cod (returnează 200 dacă e corect) |
| `GET  /status` | Stare porturi + pompă + valve + canal WiFi |
| `GET  /toggle/16..19` | Toggle GPIO direct (Control manual) |
| `GET\|POST /water/<start\|stop>/<1..3>` | Ciclu de udare |
| `POST /reset` | Șterge credențialele WiFi + reboot în BLE |
| `GET  /node/P<i>/config` | Configurația per port (din EEPROM AT24C256) |
| `POST /node/P<i>/config` | Salvează config + parametri + meta în EEPROM |
| `GET  /node/P<i>/stats` | Statistici (udări totale, ultima udare, etc.) |
| `POST /node/P<i>/forget` | Șterge complet slot-ul EEPROM (la deconectare) |

## Dashboard

Cinci taburi. Până la prima conectare reușită a hub-ului, doar **Initial Setup**
e accesibil; restul sunt blocate (`disabled` + lacăt). Codul de acces e cerut
printr-un dialog modal **după** conectare (nu există pagină separată de login).

- **Initial Setup** — fluxul de provisioning BLE → cod de acces → conectare.
- **Monitorizare** — card de stare hub (online/offline + IP + canal WiFi) + grilă
  cu ghivecele și ultima citire de la senzori.
- **Noduri** — grilă cu carduri. Fiecare card are meniu (⋯) cu trei vederi:
  - **Wizard de configurare** (plantă → sol → sumar → culoare → trimitere).
  - **Statistici** (data configurării, total udări, ml livrați).
  - **Parametri** (model identificat + acordare regulator; buton „Editează"
    pentru ajustare manuală a oricărui câmp, cu avertisment „pe propriul
    risc"). Sub-vederile sunt rutate prin hash: `#nodes/P1/config`, `/stats`,
    `/params`.
- **Control manual** — toggle direct pompă/valve + udare per port cu diagramă
  hidraulică. Dialog de avertizare la intrare (riscul de a defecta echipamentul).
- **Setări** — placeholder pentru funcţionalităţi viitoare.

## Modelul de proces + regulator

Procesul (umiditatea solului dintr-un ghiveci) e identificat ca **ordin 1**
din 10 zile de date experimentale (vezi `misc/soil_data_complete.csv`):

```
h(t) = h_inf + (h0 − h_inf) · e^(−t/τ)
```

- **τ** (constanta de timp a uscării) — vine din **retenţia solului**.
- **K** (câștigul, % umiditate / ml) — fixat în zona de operare (proces ușor
  neliniar, corectat de termenul integral al PI-ului).
- **Setpoint + λ** (agresivitatea reglării) — vin din **necesarul de apă al
  plantei** (`water_need`).

**Acordare PI prin IMC** (Internal Model Control) cu un singur parametru λ:

```
Kp = τ / (K · λ)        Ki = Kp / τ
```

```
   SOL    ──► parametrii MODELULUI       (K, τ)
   PLANTĂ ──► parametrii REGULATORULUI   (setpoint, λ ─► Kp, Ki)
```

Detalii + script de fitting (numpy, fără scipy): `misc/identificare_model.py` și
sinteza completă în `misc/model_regulator.md`. Pe firmware, parametrii (împreună
cu configul plantei și statisticile) sunt persistaţi în **EEPROM AT24C256** prin
endpoint-urile `/node/P<i>/config` și `/stats`.

## Instalare

```sh
pip install -r requirements.txt
copy .env.example .env      # apoi editează .env
python app.py               # http://127.0.0.1:5000
```

Cod de acces implicit: **`284095`** — cerut printr-un dialog modal după ce
hub-ul e conectat. În modul `mock` codul e comparat local cu această
constantă; în modul `real` hub-ul ESP32 e cel care validează (`HUB_ACCESS_CODE`
în `esp32_hub_v6.ino`). Schimbarea presupune modificarea firmware-ului.

### Build .exe desktop

`build_exe.bat` împachetează aplicația cu PyInstaller într-o fereastră nativă
(pywebview). Rezultat: `dist/Dropwise/` — se distribuie tot folderul.

### Configurare (`.env`)

| Variabilă | Implicit | Rol |
|---|---|---|
| `DROPWISE_BLE_MODE` | `sim` | `sim` (hub simulat) / `real` (ESP32 prin bleak) |
| `DROPWISE_BLE_SCAN_DURATION` | `6` | Durata scan-ului BLE (s) |
| `DROPWISE_BLE_CONFIRM_TIMEOUT` | `30` | Timeout confirmare WiFi (s) |
| `DROPWISE_HUB_MODE` | `mock` | `mock` (statistici şi config simulate) / `real` (HTTP la hub) |
| `DROPWISE_HUB_ACCESS_CODE` | `284095` | Cod folosit de backend la trimiterea config-ului către hub (fallback peste cookie-ul utilizatorului) |
| `DROPWISE_SECRET_KEY` | `dev-only-...` | Cheie sesiune Flask |
| `DROPWISE_PORT` | `5000` | Portul serverului |

## Firmware ESP32

Arduino IDE. Hub-ul necesită bibliotecile incluse în pachetul board-ului ESP32
(`WiFi`, `WebServer`, `HTTPClient`, `Preferences`, `Wire`, `BLEDevice`/`BLEServer`/
`BLEUtils`/`BLE2902`, `esp_now`/`esp_wifi`) plus `Adafruit_SSD1306` + `Adafruit_GFX`
de la Adafruit. Dacă upload-ul eșuează „sketch too big":
**Tools → Partition Scheme → Huge APP (3MB No OTA)**.

Numele nodului se setează per placă în `esp32_node_v4.ino` (`NODE_NAME` =
`"P1"` / `"P2"` / `"P3"`).

**Provisioning BLE** are o particularitate fizică: la `WiFi.begin()` ESP-ul
repartiționează radio-ul (BLE și WiFi împart antena), iar conexiunea BLE
existentă pică brutal. De-aceea hub-ul primește acum un al treilea câmp în
payload (URL-ul unui HTTP server temporar pe PC) și trimite confirmarea de
conectare prin HTTP, nu prin BLE notify (care nu mai apucă să ajungă). Formatul
WRITE-ului GATT e: `SSID\nPAROLA\nCALLBACK_URL`.

## Hardware hub

| GPIO | Funcție |
|---|---|
| 16 | Pompă |
| 17 / 18 / 19 | Valve port 1 / 2 / 3 |
| 25-26, 23-27, 32-33 | Detecție conector port 1 / 2 / 3 |
| 21 / 22 | I²C: OLED SSD1306 (`0x3C`) + EEPROM AT24C256 (`0x50`) |
| 2 | LED stare (palpâie în provisioning) |
| 0 | Buton BOOT (reset provisioning) |

EEPROM-ul AT24C256 (32 KB, I²C, partajează bus-ul cu OLED-ul) păstrează
persistent pentru fiecare port: configuraţia plantei + parametrii regulatorului
+ statisticile. Layout-ul e versionat prin header `DROPv0X` la offset 0; la
modificarea structurilor, incrementarea versiunii zeroizează automat slot-urile
vechi. Detalii în `cod esp arduino ide/esp32_hub_v6/hub_storage.ino`.

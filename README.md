# Dropwise

Sistem inteligent de irigare pentru plante de apartament. Hub ESP32 + până la
3 noduri senzori, controlate dintr-un dashboard web. Lucrare de licență —
Automatică și Informatică Aplicată.

## Arhitectură

```
Browser ──HTTP──> Flask (app.py) ──┬── BLE (bleak) ──> ESP32 HUB   [provisioning]
                                   └── HTTP proxy ───> ESP32 HUB   [operare]
                                                          │
                                                       ESP-NOW
                                                          │
                                              ESP32 NODE x3 (senzori)
```

- **Dashboard (Flask)** — server web local; nu vorbește niciodată direct cu
  hardware-ul din browser, totul trece prin backend Python.
- **Hub (ESP32)** — server HTTP în rețea + coordonator ESP-NOW pentru noduri.
- **Noduri (ESP32)** — câte unul per ghiveci; comunică cu hub-ul prin ESP-NOW.

## Componente

| Cale | Rol |
|---|---|
| `app.py` | Server Flask: auth cu sesiune, API REST, proxy HTTP către hub |
| `ble_provisioning.py` | Detecție BLE + provisioning WiFi; backend simulat și real (bleak) |
| `templates/` | `index.html`, `login.html`, `dashboard.html` (Jinja2) |
| `static/` | CSS modular + JS per tab |
| `data/state.json` | Stare persistentă (IP hub, provisioning, config noduri) |
| `cod esp arduino ide/esp32_hub_v6/` | Firmware hub |
| `cod esp arduino ide/esp32_node_v4/` | Firmware nod senzor |

CSS: `global_styles.css` (design tokens) → `dashboard.css` → `dashboard_theme.css`
(temă dark, suprascrie token-uri pe `.page-dashboard`). JS per tab: `setup.js`,
`control.js`, peste `dashboard.js` (switching taburi + polling).

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

Toate sub `/api/`, necesită sesiune autentificată.

| Endpoint | Rol |
|---|---|
| `POST /api/setup/scan` | Scanare BLE după hub-uri Dropwise |
| `POST /api/setup/provision` | Pornește transmiterea credențialelor → `job_id` |
| `GET /api/setup/job/<id>` | Polling stare provisioning |
| `POST /api/setup/connect` | Salvează IP-ul hub-ului, deblochează taburile |
| `GET /api/hub/status` | Proxy `/status` — porturi, pompă, valve, canal |
| `POST /api/hub/toggle/<pin>` | Proxy toggle GPIO (control manual) |
| `POST /api/hub/water/<start\|stop>/<port>` | Proxy ciclu de udare |
| `GET\|POST /api/node/<port>` | Citește / salvează configurația unui nod |

Hub-ul ESP32 expune: `GET /status`, `GET /toggle/16..19`,
`GET\|POST /water/<start|stop>/<1..3>`, `POST /reset`.

## Dashboard

Cinci taburi. Până la prima conectare reușită a hub-ului, doar **Initial Setup**
e accesibil; restul sunt blocate (`disabled` + lacăt).

- **Initial Setup** — fluxul de provisioning BLE.
- **Monitorizare** — stare hub și noduri în timp real.
- **Configurare nod** — tip plantă / sol per ghiveci.
- **Control manual** — toggle direct pompă/valve + udare per port cu diagramă
  hidraulică. Dialog de avertizare la intrare (riscul de a defecta echipamentul).
- **Setări** — WIP.

## Instalare

```sh
pip install -r requirements.txt
copy .env.example .env      # apoi editează .env
python app.py               # http://127.0.0.1:5000
```

Login implicit: `admin` / `admin`.

### Build .exe desktop

`build_exe.bat` împachetează aplicația cu PyInstaller într-o fereastră nativă
(pywebview). Rezultat: `dist/Dropwise/` — se distribuie tot folderul.

### Configurare (`.env`)

| Variabilă | Implicit | Rol |
|---|---|---|
| `DROPWISE_BLE_MODE` | `sim` | `sim` (hub simulat) / `real` (ESP32 prin bleak) |
| `DROPWISE_BLE_SCAN_DURATION` | `6` | Durata scan-ului BLE (s) |
| `DROPWISE_BLE_CONFIRM_TIMEOUT` | `30` | Timeout confirmare WiFi (s) |
| `DROPWISE_SECRET_KEY` | `dev-only-...` | Cheie sesiune Flask |
| `DROPWISE_PORT` | `5000` | Portul serverului |

## Firmware ESP32

Arduino IDE. Hub-ul necesită: ESP32 BLE (din pachetul board), `Preferences`,
`Adafruit_SSD1306` + `Adafruit_GFX`. Dacă upload-ul eșuează „sketch too big":
**Tools → Partition Scheme → Huge APP (3MB No OTA)**.

Numele nodului se setează per placă în `esp32_node_v4.ino` (`NODE_NAME` =
`"P1"` / `"P2"` / `"P3"`).

## Hardware hub

| GPIO | Funcție |
|---|---|
| 16 | Pompă |
| 17 / 18 / 19 | Valve port 1 / 2 / 3 |
| 25-26, 23-27, 32-33 | Detecție conector port 1 / 2 / 3 |
| 21 / 22 | I²C OLED (SSD1306) |
| 2 | LED stare (palpâie în provisioning) |
| 0 | Buton BOOT (reset provisioning) |

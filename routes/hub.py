"""
Blueprint: Monitorizare + Control (proxy/mock hub)
==================================================
  GET  /api/hub/status              — starea hub-ului (mock sau proxy)
  GET  /api/hub/logs                — loguri (TODO)
  POST /api/hub/toggle/<pin>        — toggle GPIO (control manual)
  POST /api/hub/water/<act>/<port>  — ciclu de udare
"""

import time
from typing import Optional

from flask import Blueprint, jsonify, abort

try:
    import requests   # proxy către hub
except ImportError:
    requests = None

import auth
import node_config as nodes
from core import load_state
from routes.pages import login_required

bp = Blueprint("hub", __name__)


# ---------------------------------------------------------------- mock

# Momentul pornirii serverului — folosit de mock pentru a simula handshake-ul
# nodurilor (detectate fizic, dar neconfirmate încă) la prima deschidere.
_MOCK_START = time.time()
# Cât durează handshake-ul simulat (secunde) de la pornirea serverului.
_MOCK_HANDSHAKE_S = 15.0


def _mock_sensors(node_name: str) -> dict:
    """
    Cele 4 valori de la senzori, simulate per NUME NOD (stabile între
    polluri — un acelaşi nod = aceeaşi valoare la fiecare /status). În
    modul real vor veni din EEPROM/RAM-ul hub-ului, populate prin ESP-NOW.

    Câmpuri:
      - soil_moisture_pct   : umiditate sol, % (convertită din RAW)
      - air_temp_c          : temperatură aer, °C
      - air_humidity_pct    : umiditate aer, %
      - lux                 : lumină ambient, lx
    """
    # Sămânţă deterministă din numele nodului — valori stabile per port.
    seed = sum(ord(c) for c in node_name)
    # În mock, P3 are senzorul de luminozitate "lipsă" — ca să vedem badge-ul
    # "Lipseşte" în UI fără hardware real. Pe live, hub-ul trimite null când
    # NAN-ul de la nod indică senzor absent (vezi esp32_node_v4.ino).
    lux_value = None if node_name == "P3" else round(120.0 + (seed * 13 % 1880))
    return {
        "soil_moisture_pct":  round(35.0 + (seed * 7  % 41), 1),  # 35–75 %
        "air_temp_c":         round(20.0 + (seed * 11 % 6),  1),  # 20–26 °C
        "air_humidity_pct":   round(42.0 + (seed * 5  % 22), 1),  # 42–64 %
        "lux":                lux_value,                          # 120–2000 lx sau None pe P3
    }


def _mock_hub_status() -> dict:
    """
    Stare simulată a hub-ului pentru DROPWISE_HUB_MODE=mock.

    La prima deschidere a serverului, porturile 1 şi 2 sunt în handshake
    (physical=true, confirmed=false) câteva secunde, apoi devin conectate.
    Portul 3 rămâne gol.
    """
    state = load_state()
    EMPTY_PORTS = {3}
    in_handshake = (time.time() - _MOCK_START) < _MOCK_HANDSHAKE_S
    HANDSHAKE_PORTS = {1, 2} if in_handshake else set()

    ports = []
    for p in (1, 2, 3):
        if p in EMPTY_PORTS:
            # Slot fizic gol — niciun nod conectat.
            ports.append({
                "port": p, "physical": False, "confirmed": False,
                "name": None, "valve": False, "configured": False,
                "config": None, "sensors": None,
            })
            continue
        if p in HANDSHAKE_PORTS:
            # Nod detectat fizic, dar încă neconfirmat — handshake în curs.
            ports.append({
                "port": p, "physical": True, "confirmed": False,
                "name": None, "valve": False, "configured": False,
                "config": None, "sensors": None,
            })
            continue
        # Nod identificat. Cheia de configurare e NUMELE nodului, nu portul.
        node_name = f"P{p}"
        cfg = state["nodes"].get(node_name)
        sensors = _mock_sensors(node_name)
        port_data = {
            "port": p, "physical": True, "confirmed": True,
            "name": node_name, "valve": False,
            "configured": bool(cfg and cfg.get("configured")),
            "config": cfg or None,        # config inline — evită un fetch separat
            "sensors": sensors,
            "next_watering": None,        # populat mai jos pe noduri cu auto on
        }
        # Predicţia: doar pentru noduri cu auto-udare activată şi senzor ok.
        reg = (cfg or {}).get("regulator") or {}
        if cfg and cfg.get("configured") and reg.get("auto_watering_enabled"):
            # În mock simulăm "ultima udare" cu un offset determinist per nod
            # (ca să avem date diferite la fiecare card). Pe live va veni din
            # EEPROM-ul hub-ului (lastWatering epoch).
            seed = sum(ord(c) for c in node_name)
            minutes_since_last = ((seed * 53) % 600) + 30   # 30..630 min
            soil_h = sensors.get("soil_moisture_pct")
            pred = nodes.predict_next_watering(reg, soil_h, minutes_since_last)
            if pred:
                port_data["next_watering"] = {
                    "minutes_until": pred["minutes_until"],
                    "estimated_dose_ml": pred["estimated_dose_ml"],
                    "reason": pred["reason"],
                    "minutes_since_last": minutes_since_last,
                }
            # Stats simulate — frontend afişează "Ultima udare: acum X (Y ml)".
            now_ts = int(time.time())
            port_data["stats"] = {
                "last_watering": now_ts - minutes_since_last * 60,
                "last_dose_ml":  reg.get("target_dose_ml", 30),
                "total_waterings": 5 + (seed % 20),
                "total_ml": 150 + (seed % 200),
            }
        ports.append(port_data)
    # Ora curentă (server-side în mock) — pe live vine din RTC hub.
    now = time.localtime()
    return {
        "ports": ports, "channel": 6, "pump": False,
        "wateringPort": -1, "mock": True,
        # IP-ul hub-ului — pentru cardul de stare de pe Monitor.
        "ip": state["hub"].get("ip") or "192.168.1.50",
        "time": f"{now.tm_hour:02d}:{now.tm_min:02d}",
    }


# ---------------------------------------------------------------- endpoints

@bp.route("/api/hub/status")
@login_required
def api_hub_status():
    """
    Starea hub-ului. În mod 'mock' returnează o stare simulată; în 'real'
    face proxy către /status al ESP32.
    """
    state = load_state()

    if nodes.get_hub_mode() == "mock":
        return jsonify({"online": True, "data": _mock_hub_status()})

    hub_ip = state["hub"].get("ip")
    if not hub_ip:
        return jsonify({"online": False, "error": "hub_ip_not_set"}), 200
    if requests is None:
        return jsonify({"online": False, "error": "requests_not_installed"}), 500

    try:
        r = requests.get(f"http://{hub_ip}/status", timeout=1.5,
                         headers=auth.hub_headers())
        r.raise_for_status()
        data = r.json()

        # Detectare reboot hub: uptime scade brusc → invalidăm tot cache-ul
        # de config (poate s-a schimbat ce e în EEPROM între timp).
        global _LAST_HUB_UPTIME_MS
        new_uptime = int(data.get("uptime_ms") or 0)
        if new_uptime and new_uptime < _LAST_HUB_UPTIME_MS:
            _invalidate_all_node_cfg_cache()
        _LAST_HUB_UPTIME_MS = new_uptime

        # Îmbogăţim porturile cu configul real, citit din EEPROM-ul hub-ului
        # (sursa unică de adevăr pe live). Pe nodurile neconfirmate (slot
        # gol / handshake) sărim fetch-ul — nu există config relevant.
        # Configul vine din cache (TTL infinit, invalidat la POST sau reboot).
        headers = auth.hub_headers()
        for port in data.get("ports", []):
            name = port.get("name")
            if not name or not port.get("confirmed"):
                port["configured"] = False
                port["config"] = None
                continue
            cfg = _fetch_node_config_cached(hub_ip, name, headers)
            port["configured"] = bool(cfg and cfg.get("configured"))
            port["config"] = cfg or None
            # Stats vin embedded în răspunsul /config — expunem la nivel
            # de port ca să fie simetric cu mock-ul.
            if cfg and isinstance(cfg.get("stats"), dict):
                port["stats"] = cfg["stats"]
            # next_watering vine deja la nivel de port direct din firmware
            # (vezi handleStatus în hub_http.ino) — nu suprascriem.
        data.setdefault("ip", hub_ip)   # IP-ul hub-ului pentru cardul Monitor
        return jsonify({"online": True, "data": data})
    except requests.RequestException as e:
        return jsonify({"online": False, "error": str(e)}), 200


# Cache de config-uri per nod. Configurarea NU se schimbă decât prin POST,
# deci cache-ul e LUNG (fără TTL): un singur fetch per nod per sesiune, plus
# refetch când:
#   - utilizatorul trimite un POST (invalidate_node_cfg_cache);
#   - hub-ul s-a restartat (uptime scade — vezi mai jos);
#   - apare un nod nou care nu e în cache.
_NODE_CFG_CACHE: dict[str, dict] = {}
_LAST_HUB_UPTIME_MS: int = 0


def _fetch_node_config_cached(hub_ip: str, name: str,
                              headers: dict) -> Optional[dict]:
    """Întoarce configul unui nod din cache; face fetch DOAR dacă lipseşte."""
    cached = _NODE_CFG_CACHE.get(name)
    if cached is not None:
        return cached
    try:
        r = requests.get(
            f"http://{hub_ip}/node/{name}/config",
            timeout=1.5, headers=headers,
        )
        if r.status_code == 200:
            cfg = r.json()
            _NODE_CFG_CACHE[name] = cfg
            return cfg
    except requests.RequestException:
        pass
    return None


def invalidate_node_cfg_cache(name: str) -> None:
    """Şters din rute când trimitem un config nou (POST /api/node/<P>)."""
    _NODE_CFG_CACHE.pop(name, None)


def _invalidate_all_node_cfg_cache() -> None:
    _NODE_CFG_CACHE.clear()


@bp.route("/api/hub/time", methods=["POST"])
@login_required
def api_hub_set_time():
    """
    Setează ora RTC pe hub. Body: {"time": "HH:MM"}.
    În mock: validăm formatul şi simulăm succesul (nu putem schimba ora
    serverului). În live: proxy POST /time la hub cu X-Access-Code.
    """
    data = (abort if False else None)  # placeholder
    from flask import request
    payload = request.get_json(silent=True) or {}
    t = (payload.get("time") or "").strip()
    # Validare format strict HH:MM.
    if len(t) != 5 or t[2] != ":" or not (t[:2].isdigit() and t[3:].isdigit()):
        return jsonify({"error": "format invalid (HH:MM)"}), 400
    hh, mm = int(t[:2]), int(t[3:])
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return jsonify({"error": "valori in afara intervalului"}), 400

    if nodes.get_hub_mode() == "mock":
        # Mock-ul nu poate schimba ora serverului — confirmăm doar.
        return jsonify({"ok": True, "time": t, "mock": True})

    state = load_state()
    hub_ip = state["hub"].get("ip")
    if not hub_ip:
        return jsonify({"error": "hub_ip_not_set"}), 503
    if requests is None:
        return jsonify({"error": "requests_not_installed"}), 500
    try:
        r = requests.post(
            f"http://{hub_ip}/time",
            json={"time": t},
            headers=auth.hub_headers(),
            timeout=4,
        )
        if r.status_code != 200:
            return jsonify({"error": f"hub a raspuns {r.status_code}"}), 502
        return jsonify(r.json())
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502


@bp.route("/api/hub/logs")
@login_required
def api_hub_logs():
    """TODO: citirea logurilor de la hub. Pentru moment, placeholder."""
    return jsonify({
        "logs": [],
        "todo": "implementare reală — endpoint /logs pe hub",
    })


@bp.route("/api/hub/diagnostics")
@login_required
def api_hub_diagnostics():
    """
    Diagnostic la boot — log-ul cu I2C scan, status EEPROM/OLED/RTC,
    uptime curent. În mock returnăm date deterministe (utile pentru UI);
    în real facem proxy către /diagnostics pe hub.
    """
    state = load_state()

    if nodes.get_hub_mode() == "mock":
        return jsonify({
            "online": True,
            "data": {
                "uptime_ms": int((time.time() - _MOCK_START) * 1000),
                "oled": True,
                "eeprom": True,
                "rtc": False,
                "boot_log": (
                    "=== Dropwise HUB boot (mock) ===\n"
                    "Scanare I2C...\n"
                    "Adrese gasite: 0x3C, 0x50\n"
                    "EEPROM AT24C256 detectat la 0x50 (incercare 1) - OK\n"
                    "EEPROM layout OK\n"
                    "OLED  - OK\n"
                    "EEPROM - OK\n"
                    "RTC   - lipsa (optional)\n"
                ),
            },
        })

    hub_ip = state["hub"].get("ip")
    if not hub_ip:
        return jsonify({"online": False, "error": "hub_ip_not_set"}), 200
    if requests is None:
        return jsonify({"online": False, "error": "requests_not_installed"}), 500

    try:
        r = requests.get(f"http://{hub_ip}/diagnostics", timeout=3,
                         headers=auth.hub_headers())
        r.raise_for_status()
        return jsonify({"online": True, "data": r.json()})
    except requests.RequestException as e:
        return jsonify({"online": False, "error": str(e)}), 200


@bp.route("/api/hub/toggle/<int:pin>", methods=["POST"])
@login_required
def api_hub_toggle(pin):
    """Proxy /toggle/<pin> — pentru tab-ul de control manual."""
    state = load_state()
    hub_ip = state["hub"].get("ip")
    if not hub_ip or requests is None:
        return jsonify({"error": "hub_unavailable"}), 503
    try:
        r = requests.get(f"http://{hub_ip}/toggle/{pin}", timeout=1.5,
                         headers=auth.hub_headers())
        return jsonify(r.json()), r.status_code
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502


@bp.route("/api/hub/forget", methods=["POST"])
@login_required
def api_hub_forget():
    """
    "Deconectează şi uită" — şterge credenţialele WiFi de pe hub, reboot
    automat în mod provisioning, şi curăţă starea locală (IP, SSID,
    provisioned). După aceea, dashboard-ul revine la pasul de scanare BLE.

    IMPORTANT: cleanup-ul local se face DOAR după ce hub-ul a confirmat
    cu 200 — altfel UI-ul ar afişa "succes" chiar dacă comanda n-a ajuns.
    În mock: nu există hub fizic, curăţăm direct.
    """
    from core import save_state

    state = load_state()
    hub_ip = state["hub"].get("ip")

    if nodes.get_hub_mode() != "mock":
        if not hub_ip:
            return jsonify({"error": "hub_ip_not_set"}), 503
        if requests is None:
            return jsonify({"error": "requests_not_installed"}), 500
        try:
            # POST /reset pe firmware — handleResetProvisioning verifică
            # codul de acces, şterge NVS şi face ESP.restart(). Răspunde
            # 200 ÎNAINTE de reboot (vezi hub_http.ino).
            r = requests.post(
                f"http://{hub_ip}/reset",
                headers=auth.hub_headers(),
                timeout=4,
            )
        except requests.RequestException as e:
            # Hub-ul nu a confirmat — NU facem cleanup local.
            return jsonify({
                "error": f"Hub-ul nu răspunde ({e})."
            }), 502
        if r.status_code != 200:
            # 404 = cod de acces gresit; 500 = alta eroare.
            return jsonify({
                "error": f"Hub-ul a refuzat comanda (HTTP {r.status_code})."
            }), 502

    # Hub-ul a confirmat (sau suntem în mock) — acum putem face cleanup.
    state["hub"]["ip"] = None
    state["hub"]["ssid"] = None
    state["hub"]["provisioned"] = False
    save_state(state)
    # Invalidăm cache-ul de config noduri — datele vechi nu mai au sens.
    _invalidate_all_node_cfg_cache()
    return jsonify({"ok": True})


@bp.route("/api/hub/dose/<int:port>", methods=["POST"])
@login_required
def api_hub_dose(port):
    """
    Udare cu cantitate fixă pe un port — pentru testare/calibrare. Hub-ul
    întoarce 200 imediat cu durata estimată (ms); UI-ul detectează finalul
    prin polling pe /api/hub/status (wateringPort revine la -1).

    Body: {"ml": 50}
    """
    if port < 1 or port > 3:
        return jsonify({"error": "invalid port"}), 400
    from flask import request
    payload = request.get_json(silent=True) or {}
    ml = int(payload.get("ml") or 0)
    if ml < 1 or ml > 500:
        return jsonify({"error": "ml out of range (1..500)"}), 400

    if nodes.get_hub_mode() == "mock":
        # Mock: calculăm durata cu acelaşi debit ca firmware-ul (3.21 ml/s).
        dose_ms = int(ml * 1000 / 3.21)
        total_ms = 2000 + dose_ms + 1000  # valve open + dose + pump stop
        return jsonify({
            "status": "dosing",
            "port": port, "ml": ml,
            "dose_ms": dose_ms,
            "total_ms": total_ms,
            "mock": True,
        })

    state = load_state()
    hub_ip = state["hub"].get("ip")
    if not hub_ip or requests is None:
        return jsonify({"error": "hub_unavailable"}), 503
    try:
        r = requests.post(
            f"http://{hub_ip}/dose/{port}",
            params={"ml": ml},
            headers=auth.hub_headers(),
            timeout=4,
        )
        return jsonify(r.json()), r.status_code
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502


@bp.route("/api/hub/water/<action>/<int:port>", methods=["POST"])
@login_required
def api_hub_water(action, port):
    """Proxy /water/<start|stop>/<port>."""
    if action not in ("start", "stop"):
        abort(400)
    state = load_state()
    hub_ip = state["hub"].get("ip")
    if not hub_ip or requests is None:
        return jsonify({"error": "hub_unavailable"}), 503
    try:
        r = requests.post(
            f"http://{hub_ip}/water/{action}/{port}",
            timeout=1.5, headers=auth.hub_headers(),
        )
        return jsonify(r.json()), r.status_code
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502

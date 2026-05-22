"""
Dropwise — Dashboard backend
============================

Aplicaţie Flask scheletică pentru dashboard-ul sistemului de irigare.

Responsabilități:
  - autentificare cu sesiune (login admin/admin pentru test)
  - persistenţă locală în data/state.json
  - endpoints REST pentru fiecare tab al dashboard-ului
  - proxy către hub-ul ESP32 (pentru tab-ul de monitorizare)

Rulare:
    pip install flask requests
    python app.py
    → http://127.0.0.1:5000
"""

import json
import os
from pathlib import Path

# Încărcăm variabilele din fişierul .env ÎNAINTE de orice citire os.environ.
# Dacă python-dotenv lipseşte, aplicaţia funcţionează tot — cu valorile
# implicite din cod.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from flask import Flask, jsonify, render_template, request, abort

try:
    import requests  # pentru proxy către hub
except ImportError:
    requests = None

import ble_provisioning as ble  # modul de detecţie BLE + provisioning
import node_config as nodes      # cataloage plante/sol + config noduri
import auth                       # autentificare prin cod de acces + guard IP


# ---------------------------------------------------------------- config

import sys

# Sub PyInstaller (.exe) căile diferă:
#   - resursele bundle-uite (templates, static) stau în sys._MEIPASS
#   - datele care trebuie să persiste (state.json, .env) stau lângă .exe
# La rulare normală cu Python, ambele sunt folderul scriptului.
if getattr(sys, "frozen", False):
    BUNDLE_DIR = Path(sys._MEIPASS)            # resurse read-only
    BASE_DIR   = Path(sys.executable).parent   # lângă .exe
else:
    BUNDLE_DIR = Path(__file__).resolve().parent
    BASE_DIR   = BUNDLE_DIR

DATA_DIR  = BASE_DIR / "data"
STATE_FILE = DATA_DIR / "state.json"

# Cât timp rămâne valid cookie-ul cu codul de acces (în secunde)
SESSION_TIMEOUT = 60 * 60 * 8   # 8 ore

# Starea iniţială (creată la primul start, dacă fişierul lipseşte)
DEFAULT_STATE = {
    "hub": {
        # IP-ul hub-ului în reţeaua locală (după provisioning)
        "ip": None,
        # True după ce credenţialele WiFi au fost transmise prin BLE cu succes
        "provisioned": False,
        # SSID al reţelei la care a fost configurat (informativ)
        "ssid": None,
    },
    "nodes": {
        # Configuraţie per NOD, cheia = numele nodului ("P1", "P2", "P3").
        # Configuraţia aparţine nodului, nu portului — nodul poate fi mutat
        # pe alt slot fizic şi îşi păstrează planta/solul/culoarea.
        # Exemplu: "P1": { "plant": {...}, "soil": {...}, "color": "mint", ... }
    },
    "logs": [],   # loguri persistente (TODO: rotire)
}


# ---------------------------------------------------------------- app

app = Flask(__name__,
            static_folder=str(BUNDLE_DIR / "static"),
            template_folder=str(BUNDLE_DIR / "templates"))
# Cheia de sesiune din .env (DROPWISE_SECRET_KEY). Fallback pentru dezvoltare.
app.secret_key = os.environ.get("DROPWISE_SECRET_KEY",
                                "dev-only-change-in-production")
app.permanent_session_lifetime = SESSION_TIMEOUT


# ---------------------------------------------------------------- state IO

def load_state() -> dict:
    """Citește starea din JSON; dacă nu există, scrie defaultul și-l returnează."""
    DATA_DIR.mkdir(exist_ok=True)
    if not STATE_FILE.exists():
        save_state(DEFAULT_STATE)
        return json.loads(json.dumps(DEFAULT_STATE))   # copie
    try:
        with STATE_FILE.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        # Fişier corupt — rescriu cu default şi continui
        save_state(DEFAULT_STATE)
        return json.loads(json.dumps(DEFAULT_STATE))


def save_state(state: dict) -> None:
    """Scrie starea atomic (scriu într-un .tmp şi redenumesc)."""
    DATA_DIR.mkdir(exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    tmp.replace(STATE_FILE)


# ---------------------------------------------------------------- auth (cod de acces)
#
# Guard-ul `login_required` = `auth.require_code` — verifică codul din cookie
# şi răspunde 404 dacă lipseşte sau e greşit. Endpoint-urile publice (home,
# dashboard, /api/auth*) NU îl folosesc.

login_required = auth.require_code


# ---------------------------------------------------------------- routes: pagini

@app.route("/")
def home():
    """Pagina principală publică. Nu necesită autentificare."""
    return render_template("index.html")


@app.route("/api/auth", methods=["POST"])
def api_auth():
    """
    Verifică codul de acces (la apăsarea "Conectare"). Endpoint PUBLIC.
    La cod corect, salvează codul într-un cookie pe browserul clientului.
    """
    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip()

    state = load_state()
    hub_ip = state["hub"].get("ip")

    ok, msg = auth.verify_code(code, hub_ip)
    if not ok:
        return jsonify({"ok": False, "error": msg}), 401

    # Cod corect — îl punem în cookie. HttpOnly: nu e citibil din JS, dar
    # browserul îl trimite automat la fiecare cerere către server.
    resp = jsonify({"ok": True, "message": msg})
    resp.set_cookie(
        auth.ACCESS_COOKIE, code,
        max_age=SESSION_TIMEOUT, httponly=True, samesite="Lax",
    )
    return resp


@app.route("/api/auth/status")
def api_auth_status():
    """Spune dacă cererea curentă are deja un cod valid în cookie. PUBLIC —
    folosit de dashboard la încărcare ca să ştie dacă cere codul."""
    code = auth.current_code()
    authed = bool(code and auth._code_is_valid(code))
    return jsonify({"authorized": authed})


@app.route("/api/auth/logout", methods=["POST"])
def api_auth_logout():
    """Şterge codul din cookie — deconectare."""
    resp = jsonify({"ok": True})
    resp.delete_cookie(auth.ACCESS_COOKIE)
    return resp


@app.route("/dashboard")
def dashboard():
    """
    Pagina dashboard. Se încarcă mereu — dialogul de autentificare (cod de
    acces) se deschide în JS dacă IP-ul nu e încă autorizat. API-urile din
    spate sunt protejate de guard.
    """
    state = load_state()
    return render_template(
        "dashboard.html",
        # True după prima conectare reuşită a hub-ului. Cât timp e False,
        # doar tab-ul "Initial Setup" este accesibil.
        provisioned=bool(state["hub"].get("provisioned")),
        hub_ip=state["hub"].get("ip"),
        hub_ssid=state["hub"].get("ssid"),
    )


# ---------------------------------------------------------------- API: stare generală

@app.route("/api/state")
@login_required
def api_state():
    """Returnează starea persistentă (utilă pentru iniţializarea UI-ului)."""
    return jsonify(load_state())


# ---------------------------------------------------------------- API: Initial Setup (BLE provisioning)
#
# Fluxul de provisioning (vezi ble_provisioning.py pentru detalii):
#   1. POST /api/setup/scan       → scanare BLE, listă de hub-uri găsite
#   2. POST /api/setup/provision  → porneşte transmiterea credenţialelor,
#                                   returnează un job_id
#   3. GET  /api/setup/job/<id>   → polling pe starea job-ului cât timp UI-ul
#                                   e blocat cu animaţie de loading
#   4. POST /api/setup/connect    → salvează IP-ul hub-ului confirmat,
#                                   deblochează celelalte taburi

@app.route("/api/setup/scan", methods=["POST"])
def api_setup_scan():
    """
    Scanare BLE pentru hub-uri Dropwise în mod provisioning.
    Operaţie blocantă (~2-6s). Returnează doar plăcile numite "Dropwise HUB".

    PUBLIC — provisioning-ul BLE rulează înainte ca utilizatorul să aibă
    codul de acces (codul se cere abia la pasul "Conectare").
    """
    try:
        devices = ble.scan_for_hubs()
    except RuntimeError as e:
        # ex: bleak neinstalat în modul real
        return jsonify({"error": str(e)}), 500
    return jsonify({"devices": devices, "mode": ble.get_mode()})


@app.route("/api/setup/provision", methods=["POST"])
def api_setup_provision():
    """
    Porneşte transmiterea credenţialelor WiFi către hub prin BLE.
    Provisioning-ul rulează în fundal — returnăm imediat un job_id pe care
    frontend-ul îl interoghează cu /api/setup/job/<id>.

    PUBLIC — vezi /api/setup/scan.
    """
    data = request.get_json(silent=True) or {}
    address  = (data.get("address") or "").strip()
    ssid     = (data.get("ssid") or "").strip()
    password = data.get("password") or ""

    if not address:
        return jsonify({"error": "Adresa hub-ului (BLE) lipseşte."}), 400
    if not ssid:
        return jsonify({"error": "SSID lipsă."}), 400

    job = ble.start_provisioning(address, ssid, password)
    return jsonify({"ok": True, "job": job.to_dict()})


@app.route("/api/setup/job/<job_id>", methods=["GET"])
def api_setup_job(job_id):
    """Returnează starea curentă a unui job de provisioning (pentru polling).
    PUBLIC — vezi /api/setup/scan."""
    job = ble.get_job(job_id)
    if job is None:
        return jsonify({"error": "job inexistent"}), 404
    return jsonify(job.to_dict())


@app.route("/api/setup/connect", methods=["POST"])
@login_required
def api_setup_connect():
    """
    Finalizează configurarea iniţială: salvează IP-ul hub-ului confirmat de
    provisioning şi marchează hub-ul ca aprovizionat. După acest pas,
    celelalte taburi devin accesibile.
    """
    data = request.get_json(silent=True) or {}
    ip   = (data.get("ip") or "").strip()
    ssid = (data.get("ssid") or "").strip() or None

    if not ip:
        return jsonify({"error": "IP-ul hub-ului lipseşte."}), 400

    state = load_state()
    state["hub"]["ip"] = ip
    state["hub"]["ssid"] = ssid or state["hub"].get("ssid")
    state["hub"]["provisioned"] = True
    save_state(state)
    return jsonify({"ok": True, "ip": ip})


# ---------------------------------------------------------------- API: Monitorizare (proxy către hub)

import time as _time

# Momentul pornirii serverului — folosit de mock pentru a simula handshake-ul
# nodurilor (detectate fizic, dar neconfirmate încă) la prima deschidere.
_MOCK_START = _time.time()
# Cât durează handshake-ul simulat (secunde) de la pornirea serverului.
_MOCK_HANDSHAKE_S = 15.0


def _mock_hub_status() -> dict:
    """
    Stare simulată a hub-ului pentru DROPWISE_HUB_MODE=mock.

    Pentru test, la prima deschidere a serverului porturile 1 şi 2 sunt în
    handshake (physical=true, confirmed=false) timp de câteva secunde, apoi
    devin conectate. Portul 3 rămâne gol.

    Datele de senzori (umiditate sol, temperatură etc.) sunt încă TODO —
    vor veni de la nod prin hub când firmware-ul de transmisie e gata.
    """
    state = load_state()
    # Pentru test, portul 3 este lăsat gol (niciun nod conectat).
    EMPTY_PORTS = {3}
    # Porturi în handshake — doar în primele secunde după pornirea serverului.
    in_handshake = (_time.time() - _MOCK_START) < _MOCK_HANDSHAKE_S
    HANDSHAKE_PORTS = {1, 2} if in_handshake else set()
    ports = []
    for p in (1, 2, 3):
        if p in EMPTY_PORTS:
            # Slot fizic gol — niciun nod conectat.
            ports.append({
                "port": p,
                "physical": False,
                "confirmed": False,
                "name": None,
                "valve": False,
                "configured": False,
                "config": None,
                "sensors": None,
            })
            continue
        if p in HANDSHAKE_PORTS:
            # Nod detectat fizic, dar încă neconfirmat — handshake în curs.
            ports.append({
                "port": p,
                "physical": True,
                "confirmed": False,      # handshake-ul nu s-a încheiat
                "name": None,
                "valve": False,
                "configured": False,
                "config": None,
                "sensors": None,
            })
            continue
        # În mock, nodul de pe portul p se numeşte "P<p>" — dar cheia de
        # configurare e NUMELE nodului, nu portul.
        node_name = f"P{p}"
        cfg = state["nodes"].get(node_name)
        ports.append({
            "port": p,                   # slotul fizic curent
            "physical": True,            # nod prezent fizic
            "confirmed": True,           # nod identificat de hub
            "name": node_name,           # identitatea nodului
            "valve": False,
            "configured": bool(cfg and cfg.get("configured")),
            # Configuraţia completă, inline — evită un fetch separat per card.
            "config": cfg or None,
            # TODO(live): date reale de senzori de la nod
            "sensors": None,
        })
    return {
        "ports": ports,
        "channel": 6,
        "pump": False,
        "wateringPort": -1,
        "mock": True,
    }


@app.route("/api/hub/status")
@login_required
def api_hub_status():
    """
    Starea hub-ului. În mod 'mock' (DROPWISE_HUB_MODE) returnează o stare
    simulată; în 'real' face proxy către /status al ESP32.
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
        # Îmbogăţim porturile cu starea de configurare din state.json.
        # Cheia e NUMELE nodului ("name"), nu portul — config urmează nodul.
        for port in data.get("ports", []):
            cfg = state["nodes"].get(port.get("name"))
            port["configured"] = bool(cfg and cfg.get("configured"))
            port["config"] = cfg or None
        return jsonify({"online": True, "data": data})
    except requests.RequestException as e:
        return jsonify({"online": False, "error": str(e)}), 200


@app.route("/api/hub/logs")
@login_required
def api_hub_logs():
    """TODO: citirea logurilor de la hub. Pentru moment, placeholder."""
    return jsonify({
        "logs": [
            # exemple statice până implementăm — UI poate deja să le afişeze
            # {"ts": "2026-05-21T14:00:00", "level": "info",  "msg": "hub online"},
        ],
        "todo": "implementare reală — endpoint /logs pe hub"
    })


# ---------------------------------------------------------------- API: Control manual (TODO)

@app.route("/api/hub/toggle/<int:pin>", methods=["POST"])
@login_required
def api_hub_toggle(pin):
    """Proxy /toggle/<pin> — pentru tab-ul de control manual (TODO UI)."""
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


@app.route("/api/hub/water/<action>/<int:port>", methods=["POST"])
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


# ---------------------------------------------------------------- API: Configurare nod

@app.route("/api/catalog")
@login_required
def api_catalog():
    """Cataloagele folosite de wizardul de configurare a nodurilor:
    plante, tipuri de sol, culori. Citite dinamic din data/catalog.json —
    editabile fără modificări de cod."""
    catalog = nodes.load_catalog()
    return jsonify({
        "plants": catalog["plants"],
        "soils": catalog["soils"],
        "colors": catalog["colors"],
        "water_need_levels": list(nodes.WATER_NEED_LEVELS),
        "retention_levels": list(nodes.RETENTION_LEVELS),
    })


# Configuraţia se face pe NOD (identificat prin nume: P1/P2/P3), nu pe port.
# Numele de nod valide — deocamdată fixe; în live vor veni din /status.
VALID_NODE_NAMES = ("P1", "P2", "P3")


@app.route("/api/node/<node_name>", methods=["GET"])
@login_required
def api_node_get(node_name):
    """Returnează configuraţia salvată pentru un nod (sau {} dacă lipseşte)."""
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400
    state = load_state()
    return jsonify(state["nodes"].get(node_name, {}))


@app.route("/api/node/<node_name>/preview", methods=["POST"])
@login_required
def api_node_preview(node_name):
    """
    Validează alegerile din wizard şi întoarce parametrii de regulator
    derivaţi + explicaţiile lor — fără a salva nimic. Folosit la pasul
    de sumar al wizardului.
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    payload = request.get_json(silent=True) or {}
    config, err = nodes.build_node_config(payload)
    if err:
        return jsonify({"error": err}), 400

    return jsonify({
        "regulator": config["regulator"],
        "explanation": nodes.explain_regulator(config["regulator"]),
    })


@app.route("/api/node/<node_name>", methods=["POST"])
@login_required
def api_node_save(node_name):
    """
    Validează şi salvează configuraţia unui nod, apoi porneşte trimiterea
    ei către ESP32. Returnează un job_id de urmărit prin polling.
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    payload = request.get_json(silent=True) or {}
    config, err = nodes.build_node_config(payload)
    if err:
        return jsonify({"error": err}), 400

    # Salvăm în state.json sub numele nodului — sursa de adevăr a dashboard-ului.
    state = load_state()
    state["nodes"][node_name] = config
    save_state(state)

    # Pornim trimiterea către ESP32 (mock sau real).
    job = nodes.start_config_send(node_name, config, state["hub"].get("ip"))
    return jsonify({"ok": True, "node": node_name, "config": config,
                    "job": job.to_dict()})


@app.route("/api/node/job/<job_id>", methods=["GET"])
@login_required
def api_node_job(job_id):
    """Starea unui job de trimitere a configuraţiei către nod (polling)."""
    job = nodes.get_config_job(job_id)
    if job is None:
        return jsonify({"error": "job inexistent"}), 404
    return jsonify(job.to_dict())


# ---------------------------------------------------------------- main

if __name__ == "__main__":
    # Asigur starea iniţială
    load_state()

    # Portul din .env (DROPWISE_PORT), implicit 5000.
    try:
        port = int(os.environ.get("DROPWISE_PORT", "5000"))
    except ValueError:
        port = 5000

    # Banner ASCII — consola Windows (cp1250) nu poate afişa caractere
    # Unicode precum sageata "->".
    print("=" * 60)
    print(" Dropwise Dashboard")
    print(" -> http://127.0.0.1:" + str(port))
    print(" -> login: admin / admin")
    print(" -> mod BLE: " + ble.get_mode()
          + "  (DROPWISE_BLE_MODE)")
    print(" -> mod HUB: " + nodes.get_hub_mode()
          + "  (DROPWISE_HUB_MODE)")
    print("=" * 60)
    app.run(host="0.0.0.0", port=port, debug=True)

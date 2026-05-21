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
from functools import wraps
from pathlib import Path

# Încărcăm variabilele din fişierul .env ÎNAINTE de orice citire os.environ.
# Dacă python-dotenv lipseşte, aplicaţia funcţionează tot — cu valorile
# implicite din cod.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from flask import (
    Flask, jsonify, render_template, request, redirect,
    session, url_for, abort
)

try:
    import requests  # pentru proxy către hub
except ImportError:
    requests = None

import ble_provisioning as ble  # modul de detecţie BLE + provisioning


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

# Credenţiale de test — vor fi citite mai târziu din configuraţia hub-ului
TEST_USERNAME = "admin"
TEST_PASSWORD = "admin"

# Cât timp ţinem o sesiune deschisă (în secunde)
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
        # Configuraţie per nod (cheia = port: 1, 2, 3)
        # Exemplu: "1": { "plant_type": "ficus", "soil_type": "universal", ... }
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


# ---------------------------------------------------------------- auth

def login_required(view):
    """Decorator: redirect la /login dacă nu există sesiune validă."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get("authenticated"):
            # Pentru API returnăm 401, pentru pagini redirect
            if request.path.startswith("/api/"):
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapper


# ---------------------------------------------------------------- routes: pagini

@app.route("/")
def home():
    """Pagina principală publică. Nu necesită autentificare."""
    return render_template("index.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        if username == TEST_USERNAME and password == TEST_PASSWORD:
            session.permanent = True
            session["authenticated"] = True
            session["username"] = username
            next_url = request.args.get("next") or url_for("dashboard")
            return redirect(next_url)
        error = "Utilizator sau parolă incorecte."

    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/dashboard")
@login_required
def dashboard():
    state = load_state()
    return render_template(
        "dashboard.html",
        username=session.get("username"),
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
@login_required
def api_setup_scan():
    """
    Scanare BLE pentru hub-uri Dropwise în mod provisioning.
    Operaţie blocantă (~2-6s). Returnează doar plăcile numite "Dropwise HUB".
    """
    try:
        devices = ble.scan_for_hubs()
    except RuntimeError as e:
        # ex: bleak neinstalat în modul real
        return jsonify({"error": str(e)}), 500
    return jsonify({"devices": devices, "mode": ble.get_mode()})


@app.route("/api/setup/provision", methods=["POST"])
@login_required
def api_setup_provision():
    """
    Porneşte transmiterea credenţialelor WiFi către hub prin BLE.
    Provisioning-ul rulează în fundal — returnăm imediat un job_id pe care
    frontend-ul îl interoghează cu /api/setup/job/<id>.
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
@login_required
def api_setup_job(job_id):
    """Returnează starea curentă a unui job de provisioning (pentru polling)."""
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

@app.route("/api/hub/status")
@login_required
def api_hub_status():
    """
    Proxy către endpoint-ul /status al hub-ului ESP32.
    Returnează starea curentă: porturi, valve, pompă, canal WiFi.
    """
    state = load_state()
    hub_ip = state["hub"].get("ip")

    if not hub_ip:
        return jsonify({"online": False, "error": "hub_ip_not_set"}), 200

    if requests is None:
        return jsonify({"online": False, "error": "requests_not_installed"}), 500

    try:
        r = requests.get(f"http://{hub_ip}/status", timeout=1.5)
        r.raise_for_status()
        data = r.json()
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
        r = requests.get(f"http://{hub_ip}/toggle/{pin}", timeout=1.5)
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
            timeout=1.5
        )
        return jsonify(r.json()), r.status_code
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502


# ---------------------------------------------------------------- API: Configurare nod

@app.route("/api/node/<int:port>", methods=["GET"])
@login_required
def api_node_get(port):
    """Returnează configuraţia salvată pentru un nod (sau {} dacă nu există)."""
    if port not in (1, 2, 3):
        return jsonify({"error": "port invalid"}), 400
    state = load_state()
    return jsonify(state["nodes"].get(str(port), {}))


@app.route("/api/node/<int:port>", methods=["POST"])
@login_required
def api_node_save(port):
    """
    Salvează configuraţia unui nod.
    TODO: validare câmpuri (tip plantă, tip sol, parametri regulator).
    TODO: trimitere configuraţie către hub (care va propaga la nod).
    """
    if port not in (1, 2, 3):
        return jsonify({"error": "port invalid"}), 400

    data = request.get_json(silent=True) or {}
    state = load_state()
    state["nodes"][str(port)] = data
    save_state(state)
    return jsonify({"ok": True, "port": port, "config": data})


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
          + "  (seteaza DROPWISE_BLE_MODE=real in .env pentru hardware)")
    print("=" * 60)
    app.run(host="0.0.0.0", port=port, debug=True)

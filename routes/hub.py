"""
Blueprint: Monitorizare + Control (proxy/mock hub)
==================================================
  GET  /api/hub/status              — starea hub-ului (mock sau proxy)
  GET  /api/hub/logs                — loguri (TODO)
  POST /api/hub/toggle/<pin>        — toggle GPIO (control manual)
  POST /api/hub/water/<act>/<port>  — ciclu de udare
"""

import time

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
        ports.append({
            "port": p, "physical": True, "confirmed": True,
            "name": node_name, "valve": False,
            "configured": bool(cfg and cfg.get("configured")),
            "config": cfg or None,   # config inline — evită un fetch separat
            "sensors": None,         # TODO(live): date reale de senzori
        })
    return {
        "ports": ports, "channel": 6, "pump": False,
        "wateringPort": -1, "mock": True,
        # IP-ul hub-ului — pentru cardul de stare de pe Monitor.
        "ip": state["hub"].get("ip") or "192.168.1.50",
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
        # Îmbogăţim porturile cu starea de configurare din state.json.
        for port in data.get("ports", []):
            cfg = state["nodes"].get(port.get("name"))
            port["configured"] = bool(cfg and cfg.get("configured"))
            port["config"] = cfg or None
        data.setdefault("ip", hub_ip)   # IP-ul hub-ului pentru cardul Monitor
        return jsonify({"online": True, "data": data})
    except requests.RequestException as e:
        return jsonify({"online": False, "error": str(e)}), 200


@bp.route("/api/hub/logs")
@login_required
def api_hub_logs():
    """TODO: citirea logurilor de la hub. Pentru moment, placeholder."""
    return jsonify({
        "logs": [],
        "todo": "implementare reală — endpoint /logs pe hub",
    })


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

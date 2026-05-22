"""
Blueprint: Initial Setup (provisioning BLE)
===========================================
  POST /api/setup/scan       — scanare BLE, listă de hub-uri
  POST /api/setup/provision  — porneşte transmiterea credenţialelor
  GET  /api/setup/job/<id>   — polling pe starea job-ului
  POST /api/setup/connect    — salvează IP-ul hub-ului, marchează provizionat

scan/provision/job sunt PUBLICE — provisioning-ul BLE rulează înainte ca
utilizatorul să aibă codul de acces. connect e protejat (codul se cere
chiar înainte de el, în dialogul de "Conectare").
"""

from flask import Blueprint, jsonify, request

import ble_provisioning as ble
from core import load_state, save_state
from routes.pages import login_required

bp = Blueprint("setup", __name__)


@bp.route("/api/setup/scan", methods=["POST"])
def api_setup_scan():
    """Scanare BLE pentru hub-uri Dropwise (~2-6s). PUBLIC."""
    try:
        devices = ble.scan_for_hubs()
    except RuntimeError as e:
        # ex: bleak neinstalat în modul real
        return jsonify({"error": str(e)}), 500
    return jsonify({"devices": devices, "mode": ble.get_mode()})


@bp.route("/api/setup/provision", methods=["POST"])
def api_setup_provision():
    """
    Porneşte transmiterea credenţialelor WiFi către hub prin BLE.
    Rulează în fundal — returnăm imediat un job_id de urmărit. PUBLIC.
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


@bp.route("/api/setup/job/<job_id>", methods=["GET"])
def api_setup_job(job_id):
    """Starea curentă a unui job de provisioning (polling). PUBLIC."""
    job = ble.get_job(job_id)
    if job is None:
        return jsonify({"error": "job inexistent"}), 404
    return jsonify(job.to_dict())


@bp.route("/api/setup/connect", methods=["POST"])
@login_required
def api_setup_connect():
    """
    Finalizează configurarea iniţială: salvează IP-ul hub-ului confirmat de
    provisioning şi marchează hub-ul ca aprovizionat. Deblochează taburile.
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

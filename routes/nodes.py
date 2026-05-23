"""
Blueprint: Catalog + Configurare noduri
=======================================
  GET  /api/catalog              — plante / soluri / culori (PUBLIC)
  GET  /api/node/<name>          — configuraţia salvată a unui nod
  GET  /api/node/<name>/stats    — statisticile unui nod
  POST /api/node/<name>/preview  — parametrii de regulator (fără salvare)
  POST /api/node/<name>          — salvează config + trimite la ESP32
  GET  /api/node/job/<id>        — polling pe job-ul de trimitere
"""

from flask import Blueprint, jsonify, request

import auth
import node_config as nc
from core import load_state, save_state, VALID_NODE_NAMES
from routes.pages import login_required

bp = Blueprint("nodes", __name__)


@bp.route("/api/catalog")
def api_catalog():
    """Cataloagele wizardului (plante/soluri/culori). PUBLIC — doar date de
    referinţă, iar UI-ul le încarcă la pornire, înainte de cod."""
    catalog = nc.load_catalog()
    return jsonify({
        "plants": catalog["plants"],
        "soils": catalog["soils"],
        "colors": catalog["colors"],
        "water_need_levels": list(nc.WATER_NEED_LEVELS),
        "retention_levels": list(nc.RETENTION_LEVELS),
    })


@bp.route("/api/node/<node_name>", methods=["GET"])
@login_required
def api_node_get(node_name):
    """Returnează configuraţia salvată pentru un nod (sau {} dacă lipseşte)."""
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400
    state = load_state()
    return jsonify(state["nodes"].get(node_name, {}))


@bp.route("/api/node/<node_name>/stats", methods=["GET"])
@login_required
def api_node_stats(node_name):
    """
    Statisticile unui nod (data configurării, total udări, ml etc.).
    În mod test sunt simulate; în live vin din EEPROM-ul nodului, prin hub.
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    state = load_state()
    cfg = state["nodes"].get(node_name)
    stats = nc.get_node_stats(node_name, cfg, state["hub"].get("ip"))
    if stats is None:
        return jsonify({"error": "node_not_configured"}), 404

    return jsonify({"node": node_name, "config": cfg, "stats": stats})


@bp.route("/api/node/<node_name>/preview", methods=["POST"])
@login_required
def api_node_preview(node_name):
    """
    Validează alegerile din wizard şi întoarce parametrii de regulator
    derivaţi + explicaţiile lor — fără a salva nimic (pasul "Sumar").
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    payload = request.get_json(silent=True) or {}
    config, err = nc.build_node_config(payload)
    if err:
        return jsonify({"error": err}), 400

    return jsonify({
        "regulator": config["regulator"],
        "explanation": nc.explain_regulator(config["regulator"]),
    })


@bp.route("/api/node/<node_name>", methods=["POST"])
@login_required
def api_node_save(node_name):
    """
    Validează şi salvează configuraţia unui nod, apoi porneşte trimiterea
    ei către ESP32. Returnează un job_id de urmărit prin polling.
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    payload = request.get_json(silent=True) or {}
    config, err = nc.build_node_config(payload)
    if err:
        return jsonify({"error": err}), 400

    # Salvăm în state.json sub numele nodului — sursa de adevăr a dashboard-ului.
    state = load_state()
    state["nodes"][node_name] = config
    save_state(state)

    # Pornim trimiterea către ESP32 (mock sau real).
    # Codul de acces din cookie-ul curent ajunge la hub ca X-Access-Code.
    job = nc.start_config_send(
        node_name, config,
        state["hub"].get("ip"),
        access_code=auth.current_code())
    return jsonify({"ok": True, "node": node_name, "config": config,
                    "job": job.to_dict()})


@bp.route("/api/node/job/<job_id>", methods=["GET"])
@login_required
def api_node_job(job_id):
    """Starea unui job de trimitere a configuraţiei către nod (polling)."""
    job = nc.get_config_job(job_id)
    if job is None:
        return jsonify({"error": "job inexistent"}), 404
    return jsonify(job.to_dict())

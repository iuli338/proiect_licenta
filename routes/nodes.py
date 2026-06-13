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
        # Clasele de udare (cadenţă biologică) — pentru selectorul din
        # formularul de plantă custom al wizardului.
        "watering_classes": nc.watering_classes_public(),
    })


@bp.route("/api/node/<node_name>", methods=["GET"])
@login_required
def api_node_get(node_name):
    """
    Returnează configuraţia unui nod.

    În MOD MOCK: citim din state.json local (sursa de adevăr pentru rulare
    fără hardware).
    În MOD REAL: facem proxy GET /node/Pi/config la hub — sursa unică e
    EEPROM-ul fizic, nu o copie locală.
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    if nc.get_hub_mode() == "mock":
        state = load_state()
        return jsonify(state["nodes"].get(node_name, {}))

    # Mod real — fetch direct de la hub.
    state = load_state()
    hub_ip = state["hub"].get("ip")
    if not hub_ip:
        return jsonify({"error": "hub_ip_not_set"}), 503
    try:
        import requests
        r = requests.get(
            f"http://{hub_ip}/node/{node_name}/config",
            headers={"X-Access-Code": auth.current_code() or ""},
            timeout=4,
        )
        if r.status_code != 200:
            return jsonify({"error": f"hub a raspuns {r.status_code}"}), 502
        return jsonify(r.json())
    except Exception as e:   # noqa: BLE001
        return jsonify({"error": str(e)}), 502


@bp.route("/api/node/<node_name>/stats", methods=["GET"])
@login_required
def api_node_stats(node_name):
    """
    Statisticile unui nod (data configurării, total udări, ml etc.).

    MOCK: citim configul din state.json, generăm stats simulate stabile.
    LIVE: GET /node/<P>/config + GET /node/<P>/stats pe hub, ambele cu
    X-Access-Code. Configurul + stats sunt în EEPROM-ul hub-ului.
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    if nc.get_hub_mode() == "mock":
        state = load_state()
        cfg = state["nodes"].get(node_name)
        stats = nc.get_node_stats(node_name, cfg, state["hub"].get("ip"))
        if stats is None:
            return jsonify({"error": "node_not_configured"}), 404
        return jsonify({"node": node_name, "config": cfg, "stats": stats})

    # --- LIVE ---
    state = load_state()
    hub_ip = state["hub"].get("ip")
    if not hub_ip:
        return jsonify({"error": "hub_ip_not_set"}), 503
    headers = {"X-Access-Code": auth.current_code() or ""}
    try:
        import requests
        # 1. config — vrem să ştim dacă nodul e configurat şi ce plantă/sol.
        rc = requests.get(
            f"http://{hub_ip}/node/{node_name}/config",
            headers=headers, timeout=4,
        )
        if rc.status_code != 200:
            return jsonify({"error": f"hub a raspuns {rc.status_code} la /config"}), 502
        cfg = rc.json()
        if not cfg.get("configured"):
            return jsonify({"error": "node_not_configured"}), 404

        # 2. stats — counters reali din EEPROM (creat la, total udări, etc.).
        rs = requests.get(
            f"http://{hub_ip}/node/{node_name}/stats",
            headers=headers, timeout=4,
        )
        if rs.status_code != 200:
            return jsonify({"error": f"hub a raspuns {rs.status_code} la /stats"}), 502
        stats = rs.json()
        stats["mock"] = False
        return jsonify({"node": node_name, "config": cfg, "stats": stats})
    except Exception as e:   # noqa: BLE001
        return jsonify({"error": str(e)}), 502


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
    Validează şi salvează configuraţia unui nod.

    În MOD MOCK: salvăm în state.json (sursa de adevăr a dashboard-ului
    pentru rulare fără hardware) şi rulăm un job mock de trimitere.

    În MOD REAL: NU mai salvăm local. Trimitem direct la hub şi întoarcem
    job-ul. Dacă jobul eşuează, nimic nu rămâne stocat — utilizatorul
    vede eroarea şi reîncearcă. Sursa unică de adevăr e EEPROM-ul hub-ului.
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    payload = request.get_json(silent=True) or {}
    config, err = nc.build_node_config(payload)
    if err:
        return jsonify({"error": err}), 400

    state = load_state()
    if nc.get_hub_mode() == "mock":
        # Doar pe mock — salvăm local ca să avem ce afişa la următorul fetch.
        state["nodes"][node_name] = config
        save_state(state)

    # Pornim trimiterea către ESP32 (mock sau real). Codul de acces din
    # cookie-ul curent ajunge la hub ca X-Access-Code.
    job = nc.start_config_send(
        node_name, config,
        state["hub"].get("ip"),
        access_code=auth.current_code())

    # Invalidăm cache-ul de config — următorul polling de status va
    # face fetch fresh ca să reflecte valorile noi imediat.
    try:
        from routes.hub import invalidate_node_cfg_cache
        invalidate_node_cfg_cache(node_name)
    except Exception:   # noqa: BLE001
        pass

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


@bp.route("/api/node/<node_name>/history", methods=["GET"])
@login_required
def api_node_history(node_name):
    """
    Istoricul orar al senzorilor pentru un nod — 24 puncte (ultimele 24 ore).
    În mock: generăm o serie deterministă plauzibilă (per nume nod) cu mici
    oscilaţii zilnice. În real (TODO): proxy la /node/Pi/history pe hub.
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    if nc.get_hub_mode() == "mock":
        # Delay artificial — simulează latenţa fetch-ului de la hub real
        # (ESP-NOW + EEPROM read). Suficient ca loader-ul să fie vizibil.
        import time as _t
        _t.sleep(0.5)
        return jsonify(_mock_history(node_name))

    # Mod real — proxy către hub.
    state = load_state()
    hub_ip = state["hub"].get("ip")
    if not hub_ip:
        return jsonify({"error": "hub_ip_not_set"}), 503
    try:
        import requests
        r = requests.get(
            f"http://{hub_ip}/node/{node_name}/history",
            headers={"X-Access-Code": auth.current_code() or ""},
            timeout=4,
        )
        r.raise_for_status()
        return jsonify(r.json())
    except Exception as e:   # noqa: BLE001
        return jsonify({"error": str(e)}), 502


def _mock_history(node_name: str) -> dict:
    """24 puncte orare cu valori plauzibile, deterministe per nume nod.

    Forme curbe:
      - umiditate sol: scade lent în zi (uscare), poate avea un salt de
        udare în jurul orei 9 (mock).
      - temp sol/aer: cosinusoidă cu max la 14:00 şi min la 04:00.
      - umiditate aer: invers — max noaptea, min ziua.
      - lux: 0 noaptea, parabolică ziua, vârf la 12-14.
    """
    import math, time as _time
    seed = sum(ord(c) for c in node_name)
    now = int(_time.time())
    samples = []
    for i in range(24):
        ts = now - (23 - i) * 3600          # 24h în urmă → acum
        # ora locală 0-23 (folosim ora epoch UTC, simplu pentru mock).
        hr = ((ts // 3600) + 3) % 24        # offset RO ~UTC+3 vară
        # Cosinusoidă diurnă (zenit 14:00 = vârf):
        diurnal = math.cos(math.pi * (hr - 14) / 12)   # +1 la 14:00, −1 la 02:00

        # Umiditate sol: pornește high după udare, scade exponenţial.
        moist0 = 70.0 + (seed % 10)
        moist = moist0 * math.exp(-i / 30.0) + 30.0 + ((seed + i) % 4)
        # Udare simulată în jurul orei 9 → bump
        if hr == 9: moist += 20

        air_temp  = 22.0 + 4.0 * diurnal + ((seed * 3 + i) % 3) * 0.3
        air_hum   = 55.0 - 12.0 * diurnal + ((seed + i * 2) % 5)
        # Lux: doar ziua (6-20), parabolic, vârf la 13.
        lux = 0.0
        if 6 <= hr <= 20:
            x = (hr - 13) / 7.0
            lux = max(0.0, 8000.0 * (1.0 - x * x)) + ((seed + i) % 200)

        samples.append({
            "ts": ts,
            "soil_moisture_pct":  round(max(15.0, min(95.0, moist)), 1),
            "air_temp_c":         round(air_temp, 1),
            "air_humidity_pct":   round(max(20.0, min(90.0, air_hum)), 1),
            "lux":                round(lux),
        })
    return {"node": node_name, "samples": samples, "mock": True}


@bp.route("/api/node/<node_name>/reset", methods=["POST"])
@login_required
def api_node_reset(node_name):
    """
    Şterge complet configuraţia unui nod: scoate intrarea din state.json
    şi (în modul real) apelează /node/P<i>/forget pe hub ca să zeroizeze
    slot-ul EEPROM. Operaţie IREVERSIBILĂ — front-end-ul confirmă cu dialog.
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    # 1. Stergem din state-ul local (relevant doar pe mock; pe live e oricum gol).
    state = load_state()
    state["nodes"].pop(node_name, None)
    save_state(state)

    # 2. In modul real, trimitem si la hub sa zeroizeze EEPROM-ul.
    hub_ip = state["hub"].get("ip")
    if nc.get_hub_mode() == "real" and hub_ip:
        try:
            import requests
            r = requests.post(
                f"http://{hub_ip}/node/{node_name}/forget",
                headers={"X-Access-Code": auth.current_code() or ""},
                timeout=5,
            )
            if r.status_code != 200:
                # Hub-ul a raspuns dar nu cu OK — NU invalidam cache-ul;
                # configul vechi din EEPROM e inca acolo si vrem sa-l aratam
                # corect daca user-ul reincearca.
                return jsonify({
                    "ok": True,
                    "node": node_name,
                    "warning": f"State sters local, dar hub-ul a raspuns "
                               f"{r.status_code}.",
                }), 200
        except Exception as e:   # noqa: BLE001
            return jsonify({
                "ok": True,
                "node": node_name,
                "warning": f"State sters local, dar hub-ul nu raspunde: {e}",
            }), 200

    # 3. Invalidam cache-ul DOAR la reset cu succes (sau pe mock, unde nu
    # exista hub real). Asta asigura ca urmatorul /status face fetch fresh
    # si vede slot-ul gol — UI-ul actualizeaza cardul corespunzator.
    try:
        from routes.hub import invalidate_node_cfg_cache
        invalidate_node_cfg_cache(node_name)
    except Exception:   # noqa: BLE001
        pass

    return jsonify({"ok": True, "node": node_name})


@bp.route("/api/node/<node_name>/auto-watering", methods=["POST"])
@login_required
def api_node_auto_watering(node_name):
    """
    Activează / dezactivează udarea automată pentru un nod.

    Body: {"enabled": true|false}

    Mock: setează flag-ul în state.json["nodes"][node_name].
    Live: proxy POST la firmware /node/<P>/auto-watering, apoi salvează
          şi local pentru cache. Răspunde 200 doar dacă hub-ul a confirmat.
    """
    if node_name not in VALID_NODE_NAMES:
        return jsonify({"error": "nod invalid"}), 400

    payload = request.get_json(silent=True) or {}
    if "enabled" not in payload:
        return jsonify({"error": "lipseste campul 'enabled'"}), 400
    enabled = bool(payload["enabled"])

    state = load_state()

    # ---- LIVE: proxy spre hub ----
    if nc.get_hub_mode() == "real":
        hub_ip = state["hub"].get("ip")
        if not hub_ip:
            return jsonify({"error": "hub_ip_not_set"}), 503
        try:
            import requests
            r = requests.post(
                f"http://{hub_ip}/node/{node_name}/auto-watering",
                json={"enabled": enabled},
                headers={"X-Access-Code": auth.current_code() or ""},
                timeout=5,
            )
        except Exception as e:   # noqa: BLE001
            return jsonify({
                "error": f"Hub-ul nu raspunde ({e})."
            }), 502
        if r.status_code != 200:
            return jsonify({
                "error": f"Hub-ul a refuzat ({r.status_code})."
            }), 502
        # Invalidăm cache-ul ca să citim configul proaspăt la următorul poll.
        try:
            from routes.hub import invalidate_node_cfg_cache
            invalidate_node_cfg_cache(node_name)
        except Exception:   # noqa: BLE001
            pass
        return jsonify({"ok": True, "node": node_name, "enabled": enabled})

    # ---- MOCK: setăm flag-ul în state ----
    cfg = state["nodes"].get(node_name)
    if not cfg or not cfg.get("configured"):
        return jsonify({"error": "Nodul nu este configurat."}), 400
    nc.set_auto_watering(cfg, enabled)
    save_state(state)
    return jsonify({"ok": True, "node": node_name, "enabled": enabled})

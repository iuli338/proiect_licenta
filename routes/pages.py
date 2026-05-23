"""
Blueprint: pagini + autentificare
=================================
  /              — pagina principală publică
  /dashboard     — dashboard-ul (se încarcă mereu)
  /api/auth      — verifică codul de acces, setează cookie-ul
  /api/auth/status — spune dacă cererea are deja un cod valid
  /api/state     — starea persistentă (protejat)
  errorhandler 404 — redirect la dashboard pentru pagini
"""

from flask import (
    Blueprint, jsonify, render_template, request, redirect, url_for
)

import auth
from core import load_state, SESSION_TIMEOUT

bp = Blueprint("pages", __name__)

# Guard-ul de cod — folosit de toate blueprint-urile.
login_required = auth.require_code


@bp.route("/")
def home():
    """Pagina principală publică. Nu necesită autentificare."""
    return render_template("index.html")


@bp.route("/api/auth", methods=["POST"])
def api_auth():
    """
    Verifică codul de acces (la apăsarea "Conectare"). Endpoint PUBLIC.
    La cod corect, salvează codul într-un cookie pe browserul clientului.

    Acceptă opţional `hub_ip` în body — folosit în timpul fluxului de
    Initial Setup, când hub-ul a fost aprovizionat dar IP-ul nu a fost
    încă salvat în state.json (asta se întâmplă la pasul următor, în
    /api/setup/connect, care el însuşi cere autentificare).
    """
    data = request.get_json(silent=True) or {}
    code = (data.get("code") or "").strip()

    state = load_state()
    hub_ip = state["hub"].get("ip") or (data.get("hub_ip") or "").strip() or None

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


@bp.route("/api/auth/status")
def api_auth_status():
    """Spune dacă cererea curentă are deja un cod valid în cookie. PUBLIC —
    folosit de dashboard la încărcare ca să ştie dacă cere codul."""
    code = auth.current_code()
    authed = bool(code and auth._code_is_valid(code))
    return jsonify({"authorized": authed})


@bp.route("/dashboard")
def dashboard():
    """
    Pagina dashboard. Se încarcă mereu — dialogul de autentificare (cod de
    acces) se deschide în JS dacă cererea nu e încă autorizată. API-urile
    din spate sunt protejate de guard.
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


@bp.route("/api/state")
@login_required
def api_state():
    """Returnează starea persistentă (utilă pentru iniţializarea UI-ului)."""
    return jsonify(load_state())


@bp.app_errorhandler(404)
def handle_404(_e):
    """
    Cerere către o rută inexistentă.
      - API (/api/...) => 404 JSON (frontend-ul ştie să-l trateze).
      - navigare de pagină => redirect la dashboard, de unde porneşte
        fluxul normal (Initial Setup / dialogul de cod).
    """
    if request.path.startswith("/api/"):
        return jsonify({"error": "not found"}), 404
    return redirect(url_for("pages.dashboard") + "#setup")

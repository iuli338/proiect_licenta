"""
Dropwise — autentificare prin cod de acces
===========================================

Model:
  - Hub-ul ESP32 are un cod de acces FIX (imprimat pe cutie).
  - La "Conectare", utilizatorul introduce codul într-un dialog; serverul îl
    verifică (POST /auth la hub, sau comparaţie în modul mock).
  - La cod corect, codul e salvat într-un cookie pe browserul clientului.
  - Guard-ul `require_code` protejează endpoint-urile private: citeşte codul
    din cookie şi îl validează. Lipsă sau greşit => 404 (controlul nu e
    posibil până nu te uiţi pe cutie).
  - Codul valid e trimis mai departe spre hub în header-ul X-Access-Code;
    placa decide la fiecare cerere.

Mod test (DROPWISE_HUB_MODE=mock): fără ESP32, Flask validează codul el însuşi
comparându-l cu TEST_ACCESS_CODE.
"""

from __future__ import annotations

from functools import wraps
from typing import Optional

from flask import request, jsonify, abort

try:
    import requests
except ImportError:
    requests = None

import node_config as nodes   # pentru get_hub_mode()


# Codul de acces folosit în modul mock (fără hardware).
# În modul real, codul corect e cel din firmware-ul hub-ului.
TEST_ACCESS_CODE = "284095"

# Numele cookie-ului în care browserul ţine codul de acces.
ACCESS_COOKIE = "dropwise_code"

# Header-ul prin care codul ajunge la hub la fiecare cerere.
ACCESS_HEADER = "X-Access-Code"

# Timeout pentru cererile HTTP către hub.
_HUB_TIMEOUT = 3.0


def verify_code(code: str, hub_ip: Optional[str]) -> tuple[bool, str]:
    """
    Verificarea iniţială a codului (la apăsarea "Conectare").
      - mock: compară cu TEST_ACCESS_CODE.
      - real: POST http://<hub_ip>/auth — hub-ul decide.
    Returnează (ok, mesaj).
    """
    code = (code or "").strip()
    if not code:
        return False, "Introdu codul de acces."

    if nodes.get_hub_mode() == "mock":
        if code == TEST_ACCESS_CODE:
            return True, "Cod corect."
        return False, "Cod greşit."

    # --- mod real: hub-ul decide ---
    if not hub_ip:
        return False, "Hub-ul nu este configurat."
    if requests is None:
        return False, "Biblioteca 'requests' nu este instalată."
    try:
        r = requests.post(f"http://{hub_ip}/auth",
                          json={"code": code}, timeout=_HUB_TIMEOUT)
        if r.status_code == 200 and r.json().get("ok"):
            return True, "Cod corect."
        return False, "Cod greşit."
    except requests.RequestException as e:
        return False, f"Hub-ul nu răspunde: {e}"


def _code_is_valid(code: str) -> bool:
    """Validează rapid un cod (din cookie). În mock compară local; în real
    îl acceptă ca prezent — hub-ul îl re-verifică la fiecare proxy."""
    code = (code or "").strip()
    if not code:
        return False
    if nodes.get_hub_mode() == "mock":
        return code == TEST_ACCESS_CODE
    # Mod real: prezenţa unui cod e suficientă aici; hub-ul respinge cu 404
    # dacă e greşit, la cererea proxy efectivă.
    return True


def current_code() -> Optional[str]:
    """Codul de acces din cookie-ul cererii curente, sau None."""
    code = request.cookies.get(ACCESS_COOKIE, "").strip()
    return code or None


def require_code(view):
    """
    Guard pentru endpoint-uri private: dacă cererea nu are un cod de acces
    valid în cookie => 404. Ascunde existenţa endpoint-ului.
    """
    @wraps(view)
    def wrapper(*args, **kwargs):
        code = current_code()
        if not code or not _code_is_valid(code):
            abort(404)
        return view(*args, **kwargs)
    return wrapper


def hub_headers() -> dict:
    """Header-ele de trimis spre hub — include codul de acces din cookie."""
    code = current_code()
    return {ACCESS_HEADER: code} if code else {}

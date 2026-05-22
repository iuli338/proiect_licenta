"""
Dropwise — Dashboard backend
============================

Aplicaţie Flask pentru dashboard-ul sistemului de irigare.

Structura:
  core.py        — căi, stare persistentă (state.json), constante
  auth.py        — autentificare prin cod de acces + guard
  routes/        — blueprint-uri pe domenii (pages / setup / hub / nodes)
  ble_provisioning.py, node_config.py — logica de provisioning şi noduri

Rulare:
    pip install -r requirements.txt
    python app.py        → http://127.0.0.1:5000
"""

import os

# Încărcăm variabilele din .env ÎNAINTE de orice citire os.environ.
# Dacă python-dotenv lipseşte, aplicaţia funcţionează tot — cu valorile
# implicite din cod.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from flask import Flask

import ble_provisioning as ble
import node_config as nodes
from core import BUNDLE_DIR, SESSION_TIMEOUT, load_state
from routes import register_blueprints


# ---------------------------------------------------------------- app

app = Flask(__name__,
            static_folder=str(BUNDLE_DIR / "static"),
            template_folder=str(BUNDLE_DIR / "templates"))
# Cheia de sesiune din .env (DROPWISE_SECRET_KEY). Fallback pentru dezvoltare.
app.secret_key = os.environ.get("DROPWISE_SECRET_KEY",
                                "dev-only-change-in-production")
app.permanent_session_lifetime = SESSION_TIMEOUT

# Toate endpoint-urile, grupate pe blueprint-uri (vezi routes/).
register_blueprints(app)


# ---------------------------------------------------------------- main

if __name__ == "__main__":
    load_state()   # asigură starea iniţială

    # Portul din .env (DROPWISE_PORT), implicit 5000.
    try:
        port = int(os.environ.get("DROPWISE_PORT", "5000"))
    except ValueError:
        port = 5000

    # Banner ASCII — consola Windows (cp1250) nu poate afişa caractere
    # Unicode precum săgeata "->".
    print("=" * 60)
    print(" Dropwise Dashboard")
    print(" -> http://127.0.0.1:" + str(port))
    print(" -> mod BLE: " + ble.get_mode() + "  (DROPWISE_BLE_MODE)")
    print(" -> mod HUB: " + nodes.get_hub_mode() + "  (DROPWISE_HUB_MODE)")
    print("=" * 60)
    app.run(host="0.0.0.0", port=port, debug=True)

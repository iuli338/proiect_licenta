"""
Dropwise — blueprint-uri Flask
==============================

Endpoint-urile sunt grupate pe domenii, fiecare într-un blueprint:
  pages  — pagini publice + autentificare (/, /dashboard, /api/auth*)
  setup  — provisioning BLE (/api/setup/*)
  hub    — proxy/mock către hub (/api/hub/*)
  nodes  — catalog + configurare noduri (/api/catalog, /api/node/*)

app.py le înregistrează pe toate prin register_blueprints(app).
"""

from .pages import bp as pages_bp
from .setup import bp as setup_bp
from .hub import bp as hub_bp
from .nodes import bp as nodes_bp


def register_blueprints(app):
    """Înregistrează toate blueprint-urile pe aplicaţia Flask."""
    app.register_blueprint(pages_bp)
    app.register_blueprint(setup_bp)
    app.register_blueprint(hub_bp)
    app.register_blueprint(nodes_bp)

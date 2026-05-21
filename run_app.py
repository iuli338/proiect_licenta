"""
Dropwise — launcher pentru varianta desktop (.exe)
==================================================

Porneşte serverul Flask într-un thread de fundal şi deschide aplicaţia
într-o fereastră nativă (pywebview), fără browser.

Folosit ca punct de intrare pentru build-ul PyInstaller. Pentru dezvoltare
normală se foloseşte în continuare `python app.py`.
"""

import sys
import threading
from pathlib import Path

import webview

# Asigurăm un .env lângă executabil înainte de a importa app (care încarcă
# variabilele de mediu la import).
if getattr(sys, "frozen", False):
    app_dir = Path(sys.executable).parent
    env_file = app_dir / ".env"
    example  = Path(sys._MEIPASS) / ".env.example"
    # La prima rulare, dacă nu există .env, îl creăm din şablon.
    if not env_file.exists() and example.exists():
        env_file.write_bytes(example.read_bytes())
    # load_dotenv() din app.py caută în cwd — asigurăm cwd corect.
    import os
    os.chdir(app_dir)

from app import app, load_state   # noqa: E402 — după chdir

PORT = 5000


def run_server():
    """Rulează Flask. debug/reloader OBLIGATORIU oprite într-un bundle."""
    app.run(host="127.0.0.1", port=PORT, debug=False, use_reloader=False)


def main():
    load_state()   # creează data/state.json dacă lipseşte

    # Serverul rulează în fundal; fereastra nativă e thread-ul principal.
    threading.Thread(target=run_server, daemon=True).start()

    webview.create_window(
        "Dropwise",
        f"http://127.0.0.1:{PORT}",
        width=1280,
        height=820,
        min_size=(900, 600),
    )
    webview.start()


if __name__ == "__main__":
    main()

"""
Dropwise — nucleu comun
=======================

Căi de fişiere, persistenţa stării (state.json) şi constante de configurare.
Importat de app.py şi de toate blueprint-urile din routes/.
Nu importă nimic din restul aplicaţiei — evită importurile circulare.
"""

import json
import os
import sys
from pathlib import Path


# ---------------------------------------------------------------- căi

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

DATA_DIR   = BASE_DIR / "data"
STATE_FILE = DATA_DIR / "state.json"


# ---------------------------------------------------------------- config

# Cât timp rămâne valid cookie-ul cu codul de acces (în secunde).
SESSION_TIMEOUT = 60 * 60 * 8   # 8 ore

# Numele de nod valide — deocamdată fixe; în live vor veni din /status.
VALID_NODE_NAMES = ("P1", "P2", "P3")

# Starea iniţială (creată la primul start, dacă fişierul lipseşte).
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
        # Configuraţie per NOD, cheia = numele nodului ("P1", "P2", "P3").
        # Configuraţia aparţine nodului, nu portului — nodul poate fi mutat
        # pe alt slot fizic şi îşi păstrează planta/solul/culoarea.
    },
    "logs": [],   # loguri persistente (TODO: rotire)
}


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
        # Fişier corupt — rescriu cu default şi continui.
        save_state(DEFAULT_STATE)
        return json.loads(json.dumps(DEFAULT_STATE))


def save_state(state: dict) -> None:
    """Scrie starea atomic (scriu într-un .tmp şi redenumesc)."""
    DATA_DIR.mkdir(exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    tmp.replace(STATE_FILE)

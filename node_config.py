"""
Dropwise — configurarea nodurilor (plante, sol, regulator)
==========================================================

Conţine:
  - cataloagele de plante şi tipuri de sol
  - derivarea parametrilor regulatorului din alegerile utilizatorului
  - abstracţia hub-ului: mock (test) şi real (live, prin HTTP) — selectabile
    prin DROPWISE_HUB_MODE = "mock" | "real"

Modelul de configurare al unui nod (salvat în state.json["nodes"][port]):
  {
    "plant":  {"id": "ficus", "name": "Ficus", "water_need": "mediu",
               "custom": false},
    "soil":   {"id": "universal", "name": "Sol universal",
               "retention": "mediu", "custom": false},
    "color":  "mint",                       # cheie din NODE_COLORS
    "regulator": {...},                     # derivat — vezi derive_regulator()
    "configured": true
  }
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------- cataloage
#
# Plantele, solurile şi culorile sunt date EDITABILE, păstrate într-un fişier
# JSON separat (data/catalog.json). Pot fi adăugate/scoase fără modificări de
# cod — interfaţa le preia dinamic. Loader-ul re-citeşte fişierul când se
# modifică (după mtime), deci editările au efect fără repornirea serverului.

# Niveluri valide pentru necesar de apă / retenţie sol.
WATER_NEED_LEVELS = ("scazut", "mediu", "ridicat")
RETENTION_LEVELS  = ("scazut", "mediu", "ridicat")

# Calea fişierului de catalog (data/catalog.json, lângă acest modul).
_CATALOG_FILE = Path(__file__).resolve().parent / "data" / "catalog.json"

# Catalog implicit — folosit dacă fişierul lipseşte sau e corupt.
_DEFAULT_CATALOG = {
    "plants": [
        {"id": "ficus", "name": "Ficus", "water_need": "mediu"},
    ],
    "soils": [
        {"id": "universal", "name": "Sol universal", "retention": "mediu"},
    ],
    "colors": [
        {"id": "mint", "name": "Mentă", "accent": "152 60% 70%"},
    ],
}

# Cache + mtime-ul fişierului la ultima citire.
_catalog_cache: dict = {}
_catalog_mtime: float = 0.0
_catalog_lock = threading.Lock()


def load_catalog() -> dict:
    """
    Returnează catalogul (plants/soils/colors) din data/catalog.json.
    Re-citeşte fişierul doar dacă s-a modificat de la ultima citire.
    La fişier lipsă/corupt cade pe catalogul implicit.
    """
    global _catalog_cache, _catalog_mtime

    with _catalog_lock:
        try:
            mtime = _CATALOG_FILE.stat().st_mtime
        except OSError:
            # Fişier inexistent — folosim implicitul.
            if not _catalog_cache:
                _catalog_cache = json.loads(json.dumps(_DEFAULT_CATALOG))
            return _catalog_cache

        if _catalog_cache and mtime == _catalog_mtime:
            return _catalog_cache   # nemodificat — întoarcem cache-ul

        try:
            with _CATALOG_FILE.open("r", encoding="utf-8") as f:
                data = json.load(f)
            _catalog_cache = {
                "plants": data.get("plants", []),
                "soils":  data.get("soils", []),
                "colors": data.get("colors", []),
            }
            _catalog_mtime = mtime
        except (json.JSONDecodeError, OSError):
            # Fişier corupt — păstrăm ultimul cache valid sau implicitul.
            if not _catalog_cache:
                _catalog_cache = json.loads(json.dumps(_DEFAULT_CATALOG))

        return _catalog_cache


# ---------------------------------------------------------------- regulator

# Praguri de umiditate a solului (%) după nivelul de necesar al plantei.
# target = umiditatea la care vrem să ţinem solul.
_WATER_TARGET = {"scazut": 35, "mediu": 50, "ridicat": 65}
# Histerezis de bază — sub (target - hysteresis) pornim udarea.
_BASE_HYSTERESIS = 8


def derive_regulator(water_need: str, retention: str) -> dict:
    """
    Derivă parametrii regulatorului din necesarul plantei şi retenţia solului.

    Regulatorul de pe nod menţine umiditatea solului în jurul unui prag:
      - target_moisture : umiditatea ţintă (%)
      - hysteresis      : porneşte udarea sub (target - hysteresis)
      - dose_ml         : cantitatea per ciclu de udare (ml)
      - check_interval_min : la cât timp re-evaluează nodul

    Solul cu retenţie scăzută => doze mai mici, verificări mai dese.
    """
    target = _WATER_TARGET.get(water_need, 50)

    # Sol care reţine puţin => histerezis mai mic (reacţionăm mai repede).
    hyst = _BASE_HYSTERESIS
    if retention == "scazut":
        hyst -= 2
    elif retention == "ridicat":
        hyst += 3

    # Doza per ciclu: plantele cu necesar mare primesc mai mult; solul
    # drenant primeşte mai puţin odată (ca să nu treacă apa pe lângă).
    dose = {"scazut": 60, "mediu": 110, "ridicat": 160}[water_need]
    if retention == "scazut":
        dose = int(dose * 0.7)
    elif retention == "ridicat":
        dose = int(dose * 1.15)

    # Interval de verificare: sol drenant => verificăm mai des.
    interval = {"scazut": 45, "mediu": 90, "ridicat": 120}[retention]

    return {
        "target_moisture": target,
        "hysteresis": hyst,
        "dose_ml": dose,
        "check_interval_min": interval,
    }


def explain_regulator(reg: dict) -> list[str]:
    """Returnează explicaţii lizibile pentru parametrii derivaţi —
    afişate utilizatorului la pasul de sumar al wizardului."""
    return [
        f"Solul va fi menţinut în jurul a {reg['target_moisture']}% umiditate.",
        f"Udarea porneşte când umiditatea scade sub "
        f"{reg['target_moisture'] - reg['hysteresis']}%.",
        f"Fiecare ciclu de udare livrează aproximativ {reg['dose_ml']} ml.",
        f"Nodul reevaluează starea la fiecare {reg['check_interval_min']} minute.",
    ]


# ---------------------------------------------------------------- mod hub

def get_hub_mode() -> str:
    """Returnează modul hub: 'mock' (implicit) sau 'real'.
    Citit din .env prin DROPWISE_HUB_MODE."""
    mode = os.environ.get("DROPWISE_HUB_MODE", "mock").strip().lower()
    return "real" if mode == "real" else "mock"


# ---------------------------------------------------------------- job trimitere

@dataclass
class ConfigJob:
    """
    Starea trimiterii configuraţiei unui nod către ESP32.
      status: pending | sending | success | error
    """
    id: str
    node: str                       # numele nodului (P1/P2/P3)
    status: str = "pending"
    message: str = ""
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "node": self.node,
            "status": self.status,
            "message": self.message,
            "done": self.status in ("success", "error"),
        }

    def update(self, **kw) -> None:
        for k, v in kw.items():
            setattr(self, k, v)


_jobs: dict[str, ConfigJob] = {}
_jobs_lock = threading.Lock()


def get_config_job(job_id: str) -> Optional[ConfigJob]:
    with _jobs_lock:
        return _jobs.get(job_id)


def _register_job(node: str) -> ConfigJob:
    job = ConfigJob(id=uuid.uuid4().hex[:12], node=node)
    with _jobs_lock:
        _jobs[job.id] = job
    return job


# ---------------------------------------------------------------- backend hub

class MockHub:
    """
    Hub simulat pentru dezvoltare/test, fără ESP32.
    Reproduce temporizarea trimiterii configuraţiei.
    """

    def send_config(self, job: ConfigJob, node: str, config: dict) -> None:
        job.update(status="sending",
                   message=f"Se trimite configuraţia către nodul {node}…")
        time.sleep(2.0)   # simulează transmisia ESP-NOW hub -> nod
        job.update(status="success",
                   message="Nodul a confirmat primirea configuraţiei.")


class RealHub:
    """
    Trimitere reală a configuraţiei către ESP32, prin hub-ul HTTP.

    NOTĂ: endpoint-ul de pe hub care propagă configuraţia la nod prin
    ESP-NOW nu este încă implementat în firmware. Această clasă e pregătită
    pentru momentul în care va exista.
    """

    def __init__(self, hub_ip: str):
        self.hub_ip = hub_ip

    def send_config(self, job: ConfigJob, node: str, config: dict) -> None:
        try:
            import requests
        except ImportError:
            job.update(status="error",
                       message="Biblioteca 'requests' nu este instalată.")
            return

        job.update(status="sending",
                   message=f"Se trimite configuraţia către nodul {node}…")
        try:
            # TODO(live): endpoint real pe hub — ex. POST /node/<name>/config
            # Hub-ul propagă apoi configuraţia la nod prin ESP-NOW.
            r = requests.post(
                f"http://{self.hub_ip}/node/{node}/config",
                json=config, timeout=5,
            )
            r.raise_for_status()
            job.update(status="success",
                       message="Nodul a confirmat primirea configuraţiei.")
        except Exception as e:   # noqa: BLE001
            job.update(status="error",
                       message=f"Trimitere eşuată: {e}")


def _get_hub(hub_ip: Optional[str]):
    """Fabrică: hub mock sau real, după DROPWISE_HUB_MODE."""
    if get_hub_mode() == "real" and hub_ip:
        return RealHub(hub_ip)
    return MockHub()


def start_config_send(node: str, config: dict,
                      hub_ip: Optional[str] = None) -> ConfigJob:
    """
    Porneşte trimiterea configuraţiei către nod într-un thread de fundal.
    Frontend-ul urmăreşte apoi get_config_job(job.id).
    """
    job = _register_job(node)
    hub = _get_hub(hub_ip)

    def _worker():
        try:
            hub.send_config(job, node, config)
        except Exception as e:   # noqa: BLE001
            job.update(status="error", message=f"Eroare neaşteptată: {e}")

    threading.Thread(target=_worker, name=f"node-config-{job.id}",
                     daemon=True).start()
    return job


# ---------------------------------------------------------------- validare

def build_node_config(payload: dict) -> tuple[Optional[dict], Optional[str]]:
    """
    Validează payload-ul din wizard şi construieşte modelul de config al
    nodului. Returnează (config, None) la succes sau (None, mesaj_eroare).
    """
    plant = payload.get("plant") or {}
    soil  = payload.get("soil") or {}
    color = (payload.get("color") or "mint").strip()

    # --- plantă ---
    plant_name = (plant.get("name") or "").strip()
    if not plant_name:
        return None, "Numele plantei lipseşte."
    water_need = (plant.get("water_need") or "mediu").strip()
    if water_need not in WATER_NEED_LEVELS:
        return None, "Nivel de necesar de apă invalid."
    plant_custom = bool(plant.get("custom"))
    plant_id = (plant.get("id") or "custom").strip()

    # --- sol ---
    soil_name = (soil.get("name") or "").strip()
    if not soil_name:
        return None, "Numele solului lipseşte."
    retention = (soil.get("retention") or "mediu").strip()
    if retention not in RETENTION_LEVELS:
        return None, "Nivel de retenţie a solului invalid."
    soil_custom = bool(soil.get("custom"))
    soil_id = (soil.get("id") or "custom").strip()

    # --- culoare ---
    valid_colors = {c["id"] for c in load_catalog()["colors"]}
    if color not in valid_colors:
        # Cădem pe prima culoare din catalog (sau "mint").
        color = next(iter(valid_colors)) if valid_colors else "mint"

    regulator = derive_regulator(water_need, retention)

    config = {
        "plant": {
            "id": plant_id, "name": plant_name,
            "water_need": water_need, "custom": plant_custom,
        },
        "soil": {
            "id": soil_id, "name": soil_name,
            "retention": retention, "custom": soil_custom,
        },
        "color": color,
        "regulator": regulator,
        "configured": True,
        # Momentul configurării — folosit ca "dată de creare" în statistici.
        "created_at": time.time(),
    }
    return config, None


# ---------------------------------------------------------------- statistici

def _mock_stats(node: str, config: dict) -> dict:
    """
    Statistici simulate pentru un nod (mod test). Valorile sunt STABILE per
    nod — derivate determinist din numele nodului — ca să nu sară la fiecare
    cerere. În modul live, datele reale vor veni din EEPROM-ul nodului.
    """
    # Sămânţă deterministă din numele nodului.
    seed = sum(ord(c) for c in node)
    waterings = 40 + seed % 120          # număr total de udări
    dose = config.get("regulator", {}).get("dose_ml", 110)
    total_ml = waterings * dose
    uptime_days = 5 + seed % 60

    created = config.get("created_at") or (time.time() - uptime_days * 86400)

    return {
        "created_at": created,
        "last_seen": time.time() - (seed % 30) * 60,   # acum câteva minute
        "uptime_days": uptime_days,
        "total_waterings": waterings,
        "total_ml": total_ml,
        "avg_ml_per_watering": dose,
        "last_watering": time.time() - (seed % 18) * 3600,
        "mock": True,
    }


def get_node_stats(node: str, config: Optional[dict],
                   hub_ip: Optional[str] = None) -> Optional[dict]:
    """
    Returnează statisticile unui nod.
      - mock: valori simulate stabile (vezi _mock_stats).
      - real: cere statisticile de la hub. ESP32-ul administrează totul în
        EEPROM (nr. udări, ml, ultima conectare) — serverul doar le transmite
        mai departe, iar frontend-ul le afişează.
    Returnează None dacă nodul nu are configuraţie.
    """
    if not config or not config.get("configured"):
        return None

    if get_hub_mode() == "mock":
        return _mock_stats(node, config)

    # --- mod real: statisticile vin de la hub (EEPROM nod) ---
    if not hub_ip:
        return None
    try:
        import requests
    except ImportError:
        return None
    try:
        # TODO(live): endpoint pe firmware-ul hub-ului care citeşte
        # statisticile din EEPROM-ul nodului.
        r = requests.get(f"http://{hub_ip}/node/{node}/stats", timeout=3)
        r.raise_for_status()
        data = r.json()
        data["mock"] = False
        return data
    except Exception:   # noqa: BLE001 — hub indisponibil / firmware fără endpoint
        return None

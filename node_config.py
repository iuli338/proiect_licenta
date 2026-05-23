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
import math
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


# ---------------------------------------------------------------- model + regulator
#
# Modelul de proces (umiditatea solului) e de ordinul 1:
#     h(t) = h_inf + (h0 - h_inf) * exp(-t / tau)
# Identificat din 10 zile de date experimentale — vezi misc/model_regulator.md
# şi misc/identificare_model.py. Valorile de mai jos vin din acel script.
#
# SOLUL  alege parametrii MODELULUI       (K, tau)
# PLANTA alege parametrii REGULATORULUI   (setpoint, lambda → Kp, Ki)

# Câştig nominal în zona de operare (~setpoint), comun pentru toate solurile.
# K depinde de senzor/ghiveci, nu de tipul solului; neliniaritatea pe stare
# de umiditate e corectată automat de termenul integral al PI-ului.
_K_NOMINAL = 1.5     # % umiditate per ml apă

# Constanta de timp a uscării, în ore. Identificată pe segmentul de 96h al
# experimentului: tau ~= 32 h pentru un sol cu retenţie medie ("universal").
# Retenţia scalează tau: drenant pierde apa repede, turbă/argilos o reţin.
_TAU_REF_H = 31.7    # ore — referinţa pentru retenţie "mediu"
_FACTORI_TAU = {"scazut": 0.55, "mediu": 1.00, "ridicat": 1.70}

# Setpoint-ul (umiditatea ţintă) după necesarul de apă al plantei.
_SETPOINT = {"scazut": 35, "mediu": 50, "ridicat": 65}    # % umiditate

# Lambda IMC: constanta de timp dorită în bucla închisă, în ore.
# Mic = regulator agresiv (plante însetate); mare = regulator blând.
_LAMBDA_H = {"scazut": 48.0, "mediu": 30.0, "ridicat": 18.0}

# Histerezis fix pentru declanşare: udarea porneşte sub (setpoint - HISTEREZIS).
# Mic ca să nu lăsăm solul să cadă prea mult sub ţintă între udări (max o/zi).
_HISTEREZIS = 5

# Blocaj minim între două udări — promisiunea de proiect: cel mult o pe zi.
_INTERVAL_UDARE_MIN = 60 * 24    # 24 ore


def derive_model(retention: str) -> dict:
    """Parametrii modelului de proces, derivaţi din retenţia solului.

    Întoarce {K [%/ml], tau [h]} — vezi misc/model_regulator.md.
    """
    factor = _FACTORI_TAU.get(retention, 1.0)
    return {
        "K": _K_NOMINAL,
        "tau_h": round(_TAU_REF_H * factor, 1),
    }


def derive_regulator(water_need: str, retention: str) -> dict:
    """Parametrii regulatorului PI, acordaţi prin IMC pe modelul solului.

    Întoarce parametrii NOI (model + acordare IMC) plus câteva câmpuri
    LEGACY păstrate pentru compatibilitate cu firmware-ul ESP existent şi
    cu statisticile mock. Firmware-ul va fi adaptat ulterior la PI.

    Câmpuri noi:
      - model: {K, tau_h}                 — parametrii procesului (din sol)
      - setpoint              : umiditate ţintă [%]
      - hysteresis            : udare porneşte sub (setpoint - hysteresis) [%]
      - lambda_h              : constanta de timp dorită în b.î. [ore]
      - Kp                    : câştig proporţional [ml / % eroare]
      - Ki                    : câştig integral [ml / (% eroare · h)]
      - min_interval_min      : blocaj minim între udări [min]
      - dose_estimat_ml       : volum tipic al unei udări (pt. statistici/UI)

    Câmpuri legacy (acelaşi sens cu cele vechi, dar derivate din PI):
      - target_moisture       = setpoint
      - dose_ml               = dose_estimat_ml
      - check_interval_min    = min_interval_min
    """
    model = derive_model(retention)
    K, tau = model["K"], model["tau_h"]

    setpoint = _SETPOINT.get(water_need, 50)
    lam = _LAMBDA_H.get(water_need, 30.0)

    # Acordare IMC pentru proces de ordin 1: Kp = tau / (K · lambda), Ki = Kp / tau.
    Kp = tau / (K * lam)
    Ki = Kp / tau

    # Volumul TIPIC al unei udări — pentru afişare în UI şi statistici.
    # PI-ul îl calculează dinamic la fiecare udare; aici estimăm valoarea
    # de regim permanent: cât trebuie ca să compensăm evaporarea de o zi
    # şi să aducem solul de la (setpoint - histerezis) înapoi la setpoint.
    #
    # Pierderea zilnică (la 24h) pe modelul de ordin 1, pornind de la
    # setpoint, este aproximativ:  delta_h ≈ (setpoint - h_inf) · (1 - e^(-24/τ)).
    # h_inf ≈ 0% (sol uscat de echilibru); adăugăm şi histerezisul.
    pierdere_zilnica = setpoint * (1.0 - math.exp(-24.0 / tau))
    dose_estimat = (pierdere_zilnica + _HISTEREZIS) / K
    dose_estimat = max(15, min(200, int(round(dose_estimat))))

    return {
        # --- model (din sol) ---
        "model": model,
        # --- regulator (din plantă, acordat pe sol) ---
        "setpoint": setpoint,
        "hysteresis": _HISTEREZIS,
        "lambda_h": lam,
        "Kp": round(Kp, 3),
        "Ki": round(Ki, 4),
        "min_interval_min": _INTERVAL_UDARE_MIN,
        "dose_estimat_ml": dose_estimat,
        # --- legacy (pentru firmware ESP actual + statistici mock) ---
        "target_moisture": setpoint,
        "dose_ml": dose_estimat,
        "check_interval_min": _INTERVAL_UDARE_MIN,
    }


def explain_regulator(reg: dict) -> list[dict]:
    """Explicaţii lizibile pentru pasul de sumar al wizardului.

    Trei grupuri vizuale:
      sol        — parametrii modelului (K, τ) — vin din alegerea solului
      planta     — parametrii regulatorului (setpoint, λ, Kp, Ki) — din plantă
      functionare — comportamentul efectiv (când udă, cât udă)

    Front-end-ul afişează grupul ca etichetă colorată în faţa textului.
    """
    m = reg.get("model", {})
    K = m.get("K", _K_NOMINAL)
    tau = m.get("tau_h", _TAU_REF_H)
    return [
        {"group": "sol",
         "text": f"Model identificat din date — câştig K = {K} % umiditate / ml apă."},
        {"group": "sol",
         "text": f"Constantă de timp a uscării τ = {tau} h "
                 f"(cât rezistă solul fără udare)."},
        {"group": "planta",
         "text": f"Setpoint {reg['setpoint']}% umiditate, λ = "
                 f"{reg['lambda_h']:.0f} h (cât de prompt reacţionează regulatorul)."},
        {"group": "planta",
         "text": f"Regulator PI acordat prin IMC: Kp = {reg['Kp']}, "
                 f"Ki = {reg['Ki']} ml/(%·h)."},
        {"group": "functionare",
         "text": f"Udarea porneşte când umiditatea scade sub "
                 f"{reg['setpoint'] - reg['hysteresis']}%, cel mult o dată la 24 h."},
        {"group": "functionare",
         "text": f"Volum estimat per udare ≈ {reg['dose_estimat_ml']} ml "
                 f"(PI-ul ajustează dinamic în funcţie de eroare)."},
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
    Trimitere reală a configuraţiei către hub-ul ESP32, prin HTTP.

    Hub-ul persistă configul în EEPROM-ul AT24C256 (vezi firmware-ul:
    hub_http_node.ino + hub_storage.ino). Endpoint-ul aşteaptă câmpuri
    "flat" în JSON (plant_id, plant_name, water_need, soil_id, K, tau_h, ...)
    pe care le împachetăm aici din structura noastră nested.
    """

    def __init__(self, hub_ip: str):
        self.hub_ip = hub_ip
        # Codul de acces — poate fi setat ulterior de start_config_send.
        self.access_code: Optional[str] = None

    def send_config(self, job: ConfigJob, node: str, config: dict) -> None:
        try:
            import requests
        except ImportError:
            job.update(status="error",
                       message="Biblioteca 'requests' nu este instalată.")
            return

        # Construim payload-ul "flat" pentru firmware.
        plant = config.get("plant", {}) or {}
        soil  = config.get("soil", {}) or {}
        reg   = config.get("regulator", {}) or {}
        model = reg.get("model", {}) or {}

        flat = {
            # plant
            "plant_id":     plant.get("id", ""),
            "plant_name":   plant.get("name", ""),
            "water_need":   plant.get("water_need", "mediu"),
            "plant_custom": 1 if plant.get("custom") else 0,
            # soil
            "soil_id":      soil.get("id", ""),
            "soil_name":    soil.get("name", ""),
            "retention":    soil.get("retention", "mediu"),
            "soil_custom":  1 if soil.get("custom") else 0,
            # color + meta
            "color":        config.get("color", "mint"),
            "created_at":   int(config.get("created_at") or 0),
            # regulator
            "K":                model.get("K", 1.5),
            "tau_h":            model.get("tau_h", 31.7),
            "lambda_h":         reg.get("lambda_h", 30.0),
            "Kp":               reg.get("Kp", 0.7),
            "Ki":               reg.get("Ki", 0.0222),
            "setpoint":         reg.get("setpoint", 50),
            "hysteresis":       reg.get("hysteresis", 5),
            "min_interval_min": reg.get("min_interval_min", 1440),
            "dose_estimat_ml":  reg.get("dose_estimat_ml", 25),
        }

        job.update(status="sending",
                   message=f"Se trimite configuraţia către nodul {node}…")
        try:
            # Codul de acces e cerut de orice endpoint privat pe hub. Vine
            # de obicei din cookie-ul utilizatorului (via start_config_send),
            # cu fallback la variabila de mediu, apoi la codul implicit.
            access_code = (self.access_code
                           or os.environ.get("DROPWISE_HUB_ACCESS_CODE")
                           or "284095")
            r = requests.post(
                f"http://{self.hub_ip}/node/{node}/config",
                headers={"X-Access-Code": access_code},
                json=flat, timeout=8,
            )
            r.raise_for_status()
            job.update(status="success",
                       message="Hub-ul a confirmat scrierea în EEPROM.")
        except Exception as e:   # noqa: BLE001
            job.update(status="error",
                       message=f"Trimitere eşuată: {e}")


def _get_hub(hub_ip: Optional[str]):
    """Fabrică: hub mock sau real, după DROPWISE_HUB_MODE."""
    if get_hub_mode() == "real" and hub_ip:
        return RealHub(hub_ip)
    return MockHub()


def start_config_send(node: str, config: dict,
                      hub_ip: Optional[str] = None,
                      access_code: Optional[str] = None) -> ConfigJob:
    """
    Porneşte trimiterea configuraţiei către nod într-un thread de fundal.
    Frontend-ul urmăreşte apoi get_config_job(job.id).

    access_code — codul cu care vorbim cu hub-ul real (X-Access-Code). De
    obicei vine din cookie-ul utilizatorului; fără el cădem pe variabila
    DROPWISE_HUB_ACCESS_CODE / pe default.
    """
    job = _register_job(node)
    hub = _get_hub(hub_ip)
    if access_code:
        # Pasăm codul către RealHub prin atribut (nu schimbăm semnătura
        # MockHub care nu are nevoie de el).
        try:
            hub.access_code = access_code
        except AttributeError:
            pass

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

    # Override manual din UI (pagina "Parametri" -> Editează). Validăm fiecare
    # câmp şi îl suprascriem peste regulatorul derivat. Câmpurile lipsă se
    # păstrează din derivare; câmpurile invalide → eroare.
    override = payload.get("regulator_override")
    if override:
        regulator, err = _apply_regulator_override(regulator, override)
        if err:
            return None, err

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


# ---------------------------------------------------------------- override regulator
#
# Schema: per câmp, (tip, min, max). Domeniile sunt LARGI intenţionat
# (utilizatorul a fost avertizat că editează pe propriul risc); rejectăm
# doar valorile imposibile fizic (negative, zero la divizori, NaN).

_OVERRIDE_SCHEMA = {
    # Câmpurile de bază ale regulatorului
    "setpoint":          (float, 0.0,    100.0),     # % umiditate
    "hysteresis":        (float, 0.5,    50.0),      # % umiditate
    "lambda_h":          (float, 0.1,    500.0),     # ore
    "Kp":                (float, 0.0,    1000.0),    # ml / % eroare
    "Ki":                (float, 0.0,    100.0),     # ml / (% · h)
    "min_interval_min":  (int,   1,      10080),     # 1 min … 7 zile
    "dose_estimat_ml":   (int,   1,      2000),      # ml
    # Modelul (sub-obiect)
    "model.K":           (float, 0.001,  100.0),     # %/ml
    "model.tau_h":       (float, 0.1,    1000.0),    # ore
}


def _apply_regulator_override(reg: dict, override: dict):
    """Aplică un override validat peste regulator. Returnează (reg, err)."""
    reg = dict(reg)
    model = dict(reg.get("model") or {})

    for key, raw in override.items():
        if key not in _OVERRIDE_SCHEMA:
            return None, f"Parametru necunoscut: {key}"
        kind, lo, hi = _OVERRIDE_SCHEMA[key]
        try:
            val = kind(raw)
        except (TypeError, ValueError):
            return None, f"Valoare invalidă pentru {key}: {raw!r}"
        # Verificăm NaN / inf separat (float(nan) trece prin int).
        if isinstance(val, float) and not math.isfinite(val):
            return None, f"Valoare invalidă pentru {key}: {raw!r}"
        if val < lo or val > hi:
            return None, (f"Valoare în afara intervalului pentru {key}: "
                          f"{val} (admis {lo}..{hi})")
        if key.startswith("model."):
            model[key.split(".", 1)[1]] = val
        else:
            reg[key] = val

    if model:
        reg["model"] = model

    # Câmpurile legacy reflectă noile valori (pentru firmware-ul existent
    # şi pentru statistici mock care încă citesc dose_ml / target_moisture).
    reg["target_moisture"] = reg.get("setpoint", reg.get("target_moisture"))
    reg["dose_ml"] = reg.get("dose_estimat_ml", reg.get("dose_ml"))
    reg["check_interval_min"] = reg.get(
        "min_interval_min", reg.get("check_interval_min"))
    return reg, None


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

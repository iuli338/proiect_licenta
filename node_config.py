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

# Histerezis fix pentru declanşare: udarea porneşte sub (setpoint - HISTEREZIS).
_HISTEREZIS = 5

# ---------- Clase de udare ----------
#
# Fiecare plantă aparţine unei clase biologice — preferinţa pentru ritmul de
# udare. Înlocuieşte vechiul _LAMBDA_H (legat de water_need). Suculentele cer
# wet/dry cycle rar şi din plin; ierboasele cer umiditate constantă, doze mici
# dese. λ-ul regulatorului IMC se scalează cu T_min al clasei → regulator lent
# pentru plante rare, rapid pentru plante zilnice.
#
# Validat prin sim_10 (simulare/sim_10_clase_udare.py): cadenţa observată
# ≈ T_min cerut pe toate solurile, doar amplitudinea oscilaţiei variază.
_WATERING_CLASSES = {
    "foarte_rar": {
        "T_min_zile":     14.0,
        "target_dose_ml": 80,
        "lambda_h":       672.0,    # 28 zile — regulator foarte lent
        "label":          "Foarte rar (la 2 săptămâni)",
        "exemple":        "Yucca, Sansevieria, Cactus mari",
    },
    "rar": {
        "T_min_zile":     7.0,
        "target_dose_ml": 50,
        "lambda_h":       336.0,    # 14 zile
        "label":          "Rar (săptămânal)",
        "exemple":        "Cactus, Aloe, Crassula",
    },
    "echilibrat": {
        "T_min_zile":     3.0,
        "target_dose_ml": 30,
        "lambda_h":       144.0,    # 6 zile
        "label":          "Echilibrat (la 3 zile)",
        "exemple":        "Ficus, Monstera, Pothos",
    },
    "frecvent": {
        "T_min_zile":     1.5,
        "target_dose_ml": 20,
        "lambda_h":       72.0,     # 3 zile
        "label":          "Frecvent (la 1-2 zile)",
        "exemple":        "Spathiphyllum, Calathea",
    },
    "zilnic": {
        "T_min_zile":     0.5,
        "target_dose_ml": 15,
        "lambda_h":       24.0,     # 1 zi
        "label":          "Zilnic (de două ori pe zi)",
        "exemple":        "Mentă, busuioc, ferigi",
    },
}

# Valori valide pentru câmpul `watering_class`.
WATERING_CLASS_KEYS = tuple(_WATERING_CLASSES.keys())

# Clasa implicită pentru plante fără câmp explicit (catalog vechi sau plantă
# custom). "Echilibrat" e cea mai sigură — cadenţă moderată, doză moderată.
_WATERING_CLASS_DEFAULT = "echilibrat"

# Safety pe firmware: max timp fără udare = 1.2× T_min (override doar la
# întârziere > 20%). Vezi simulare/proces.py.
_SAFETY_MAX_FACTOR = 1.2


def derive_model(retention: str) -> dict:
    """Parametrii modelului de proces, derivaţi din retenţia solului.

    Întoarce {K [%/ml], tau [h]} — vezi misc/model_regulator.md.
    """
    factor = _FACTORI_TAU.get(retention, 1.0)
    return {
        "K": _K_NOMINAL,
        "tau_h": round(_TAU_REF_H * factor, 1),
    }


def derive_regulator(water_need: str, retention: str,
                     watering_class: str = _WATERING_CLASS_DEFAULT) -> dict:
    """Parametrii regulatorului PI, acordaţi prin IMC pe modelul solului.

    SOLUL  alege parametrii MODELULUI               (K, tau)         — din retention
    PLANTA alege SETPOINT-ul                        (35/50/65)        — din water_need
    PLANTA alege CADENŢA + DOZA + λ                 (T_min, target)   — din watering_class

    Câmpuri noi:
      - model: {K, tau_h}                 — parametrii procesului (din sol)
      - setpoint              : umiditate ţintă [%]              (din water_need)
      - hysteresis            : udare porneşte sub (setpoint - hysteresis) [%]
      - lambda_h              : constanta de timp în b.î. [ore]  (din watering_class)
      - Kp                    : câştig proporţional [ml / % eroare]
      - Ki                    : câştig integral [ml / (% eroare · h)]
      - T_min_min             : interval minim între udări [min] (din watering_class)
      - target_dose_ml        : doză ţintă per udare [ml]        (din watering_class)
      - safety_max_min        : max timp fără udare [min] (1.2× T_min)
      - watering_class        : cheia clasei alese
      - dose_estimat_ml       : volum tipic per udare (pt. statistici/UI) — = target_dose_ml
      - min_interval_min      : LEGACY = T_min_min (compat firmware vechi)

    Câmpuri legacy (păstrate pentru compatibilitate temporară):
      - target_moisture       = setpoint
      - dose_ml               = target_dose_ml
      - check_interval_min    = T_min_min
    """
    model = derive_model(retention)
    K, tau = model["K"], model["tau_h"]

    setpoint = _SETPOINT.get(water_need, 50)

    # Citim parametrii clasei de udare. Fallback la "echilibrat" pentru
    # plantele care nu au câmp `watering_class` în catalog (compat).
    cls = _WATERING_CLASSES.get(watering_class, _WATERING_CLASSES[_WATERING_CLASS_DEFAULT])
    T_min_zile = cls["T_min_zile"]
    T_min_min = int(round(T_min_zile * 24 * 60))
    target_dose_ml = int(cls["target_dose_ml"])
    lam = float(cls["lambda_h"])

    # Acordare IMC pentru proces de ordin 1: Kp = tau / (K · lambda), Ki = Kp / tau.
    Kp = tau / (K * lam)
    Ki = Kp / tau

    # Safety max: cel puţin 1.2× T_min, ca să nu intervină prea repede şi să
    # anuleze cadenţa biologică a clasei. Pentru "foarte_rar" (T_min=14 zile)
    # asta dă safety_max ≈ 17 zile.
    safety_max_min = int(round(_SAFETY_MAX_FACTOR * T_min_min))

    return {
        # --- model (din sol) ---
        "model": model,
        # --- regulator (acordat pe sol + clasă) ---
        "setpoint": setpoint,
        "hysteresis": _HISTEREZIS,
        "lambda_h": lam,
        "Kp": round(Kp, 3),
        "Ki": round(Ki, 4),
        # --- clasă de udare (NOU) ---
        "watering_class": watering_class if watering_class in _WATERING_CLASSES
                                         else _WATERING_CLASS_DEFAULT,
        "T_min_min": T_min_min,
        "target_dose_ml": target_dose_ml,
        "safety_max_min": safety_max_min,
        # Udare automată — OFF la prima configurare. Utilizatorul activează
        # explicit prin UI după ce verifică parametrii.
        "auto_watering_enabled": False,
        # --- alias-uri folosite în UI + firmware (acelaşi sens cu noile câmpuri) ---
        "min_interval_min": T_min_min,
        "dose_estimat_ml": target_dose_ml,
        # --- legacy (compat cu cod vechi care încă citeşte aceste chei) ---
        "target_moisture": setpoint,
        "dose_ml": target_dose_ml,
        "check_interval_min": T_min_min,
    }


def set_auto_watering(config: dict, enabled: bool) -> dict:
    """Setează flag-ul de udare automată într-un config de nod existent.

    Modifică obiectul în loc + îl întoarce. Folosit de endpoint-ul
    POST /api/node/<P>/auto-watering.
    """
    reg = config.setdefault("regulator", {})
    reg["auto_watering_enabled"] = bool(enabled)
    return config


def predict_next_watering(reg: dict, soil_moisture_pct: float,
                          minutes_since_last: float) -> Optional[dict]:
    """Estimează momentul + doza pentru următoarea udare.

    Identic algoritmic cu logica regulatorului din firmware (vezi
    misc/decizie_udare_diagrama.svg). Se ia minimul dintre:
      - timpul până umiditatea cade sub (setpoint - histerezis) — modelul
        exponenţial h(t) = h_curent · e^(-t/τ)
      - timpul rămas până la T_min (cadenţa biologică)
    şi se limitează sus de safety_max (override siguranţă).

    Args:
      reg: dict-ul de regulator (cum vine din derive_regulator).
      soil_moisture_pct: umiditatea curentă măsurată (%). NaN/None → None.
      minutes_since_last: minute de la ultima udare. 0 sau negativ → 0.

    Returnează:
      None — dacă nu putem prezice (date lipsă / umiditatea deja peste prag
             şi T_min nu s-a atins).
      {
        "minutes_until": int   — minute până la udarea estimată
        "estimated_dose_ml": int — doza estimată la momentul udării
        "reason": "prag" | "cadenta" | "safety"
      }
    """
    if soil_moisture_pct is None:
        return None
    try:
        h = float(soil_moisture_pct)
    except (TypeError, ValueError):
        return None
    if math.isnan(h) or math.isinf(h):
        return None

    dt = max(0.0, float(minutes_since_last or 0))

    setpoint     = float(reg.get("setpoint", 50))
    histerezis   = float(reg.get("hysteresis", _HISTEREZIS))
    T_min_min    = float(reg.get("T_min_min", reg.get("min_interval_min", 24*60)))
    safety_max   = float(reg.get("safety_max_min", T_min_min * _SAFETY_MAX_FACTOR))
    target_dose  = float(reg.get("target_dose_ml", reg.get("dose_estimat_ml", 30)))
    Kp           = float(reg.get("Kp", 0.7))

    model = reg.get("model", {})
    tau_h = float(model.get("tau_h", _TAU_REF_H))

    # 1. Timp până sub prag (h cade sub setpoint - histerezis prin uscare).
    prag = setpoint - histerezis
    if h <= prag:
        t_prag_min = 0.0   # deja sub prag
    elif h <= 0.5 or prag <= 0.0:
        t_prag_min = float("inf")   # imposibil de calculat
    else:
        # h(t) = h · exp(-t/τ_h) [τ în ore]
        # t = τ · ln(h/prag)  [ore]
        t_prag_min = tau_h * math.log(h / prag) * 60.0

    # 2. Timp până la T_min de la ultima udare.
    t_cadenta_min = max(0.0, T_min_min - dt)

    # 3. Safety max — override-uieşte tot.
    t_safety_min = max(0.0, safety_max - dt)

    # Decizia: trebuie să fie ÎN AFARA pragului (h sub setpoint - hist) ŞI
    # peste T_min. Deci aşteptăm până la MAX(t_prag, t_cadenta), dar nu
    # mai mult de t_safety.
    t_principal = max(t_prag_min, t_cadenta_min)

    if t_safety_min <= t_principal and t_safety_min < float("inf"):
        # Safety_max va interveni înainte ca celelalte condiţii să fie ok.
        minutes_until = t_safety_min
        reason = "safety"
    else:
        minutes_until = t_principal
        # Stabilim motivul predominant.
        if t_cadenta_min > t_prag_min:
            reason = "cadenta"
        else:
            reason = "prag"

    if minutes_until == float("inf"):
        return None

    # Estimarea dozei: la momentul udării, eroarea va fi h_at_udare faţă de
    # setpoint. Pentru simplitate folosim umiditatea la momentul atingerii
    # pragului ≈ prag, deci eroarea ≈ histerezis. PI livrează:
    # doza = max(Kp · histerezis, target_dose_ml), clamp.
    e_estim = histerezis
    doza_pi = Kp * e_estim
    estimated_dose = max(doza_pi, target_dose)
    estimated_dose = max(5, min(200, int(round(estimated_dose))))

    return {
        "minutes_until": int(round(minutes_until)),
        "estimated_dose_ml": estimated_dose,
        "reason": reason,
    }


def explain_regulator(reg: dict) -> list[dict]:
    """Explicaţii lizibile pentru pasul de sumar al wizardului.

    Patru grupuri vizuale:
      sol         — parametrii modelului (K, τ) — vin din alegerea solului
      planta      — setpoint-ul (umiditate ţintă) — din necesarul de apă
      udare       — clasa de udare (cadenţă + doză ţintă) — din specia plantei
      functionare — comportamentul efectiv (regulator PI, când udă, cât udă)

    Front-end-ul afişează grupul ca etichetă colorată în faţa textului.
    """
    m = reg.get("model", {})
    K = m.get("K", _K_NOMINAL)
    tau = m.get("tau_h", _TAU_REF_H)

    # Citim clasa de udare (poate lipsi dacă reg vine din override sau cod vechi).
    cls_key = reg.get("watering_class", _WATERING_CLASS_DEFAULT)
    cls = _WATERING_CLASSES.get(cls_key, _WATERING_CLASSES[_WATERING_CLASS_DEFAULT])
    T_min_zile = cls["T_min_zile"]
    if T_min_zile >= 1:
        cadenta_text = f"{T_min_zile:.0f} zile" if T_min_zile == int(T_min_zile) \
                       else f"{T_min_zile:.1f} zile"
    else:
        cadenta_text = f"{T_min_zile * 24:.0f} ore"

    return [
        {"group": "sol",
         "text": f"Model identificat din date — câştig K = {K} % umiditate / ml apă."},
        {"group": "sol",
         "text": f"Constantă de timp a uscării τ = {tau} h "
                 f"(cât rezistă solul fără udare)."},
        {"group": "planta",
         "text": f"Setpoint {reg['setpoint']}% umiditate "
                 f"(umiditatea ţintă pe care o menţinem)."},
        {"group": "udare",
         "text": f"Tipul de udare: <strong>{cls['label']}</strong> — "
                 f"udare cel puţin la {cadenta_text}, doză ţintă "
                 f"{reg['target_dose_ml']} ml."},
        {"group": "udare",
         "text": f"Exemple plante din această clasă: {cls['exemple']}."},
        {"group": "functionare",
         "text": f"Regulator PI acordat prin IMC: Kp = {reg['Kp']}, "
                 f"Ki = {reg['Ki']} ml/(%·h); λ = {reg['lambda_h']:.0f} h."},
        {"group": "functionare",
         "text": f"Udarea porneşte când umiditatea scade sub "
                 f"{reg['setpoint'] - reg['hysteresis']}% "
                 f"şi a trecut intervalul minim de la ultima udare."},
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
            "watering_class": plant.get("watering_class",
                                       reg.get("watering_class", "echilibrat")),
            # soil
            "soil_id":      soil.get("id", ""),
            "soil_name":    soil.get("name", ""),
            "retention":    soil.get("retention", "mediu"),
            "soil_custom":  1 if soil.get("custom") else 0,
            # color + meta
            "color":        config.get("color", "mint"),
            "created_at":   int(config.get("created_at") or 0),
            # regulator (clasic)
            "K":                model.get("K", 1.5),
            "tau_h":            model.get("tau_h", 31.7),
            "lambda_h":         reg.get("lambda_h", 30.0),
            "Kp":               reg.get("Kp", 0.7),
            "Ki":               reg.get("Ki", 0.0222),
            "setpoint":         reg.get("setpoint", 50),
            "hysteresis":       reg.get("hysteresis", 5),
            "min_interval_min": reg.get("min_interval_min", 1440),
            "dose_estimat_ml":  reg.get("dose_estimat_ml", 25),
            # clasă de udare (LAYOUT_VERSION 5+) — firmware-ul foloseşte
            # aceste câmpuri explicit pentru regulatorul automat.
            "T_min_min":        reg.get("T_min_min",
                                        reg.get("min_interval_min", 1440)),
            "target_dose_ml":   reg.get("target_dose_ml",
                                        reg.get("dose_estimat_ml", 25)),
            "safety_max_min":   reg.get("safety_max_min",
                                        int(reg.get("min_interval_min", 1440) * 1.2)),
            # auto-watering flag (LAYOUT_VERSION 6). Default 0 la prima
            # configurare; toggle separat prin POST /node/<P>/auto-watering.
            "auto_watering_enabled": 1 if reg.get("auto_watering_enabled") else 0,
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
            # IMPORTANT: trimitem cu ensure_ascii=False ca diacriticele
            # (ă, ş, î etc.) să ajungă pe ESP ca UTF-8 raw (2 octeţi/char),
            # NU ca literal "\uXXXX" (6 octeţi/char) — altfel câmpurile
            # char[24] din EEPROM se umplu cu "Substrat pe bază d…"
            # şi se trunchiază la mijlocul unui escape Unicode.
            body = json.dumps(flat, ensure_ascii=False).encode("utf-8")
            r = requests.post(
                f"http://{self.hub_ip}/node/{node}/config",
                headers={"X-Access-Code": access_code,
                         "Content-Type": "application/json; charset=utf-8"},
                data=body, timeout=8,
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

    # Lungimea maximă (octeţi UTF-8) pentru numele plantă/sol — limitată
    # de dimensiunea câmpurilor din EEPROM (char[32], minus \0 = 31 utili).
    NAME_MAX_BYTES = 31

    # --- plantă ---
    plant_name = (plant.get("name") or "").strip()
    if not plant_name:
        return None, "Numele plantei lipseşte."
    if len(plant_name.encode("utf-8")) > NAME_MAX_BYTES:
        return None, (
            f"Numele plantei e prea lung ({len(plant_name.encode('utf-8'))} "
            f"octeţi UTF-8; max {NAME_MAX_BYTES})."
        )
    water_need = (plant.get("water_need") or "mediu").strip()
    if water_need not in WATER_NEED_LEVELS:
        return None, "Nivel de necesar de apă invalid."
    plant_custom = bool(plant.get("custom"))
    plant_id = (plant.get("id") or "custom").strip()
    # Clasa de udare — biologic asociată plantei. Vine din catalog la cele
    # built-in; pentru plante custom utilizatorul o alege în wizard (sau
    # primeşte default "echilibrat").
    watering_class = (plant.get("watering_class") or _WATERING_CLASS_DEFAULT).strip()
    if watering_class not in WATERING_CLASS_KEYS:
        return None, (
            f"Clasă de udare invalidă: {watering_class}. "
            f"Valori valide: {', '.join(WATERING_CLASS_KEYS)}."
        )

    # --- sol ---
    soil_name = (soil.get("name") or "").strip()
    if not soil_name:
        return None, "Numele solului lipseşte."
    if len(soil_name.encode("utf-8")) > NAME_MAX_BYTES:
        return None, (
            f"Numele solului e prea lung ({len(soil_name.encode('utf-8'))} "
            f"octeţi UTF-8; max {NAME_MAX_BYTES})."
        )
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

    regulator = derive_regulator(water_need, retention, watering_class)

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
            "watering_class": watering_class,
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
    "lambda_h":          (float, 0.1,    1000.0),    # ore — extins pt. clasa "foarte_rar" (672h)
    "Kp":                (float, 0.0,    1000.0),    # ml / % eroare
    "Ki":                (float, 0.0,    100.0),     # ml / (% · h)
    "min_interval_min":  (int,   1,      30240),     # 1 min … 21 zile (alias T_min_min)
    "dose_estimat_ml":   (int,   1,      2000),      # ml (alias target_dose_ml)
    # Modelul (sub-obiect)
    "model.K":           (float, 0.001,  100.0),     # %/ml
    "model.tau_h":       (float, 0.1,    1000.0),    # ore
    # NOU — clasa de udare (LAYOUT_VERSION 5)
    "T_min_min":         (int,   1,      30240),     # 1 min … 21 zile
    "target_dose_ml":    (int,   1,      2000),      # ml — doza ţintă per udare
    "safety_max_min":    (int,   1,      40320),     # 1 min … 28 zile — max fără udare
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

    # Sincronizare reciprocă între câmpurile noi şi alias-urile legacy.
    # Utilizatorul poate seta fie "T_min_min", fie "min_interval_min" — le
    # ţinem identice. Acelaşi pentru target_dose_ml ↔ dose_estimat_ml.
    if "T_min_min" in override and "min_interval_min" not in override:
        reg["min_interval_min"] = reg["T_min_min"]
    elif "min_interval_min" in override and "T_min_min" not in override:
        reg["T_min_min"] = reg["min_interval_min"]

    if "target_dose_ml" in override and "dose_estimat_ml" not in override:
        reg["dose_estimat_ml"] = reg["target_dose_ml"]
    elif "dose_estimat_ml" in override and "target_dose_ml" not in override:
        reg["target_dose_ml"] = reg["dose_estimat_ml"]

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

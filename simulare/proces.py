"""
Dropwise — simulator proces + regulator
=======================================
Modul de bază pentru toate simulările. Implementează:

  • Modelul solului: ordin 1 cu uscare exponenţială
        dh/dt = -(h - h_inf) / tau + (K / 60) * u(t)
      unde u(t) e debitul instantaneu de apă (ml/min) şi h_inf ≈ 0%.
      Discretizat la dt = 1 min cu metoda Euler.

  • Regulatorul PI (acordat IMC):
        u_k = Kp · e_k + I_k
        I_k = I_{k-1} + Ki · e_k · dt
      Trigger: porneşte o udare DOAR când h cade sub (setpoint - histerezis)
      ŞI a trecut intervalul minim de la ultima udare. Doza calculată e
      tradusă într-un puls de ml; pompa livrează 3.21 ml/s (calibrat empiric).

  • Regulatorul bang-bang (referinţă, pentru sim_6):
        Porneşte udare cu doza_estimat_ml când h cade sub (setpoint - histerezis)
        ŞI a trecut intervalul minim. Fără termen integral.

Constantele K, τ, λ, setpoint, histerezis sunt sincronizate cu node_config.py.
"""

from __future__ import annotations

import math
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# Adăugăm parent dir la sys.path ca să putem importa node_config.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import node_config as nc  # noqa: E402


# ---------------------------------------------------------------- constante

# Pompa livrează 3.21 ml/s (calibrare empirică, vezi PUMP_FLOW_ML_PER_SEC).
PUMP_FLOW_ML_PER_SEC = 3.21

# Limita de doză per udare — clamp final ca să nu cerem 500 ml dacă regulatorul
# vrea să "corecteze" o eroare mare. Pe firmware limitatorul e 500 ml; aici
# folosim aceeaşi valoare ca să nu divergem.
DOZA_MAX_ML = 200
DOZA_MIN_ML = 5    # sub asta nu are sens — pompa nu poate doza precis

# Pasul de simulare în minute (integrarea ecuaţiei diferenţiale).
DT_MIN = 1.0
DT_H = DT_MIN / 60.0

# Pasul de citire/decizie al regulatorului în minute. Senzorii trimit SENSE
# la fiecare ~5s, dar regulatorul ia decizii mai rar — o dată la 10 min ca
# să elimine zgomotul şi să nu reacţioneze la spike-uri tranzitorii.
DT_REGULATOR_MIN = 10.0


# ---------------------------------------------------------------- clase de udare
#
# Fiecare plantă aparţine unei "clase de udare" — preferinţa biologică pentru
# ritmul de udare. Suculentele cer udare rară şi din plin (wet/dry cycle);
# ierboasele cer udare deasă şi puţin (umiditate constantă). λ-ul regulatorului
# IMC se scalează cu T_min ca regulatorul să aibă "ritmul" plantei.
#
# Aceleaşi valori vor fi mai târziu în node_config.py.

WATERING_CLASSES = {
    "foarte_rar": {
        "T_min_zile":     14.0,
        "target_dose_ml": 80,
        "lambda_h":       672.0,    # 28 zile — regulator foarte lent
        "label":          "Foarte rar (la 2 săptămâni)",
    },
    "rar": {
        "T_min_zile":     7.0,
        "target_dose_ml": 50,
        "lambda_h":       336.0,    # 14 zile
        "label":          "Rar (săptămânal)",
    },
    "echilibrat": {
        "T_min_zile":     3.0,
        "target_dose_ml": 30,
        "lambda_h":       144.0,    # 6 zile
        "label":          "Echilibrat (la 3 zile)",
    },
    "frecvent": {
        "T_min_zile":     1.5,
        "target_dose_ml": 20,
        "lambda_h":       72.0,     # 3 zile
        "label":          "Frecvent (la 1-2 zile)",
    },
    "zilnic": {
        "T_min_zile":     0.5,
        "target_dose_ml": 15,
        "lambda_h":       24.0,     # 1 zi
        "label":          "Zilnic (de două ori/zi)",
    },
}


# ---------------------------------------------------------------- modele

@dataclass
class Plant:
    """Reprezintă o alegere de plantă din wizard."""
    name: str
    water_need: str          # "scazut" | "mediu" | "ridicat" → setpoint
    watering_class: str = "echilibrat"   # cheie din WATERING_CLASSES → T_min, target_dose, λ


@dataclass
class Soil:
    """Reprezintă o alegere de sol din wizard."""
    name: str
    retention: str    # "scazut" | "mediu" | "ridicat"


@dataclass
class Scenariu:
    """Combinaţia plantă + sol + parametri opţionali."""
    plant: Plant
    soil: Soil
    # Suprascrieri opţionale (folosit la sim_5 pentru sensibilitate λ).
    lambda_h_override: Optional[float] = None
    # Etichetă pentru titluri / legenda.
    label: str = ""


@dataclass
class Params:
    """Parametrii derivaţi (model + regulator) pentru un scenariu.

    Identici cu cei calculaţi de node_config.derive_regulator,
    plus K din derive_model + (NOU) parametrii din clasa de udare.
    """
    K: float
    tau_h: float
    setpoint: float
    histerezis: float
    lambda_h: float
    Kp: float
    Ki: float
    dose_estimat_ml: float
    min_interval_min: int        # de la water_need (legacy, va deveni T_min_min)
    # Parametrii noi din clasa de udare:
    T_min_min: float = 0.0       # interval minim între udări (min) — de la clasa
    target_dose_ml: float = 0.0  # doza ţintă per udare (ml)
    watering_class: str = "echilibrat"


def params_din_scenariu(s: Scenariu) -> Params:
    """Calculează parametrii model+regulator din scenariul dat.

    Setpoint vine de la water_need (legacy).
    K, τ vin de la retention.
    T_min, target_dose, λ vin de la watering_class (NOU).
    Kp, Ki sunt recalculate IMC cu λ-ul din clasă (sau override).
    """
    model = nc.derive_model(s.soil.retention)
    reg = nc.derive_regulator(s.plant.water_need, s.soil.retention)

    # Citim parametrii din clasa de udare a plantei.
    cls = WATERING_CLASSES.get(s.plant.watering_class,
                                WATERING_CLASSES["echilibrat"])
    T_min_min = cls["T_min_zile"] * 24 * 60
    target_dose_ml = cls["target_dose_ml"]
    lambda_class = cls["lambda_h"]

    # λ vine prioritar de la: override > clasă de udare (NOU) > water_need (legacy).
    lam = s.lambda_h_override if s.lambda_h_override else lambda_class

    # Reacordare IMC: Kp = τ/(K·λ), Ki = Kp/τ. Întotdeauna recalculăm acum,
    # fiindcă λ se schimbă din clasa de udare, nu mai e cel din node_config.
    K = model["K"]
    tau = model["tau_h"]
    Kp = tau / (K * lam)
    Ki = Kp / tau

    return Params(
        K=K, tau_h=tau,
        setpoint=float(reg["setpoint"]),
        histerezis=float(reg["hysteresis"]),
        lambda_h=lam,
        Kp=Kp, Ki=Ki,
        dose_estimat_ml=float(reg["dose_estimat_ml"]),
        min_interval_min=int(reg["min_interval_min"]),
        T_min_min=T_min_min,
        target_dose_ml=float(target_dose_ml),
        watering_class=s.plant.watering_class,
    )


# ---------------------------------------------------------------- simulator

@dataclass
class Rezultat:
    """Ieşirea simulării — toate seriile temporale + lista udărilor."""
    t_min: list[float] = field(default_factory=list)         # timp (min)
    h: list[float] = field(default_factory=list)             # umiditate (%)
    h_masurat: list[float] = field(default_factory=list)     # h + zgomot senzor
    udari_t: list[float] = field(default_factory=list)       # momentele udărilor (min)
    udari_ml: list[float] = field(default_factory=list)      # doza per udare
    integral: list[float] = field(default_factory=list)      # I_k pentru debug

    # Metrici sumare
    @property
    def numar_udari(self) -> int:
        return len(self.udari_ml)

    @property
    def ml_total(self) -> float:
        return sum(self.udari_ml)

    @property
    def h_mediu(self) -> float:
        return sum(self.h) / max(1, len(self.h))

    @property
    def h_min(self) -> float:
        return min(self.h) if self.h else 0.0

    @property
    def h_max(self) -> float:
        return max(self.h) if self.h else 0.0


def simulate(
    scenariu: Scenariu,
    durata_zile: float = 7.0,
    h0: float = 30.0,
    seed_zgomot: Optional[int] = None,
    sigma_zgomot: float = 0.0,
    regulator: str = "pi",       # "pi" | "bangbang"
    strategie: str = "interval_fix",  # "interval_fix" | "prag_doza" | "hist_larg" | "predictie"
    # Parametri opţionali pentru strategii (None = default rezonabil per strategie)
    prag_doza_ml: Optional[float] = None,
    hist_larg_pct: Optional[float] = None,
    pred_ahead_min: Optional[float] = None,
    safety_max_zile: float = 7.0,
    safety_min_h: float = 6.0,
) -> Rezultat:
    """
    Simulează un scenariu pentru `durata_zile` zile, cu pas 1 min.

    Strategii de udare:
      • "interval_fix":  baseline — udă la fiecare min_interval_min (24h) când
                         h < setpoint - histerezis. Cum face firmware-ul acum.
      • "prag_doza":     udă DOAR când ml_calculat >= prag_doza_ml (default 15).
                         Plantele care cer puţin (Cactus) → cadenţă mai rară
                         (PI acumulează integral până ajunge la prag).
      • "hist_larg":     histerezis lărgit (default 15%) → cadenţă naturală
                         dictată de τ. Umezeşte până la setpoint.
      • "predictie":     calculează cu modelul exponenţial când va atinge
                         setpoint - histerezis; udă când t_pred < pred_ahead_min
                         (default 30 min).

    Safety nets comune tuturor strategiilor:
      • safety_min_h:    nu udă de 2× într-o oră (default 6h) — anti-twitch.
      • safety_max_zile: udă obligatoriu după N zile fără apă (default 7),
                         indiferent de strategie — planta nu trebuie să moară.
    """
    import numpy as np
    import math as _math

    p = params_din_scenariu(scenariu)
    n_steps = int(durata_zile * 24 * 60 / DT_MIN)

    rng = np.random.default_rng(seed_zgomot) if seed_zgomot is not None else None

    # Valori default per strategie (dacă utilizatorul nu le-a setat).
    if prag_doza_ml is None:    prag_doza_ml = 15.0
    if hist_larg_pct is None:   hist_larg_pct = 15.0
    if pred_ahead_min is None:  pred_ahead_min = 30.0

    safety_min_min  = safety_min_h * 60.0
    # Safety max: cel puţin T_min al clasei (ca să nu override-uim cadenţa),
    # dar nu mai mare decât 1.2× T_min (ca să intervenim totuşi la +20%
    # întârziere). Pentru cactus T_min=14 zile → safety_max ≈ 17 zile,
    # destul ca să nu calculăm o uscare totală în condiţii nominale.
    _T_min = params_din_scenariu(scenariu).T_min_min
    safety_max_min = max(safety_max_zile * 24 * 60, 1.2 * _T_min)

    h = float(h0)
    h_mas = h
    I = 0.0
    ultima_udare_min = -1e9

    pompare_rest_ml = 0.0
    pompare_rate_ml_per_min = PUMP_FLOW_ML_PER_SEC * 60.0

    rez = Rezultat()

    pasi_per_regulator = int(round(DT_REGULATOR_MIN / DT_MIN))
    DT_REG_H = DT_REGULATOR_MIN / 60.0

    for k in range(n_steps):
        t = k * DT_MIN
        e_regulator_tick = (k % pasi_per_regulator == 0)

        if e_regulator_tick:
            # ---- 1. Citire ----
            if rng is not None and sigma_zgomot > 0:
                h_mas = h + rng.normal(0.0, sigma_zgomot)
            else:
                h_mas = h

            e = p.setpoint - h_mas

            # ---- 2. Acumulator integral (numai pentru PI) ----
            if regulator == "pi" and pompare_rest_ml <= 0 and e > 0:
                I += p.Ki * e * DT_REG_H

            # ---- 3. Decizia: udăm sau nu, şi cu cât? ----
            if pompare_rest_ml <= 0:
                de_la_ultima = t - ultima_udare_min

                # Safety nets — verificate înaintea tuturor strategiilor.
                anti_twitch_ok = de_la_ultima >= safety_min_min
                must_water_now = (de_la_ultima >= safety_max_min and e > 0)

                doza_calculata = 0.0
                if regulator == "pi":
                    doza_calculata = p.Kp * e + I
                else:
                    doza_calculata = p.dose_estimat_ml

                ar_uda = False

                if must_water_now:
                    # Safety: au trecut 7+ zile fără udare şi suntem sub setpoint.
                    ar_uda = True
                elif not anti_twitch_ok:
                    ar_uda = False
                else:
                    # Strategia decide.
                    if strategie == "interval_fix":
                        ar_uda = (e > p.histerezis
                                  and de_la_ultima >= p.min_interval_min)

                    elif strategie == "prag_doza":
                        # Udăm doar dacă doza calculată depăşeşte pragul minim.
                        # Implicit: PI mai trebuie să fie deasupra histerezisului
                        # ca să nu udăm peste setpoint.
                        ar_uda = (e > p.histerezis
                                  and doza_calculata >= prag_doza_ml)

                    elif strategie == "hist_larg":
                        # Histerezis mai larg (15% vs 5%) → cadenţă naturală
                        # dictată de viteza de uscare.
                        ar_uda = (e > hist_larg_pct)

                    elif strategie == "predictie":
                        # Cu modelul h(t) = h_curent · e^(-t/τ), calculăm
                        # când va ajunge la pragul (setpoint - histerezis).
                        h_prag = p.setpoint - p.histerezis
                        if h_mas <= h_prag:
                            t_pred_min = 0.0
                        elif h_mas <= 0.1:
                            t_pred_min = 1e9
                        else:
                            # h_prag = h_mas · exp(-t / τ_h) ⇒ t = τ · ln(h/h_prag)
                            t_pred_h = p.tau_h * _math.log(h_mas / max(h_prag, 0.1))
                            t_pred_min = t_pred_h * 60.0
                        ar_uda = (t_pred_min < pred_ahead_min)

                    elif strategie == "clasa_planta":
                        # Constrângerea principală: cadenţa fiziologică a
                        # plantei (T_min). Sub T_min NU udăm, oricât ar
                        # implora PI. Eroare pe histerezis: trebuie să existe
                        # nevoie reală de apă.
                        ar_uda = (e > p.histerezis
                                  and de_la_ultima >= p.T_min_min)

                    else:
                        raise ValueError(f"strategie necunoscută: {strategie}")

                if ar_uda:
                    # Pentru strategia clasa_planta, doza minimă e target_dose
                    # (plantarea forţează "udare reală", nu duş).
                    if strategie == "clasa_planta":
                        doza = max(doza_calculata, p.target_dose_ml)
                    else:
                        doza = doza_calculata
                    doza = max(DOZA_MIN_ML, min(DOZA_MAX_ML, doza))
                    pompare_rest_ml = doza
                    ultima_udare_min = t
                    rez.udari_t.append(t)
                    rez.udari_ml.append(doza)
                    I = 0.0

        # ---- 3. Injectare apă în model ----
        if pompare_rest_ml > 0:
            ml_acum = min(pompare_rest_ml, pompare_rate_ml_per_min * DT_MIN)
            pompare_rest_ml -= ml_acum
            # K e în %/ml ⇒ creşterea instantanee a umidităţii din ml ăsta.
            dh_apa = p.K * ml_acum
        else:
            dh_apa = 0.0

        # ---- 4. Uscare exponenţială (h_inf = 0%) ----
        # Discretizare Euler: dh/dt = -h/tau (în ore) ⇒ pe dt minute:
        # dh = -h * (dt/60) / tau
        dh_uscare = -h * DT_H / p.tau_h

        # ---- 5. Aplicăm ambele efecte ----
        h = h + dh_apa + dh_uscare
        if h < 0: h = 0.0
        if h > 100: h = 100.0

        # ---- 6. Log ----
        rez.t_min.append(t)
        rez.h.append(h)
        rez.h_masurat.append(h_mas)
        rez.integral.append(I)

    return rez


# ---------------------------------------------------------------- helpers UI

def t_in_zile(t_min: list[float]) -> list[float]:
    """Convertor de la minute la zile pentru axa X."""
    return [t / (24 * 60) for t in t_min]


def afiseaza_metrici(rez: Rezultat, scenariu: Scenariu, params: Params) -> None:
    """Tipăreşte un sumar în consolă pentru fiecare simulare."""
    print(f"\n=== {scenariu.label or 'Scenariu'} ===")
    print(f"  Plantă: {scenariu.plant.name} (need={scenariu.plant.water_need})")
    print(f"  Sol:    {scenariu.soil.name} (retenţie={scenariu.soil.retention})")
    print(f"  Model:  K={params.K:.2f} %/ml  τ={params.tau_h:.1f} h")
    print(f"  Regulator: setpoint={params.setpoint:.0f}%  hist={params.histerezis:.0f}%")
    print(f"             λ={params.lambda_h:.0f}h  Kp={params.Kp:.3f}  Ki={params.Ki:.4f}")
    print(f"  Rezultat: {rez.numar_udari} udări · {rez.ml_total:.0f} ml total")
    print(f"            h în interval [{rez.h_min:.1f}%, {rez.h_max:.1f}%]  "
          f"medie={rez.h_mediu:.1f}%")

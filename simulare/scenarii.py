"""
Dropwise — preseturi de scenarii pentru simulări
=================================================
Combinaţii reprezentative plantă × sol, ca să nu repetăm aceleaşi obiecte
în fiecare script. Fiecare scenariu primeşte o etichetă scurtă, afişată pe
grafice.
"""

from __future__ import annotations
from simulare.proces import Plant, Soil, Scenariu


# ---------------------------------------------------------------- plante

# 3 plante reprezentative (necesar de apă diferit). Folosite în sim_1..sim_9.
# `watering_class` (NOU) ataşează cadenţa biologică — dictează T_min, target_dose, λ.
PLANTE = {
    "scazut":  Plant(name="Cactus", water_need="scazut", watering_class="rar"),
    "mediu":   Plant(name="Ficus",  water_need="mediu",  watering_class="echilibrat"),
    "ridicat": Plant(name="Mentă",  water_need="ridicat", watering_class="zilnic"),
}

# Galerie extinsă cu 5 plante reprezentative pentru cele 5 clase de udare
# (folosită în sim_10). Pereche specie ↔ clasă, biologic plauzibilă.
PLANTE_5 = {
    "foarte_rar": Plant(name="Yucca",        water_need="scazut", watering_class="foarte_rar"),
    "rar":        Plant(name="Cactus",       water_need="scazut", watering_class="rar"),
    "echilibrat": Plant(name="Ficus",        water_need="mediu",  watering_class="echilibrat"),
    "frecvent":   Plant(name="Spathiphyllum",water_need="mediu",  watering_class="frecvent"),
    "zilnic":     Plant(name="Mentă",        water_need="ridicat", watering_class="zilnic"),
}

# ---------------------------------------------------------------- soluri

SOLURI = {
    "scazut":  Soil(name="Sol drenant",   retention="scazut"),
    "mediu":   Soil(name="Sol universal", retention="mediu"),
    "ridicat": Soil(name="Turbă",         retention="ridicat"),
}


# ---------------------------------------------------------------- preseturi

# Scenariul "de referinţă" — folosit ca punct de pornire în multe simulări.
BAZA = Scenariu(
    plant=PLANTE["mediu"],
    soil=SOLURI["mediu"],
    label="Ficus în sol universal (mediu × mediu)",
)


def scenariu(plant_key: str, soil_key: str, label: str = "") -> Scenariu:
    """Helper pentru construirea rapidă a unui scenariu."""
    p = PLANTE[plant_key]
    s = SOLURI[soil_key]
    if not label:
        label = f"{p.name} ({plant_key}) × {s.name} ({soil_key})"
    return Scenariu(plant=p, soil=s, label=label)

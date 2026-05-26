"""
Simularea 9 — Strategii × toate combinaţiile (matrice de comparare)
====================================================================
Pe toate 9 combinaţiile plantă × sol rulăm cele 4 strategii şi comparăm:
  • Număr udări
  • ml total în 14 zile
  • Range h (h_max - h_min) — măsură a oscilaţiei
  • h_max — overshoot maxim observat

Întrebare: există o strategie care e mai bună pe TOATE combinaţiile, sau
fiecare are punctele ei tari?

Vizual: heatmap-uri colorate, fiecare metrică separat. Plus comparare directă
pe 3 scenarii reprezentative.
"""

from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding='utf-8')

import matplotlib.pyplot as plt
import numpy as np
from simulare.proces import simulate, params_din_scenariu
from simulare.scenarii import scenariu


OUTPUT = Path(__file__).resolve().parent / "output"
OUTPUT.mkdir(exist_ok=True)


PLANTE_KEYS = ["scazut", "mediu", "ridicat"]
SOLURI_KEYS = ["scazut", "mediu", "ridicat"]
STRATEGII = ["interval_fix", "prag_doza", "hist_larg", "predictie"]
STRATEGII_LABEL = [
    "Interval fix (24h)",
    "Prag pe doză (≥15ml)",
    "Histerezis lărgit (15%)",
    "Predicţie (30min)",
]

PLANT_LABEL = {"scazut": "Cactus", "mediu": "Ficus", "ridicat": "Mentă"}
SOIL_LABEL  = {"scazut": "Drenant", "mediu": "Universal", "ridicat": "Turbă"}


def ruleaza_grila(durata_zile: float = 14.0) -> dict:
    """Rulează toate combinaţiile şi întoarce metricile."""
    rezultate = {}
    for p_key in PLANTE_KEYS:
        for s_key in SOLURI_KEYS:
            sc = scenariu(p_key, s_key)
            for strat in STRATEGII:
                rez = simulate(sc, durata_zile=durata_zile, h0=30.0,
                              strategie=strat)
                rezultate[(p_key, s_key, strat)] = rez
    return rezultate


def heatmap(ax, valori: np.ndarray, titlu: str, fmt: str = "{:.0f}",
            cmap: str = "RdYlGn_r"):
    """Heatmap 3x3 — rânduri = plante, coloane = soluri."""
    im = ax.imshow(valori, cmap=cmap, aspect='auto')
    ax.set_xticks(range(3))
    ax.set_yticks(range(3))
    ax.set_xticklabels([SOIL_LABEL[k] for k in SOLURI_KEYS], fontsize=9)
    ax.set_yticklabels([PLANT_LABEL[k] for k in PLANTE_KEYS], fontsize=9)
    ax.set_title(titlu, fontsize=9, fontweight='bold')

    # Etichetele numerice peste celule
    for i in range(3):
        for j in range(3):
            color = "white" if im.norm(valori[i, j]) > 0.5 else "black"
            ax.text(j, i, fmt.format(valori[i, j]),
                    ha="center", va="center", color=color, fontsize=8)


def main() -> None:
    print("Rulez 9 combinaţii × 4 strategii × 14 zile (poate dura ~20s)...")
    rezultate = ruleaza_grila(durata_zile=14.0)

    # ---------- Heatmap-uri: udări per strategie ----------
    fig, axes = plt.subplots(4, 4, figsize=(15, 13))

    metrici = [
        ("Număr udări",    lambda r: float(r.numar_udari),  "{:.0f}",  "RdYlGn_r"),
        ("ml total (14z)", lambda r: r.ml_total,            "{:.0f}",  "Blues"),
        ("Range h [%]",    lambda r: r.h_max - r.h_min,     "{:.0f}",  "RdYlGn_r"),
        ("h max [%]",      lambda r: r.h_max,               "{:.0f}",  "RdYlGn_r"),
    ]

    for col_idx, strat in enumerate(STRATEGII):
        for row_idx, (metric_label, fn, fmt, cmap) in enumerate(metrici):
            ax = axes[row_idx][col_idx]
            mat = np.zeros((3, 3))
            for i, p_key in enumerate(PLANTE_KEYS):
                for j, s_key in enumerate(SOLURI_KEYS):
                    mat[i, j] = fn(rezultate[(p_key, s_key, strat)])
            titlu = f"{STRATEGII_LABEL[col_idx]}\n{metric_label}" if row_idx == 0 \
                else metric_label
            heatmap(ax, mat, titlu, fmt=fmt, cmap=cmap)

            # Y-label doar pe prima coloană
            if col_idx != 0:
                ax.set_yticklabels([])

    fig.suptitle(
        "Simularea 9 — Strategii × combinaţii plantă/sol (14 zile)\n"
        "Verde = bine, roşu = problematic. Coloane = strategii, "
        "rânduri = metrici.",
        fontsize=11, fontweight='bold', y=0.995)

    plt.tight_layout(rect=[0, 0, 1, 0.97])
    output_file = OUTPUT / "sim_9_strategii_grid.png"
    plt.savefig(output_file, dpi=130, bbox_inches='tight')
    print(f"\nGrafic salvat: {output_file}")

    # ---------- Tabel sumar în consolă ----------
    print("\n=== Sumar: ml total per strategie × scenariu (14 zile) ===\n")
    print(f"{'Scenariu':<28}", end="")
    for label in STRATEGII_LABEL:
        print(f"{label:>22}", end="")
    print()
    for p_key in PLANTE_KEYS:
        for s_key in SOLURI_KEYS:
            sc_label = f"{PLANT_LABEL[p_key]} × {SOIL_LABEL[s_key]}"
            print(f"{sc_label:<28}", end="")
            for strat in STRATEGII:
                rez = rezultate[(p_key, s_key, strat)]
                print(f"  {rez.numar_udari:2d}u/{rez.ml_total:4.0f}ml/"
                      f"{rez.h_max:4.0f}%", end="")
            print()

    # ---------- Concluzii automate ----------
    print("\n=== Observaţii din date ===")
    # 1. Care strategie are cele mai puţine overshoot-uri (h_max < 80%)?
    overshoot_count = {strat: 0 for strat in STRATEGII}
    for p_key in PLANTE_KEYS:
        for s_key in SOLURI_KEYS:
            for strat in STRATEGII:
                if rezultate[(p_key, s_key, strat)].h_max >= 80:
                    overshoot_count[strat] += 1
    print("  Overshoot ≥80% (out of 9):")
    for strat in STRATEGII:
        print(f"    {STRATEGII_LABEL[STRATEGII.index(strat)]:<28}: "
              f"{overshoot_count[strat]}/9")

    # 2. Cadenţa media per strategie pe Cactus+Turbă (plantă cu nevoie minimă)
    print(f"\n  Cactus × Turbă (planta-cea-mai-puţin-însetată):")
    for strat in STRATEGII:
        rez = rezultate[("scazut", "ridicat", strat)]
        print(f"    {STRATEGII_LABEL[STRATEGII.index(strat)]:<28}: "
              f"{rez.numar_udari:2d} udări/14zile "
              f"(o udare la {14/max(rez.numar_udari,1):.1f} zile)")

    # 3. Cadenţa medie pe Mentă+Drenant (plantă-cea-mai-însetată)
    print(f"\n  Mentă × Drenant (planta-cea-mai-însetată):")
    for strat in STRATEGII:
        rez = rezultate[("ridicat", "scazut", strat)]
        print(f"    {STRATEGII_LABEL[STRATEGII.index(strat)]:<28}: "
              f"{rez.numar_udari:2d} udări/14zile "
              f"(o udare la {14*24*60/(60*max(rez.numar_udari,1)):.1f} ore)")


if __name__ == "__main__":
    main()

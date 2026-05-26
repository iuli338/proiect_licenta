"""
Simularea 7 — Grila completă 3×3 (plante × soluri)
==================================================
Toate cele 9 combinaţii afişate compact, ca anexă în lucrare.

Rândurile = plante (necesar scăzut → mediu → ridicat)
Coloanele = soluri (drenant → universal → turbă)

Întrebare: cum se comportă sistemul Dropwise pe tot spectrul de combinaţii
pe care utilizatorul le poate alege din wizard?

Vizual: 9 subploturi compacte cu metrici inscripţionate.
"""

from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding='utf-8')

import matplotlib.pyplot as plt
from simulare.proces import simulate, params_din_scenariu, t_in_zile
from simulare.scenarii import scenariu


OUTPUT = Path(__file__).resolve().parent / "output"
OUTPUT.mkdir(exist_ok=True)


# Ordinele pe axe.
PLANTE_KEYS = ["scazut",  "mediu",   "ridicat"]
SOLURI_KEYS = ["scazut",  "mediu",   "ridicat"]

PLANT_LABEL = {
    "scazut":  "Cactus\n(need scăzut)",
    "mediu":   "Ficus\n(need mediu)",
    "ridicat": "Mentă\n(need ridicat)",
}
SOIL_LABEL = {
    "scazut":  "Drenant",
    "mediu":   "Universal",
    "ridicat": "Turbă",
}


def main() -> None:
    fig, axes = plt.subplots(3, 3, figsize=(14, 10), sharex=True, sharey=True)

    rezultate = {}
    for i, p_key in enumerate(PLANTE_KEYS):
        for j, s_key in enumerate(SOLURI_KEYS):
            s = scenariu(p_key, s_key)
            rez = simulate(s, durata_zile=7.0, h0=30.0)
            p = params_din_scenariu(s)
            rezultate[(p_key, s_key)] = (s, p, rez)

            ax = axes[i][j]
            zile = t_in_zile(rez.t_min)

            ax.axhspan(p.setpoint - p.histerezis, p.setpoint,
                       color='#b8f0c9', alpha=0.15)
            ax.axhline(p.setpoint, color='gray', linestyle='--',
                       linewidth=0.7, alpha=0.6)
            ax.plot(zile, rez.h, color='#2563a8', linewidth=1.3)

            for t, ml in zip(rez.udari_t, rez.udari_ml):
                ax.axvline(t / (24 * 60), color='#2563a8',
                           linewidth=0.4, alpha=0.3)

            # Metrici minime în colţ
            txt = (f"{rez.numar_udari}u · {rez.ml_total:.0f}ml\n"
                   f"medie {rez.h_mediu:.0f}%\n"
                   f"max {rez.h_max:.0f}%")
            ax.text(0.97, 0.07, txt, transform=ax.transAxes,
                    fontsize=7, ha='right', va='bottom', family='monospace',
                    bbox=dict(boxstyle='round,pad=0.25', facecolor='white',
                              edgecolor='gray', linewidth=0.5, alpha=0.9))

            ax.grid(True, alpha=0.2)
            ax.set_ylim(15, 100)

            # Etichete pe margini
            if i == 0:
                ax.set_title(SOIL_LABEL[s_key], fontsize=10, fontweight='bold')
            if j == 0:
                ax.set_ylabel(PLANT_LABEL[p_key], fontsize=9, fontweight='bold')
            if i == 2:
                ax.set_xlabel('zile')

    fig.suptitle(
        "Simularea 7 — Grilă completă 3×3 (plante × soluri)\n"
        "Toate combinaţiile din wizard: 7 zile, sol uscat la pornire (30%)",
        fontsize=12, fontweight='bold', y=0.995)

    plt.tight_layout(rect=[0, 0, 1, 0.97])
    output_file = OUTPUT / "sim_7_grid_complet.png"
    plt.savefig(output_file, dpi=130, bbox_inches='tight')
    print(f"\nGrafic salvat: {output_file}")

    # Matrice metrici în consolă
    print("\n=== Matrice ml total (ml apă livraţi în 7 zile) ===")
    header = "Plantă / Sol"
    print(f"  {header:<20}", end="")
    for s_key in SOLURI_KEYS:
        print(f"{SOIL_LABEL[s_key]:>15}", end="")
    print()
    for p_key in PLANTE_KEYS:
        print(f"  {PLANT_LABEL[p_key].replace(chr(10),' '):<20}", end="")
        for s_key in SOLURI_KEYS:
            _, _, rez = rezultate[(p_key, s_key)]
            print(f"{rez.ml_total:>14.0f}ml", end="")
        print()

    print("\n=== Matrice h_max (overshoot maxim observat) ===")
    header = "Plantă / Sol"
    print(f"  {header:<20}", end="")
    for s_key in SOLURI_KEYS:
        print(f"{SOIL_LABEL[s_key]:>15}", end="")
    print()
    for p_key in PLANTE_KEYS:
        print(f"  {PLANT_LABEL[p_key].replace(chr(10),' '):<20}", end="")
        for s_key in SOLURI_KEYS:
            _, _, rez = rezultate[(p_key, s_key)]
            marker = " !" if rez.h_max >= 95 else "  "
            print(f"{rez.h_max:>13.1f}%{marker}", end="")
        print()


if __name__ == "__main__":
    main()

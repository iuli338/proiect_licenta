"""
Simularea 10 — Strategia "clasa plantei": cadenţă biologică impusă
==================================================================
Cele 5 clase de udare cu 3 soluri = 15 scenarii. Strategia "clasa_planta"
forţează cadenţa biologică (T_min) şi livrează target_dose, indiferent
de cât de uscat sau retentiv e solul.

Întrebare: respectă regulatorul cadenţa biologică pe toate combinaţiile?

Vizual: grilă 5×3, fiecare subplot arată curba h(t) + udările.
Durată simulare: 21 zile (ca să vedem multiple cicluri pentru "foarte_rar").
"""

from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding='utf-8')

import matplotlib.pyplot as plt
from simulare.proces import simulate, params_din_scenariu, t_in_zile, WATERING_CLASSES
from simulare.scenarii import PLANTE_5, SOLURI, Scenariu


OUTPUT = Path(__file__).resolve().parent / "output"
OUTPUT.mkdir(exist_ok=True)


CLASE_KEYS = ["foarte_rar", "rar", "echilibrat", "frecvent", "zilnic"]
SOLURI_KEYS = ["scazut", "mediu", "ridicat"]

SOIL_LABEL = {"scazut": "Drenant", "mediu": "Universal", "ridicat": "Turbă"}


def main() -> None:
    durata = 21.0   # zile — ca să vedem 1.5 cicluri pentru foarte_rar
    fig, axes = plt.subplots(5, 3, figsize=(15, 13), sharex=True, sharey=True)

    rezultate = {}
    for i, cls_key in enumerate(CLASE_KEYS):
        for j, sol_key in enumerate(SOLURI_KEYS):
            s = Scenariu(
                plant=PLANTE_5[cls_key],
                soil=SOLURI[sol_key],
                label=f"{PLANTE_5[cls_key].name} × {SOLURI[sol_key].name}",
            )
            rez = simulate(s, durata_zile=durata, h0=30.0,
                          strategie="clasa_planta")
            p = params_din_scenariu(s)
            rezultate[(cls_key, sol_key)] = (s, p, rez)

            ax = axes[i][j]
            zile = t_in_zile(rez.t_min)

            ax.axhspan(p.setpoint - p.histerezis, p.setpoint,
                       color='#b8f0c9', alpha=0.10)
            ax.axhline(p.setpoint, color='gray', linestyle='--',
                       linewidth=0.7, alpha=0.6)
            ax.plot(zile, rez.h, color='#2563a8', linewidth=1.2)

            for t_ud, ml in zip(rez.udari_t, rez.udari_ml):
                ax.axvline(t_ud / (24 * 60), color='#2563a8',
                           linewidth=0.5, alpha=0.4)

            cadenta = durata / max(rez.numar_udari, 1)
            metric = (f"{rez.numar_udari}u · {rez.ml_total:.0f}ml\n"
                      f"cadenţă={cadenta:.1f}z\n"
                      f"h∈[{rez.h_min:.0f},{rez.h_max:.0f}]%")
            ax.text(0.97, 0.07, metric, transform=ax.transAxes,
                    fontsize=7, ha='right', va='bottom', family='monospace',
                    bbox=dict(boxstyle='round,pad=0.25',
                              facecolor='white', edgecolor='gray',
                              linewidth=0.5, alpha=0.9))

            ax.grid(True, alpha=0.2)
            ax.set_ylim(0, 100)
            if i == 0:
                ax.set_title(SOIL_LABEL[sol_key], fontsize=10, fontweight='bold')
            if j == 0:
                cls_label = WATERING_CLASSES[cls_key]["label"]
                ax.set_ylabel(
                    f"{cls_label}\n({PLANTE_5[cls_key].name})",
                    fontsize=8, fontweight='bold')
            if i == 4:
                ax.set_xlabel('zile')

    fig.suptitle(
        "Simularea 10 — Strategia \"clasa plantei\" (cadenţă biologică impusă)\n"
        f"5 clase × 3 soluri, {durata:.0f} zile, sol uscat la pornire (30%)",
        fontsize=12, fontweight='bold', y=0.995)

    plt.tight_layout(rect=[0, 0, 1, 0.97])
    output_file = OUTPUT / "sim_10_clase_udare.png"
    plt.savefig(output_file, dpi=130, bbox_inches='tight')
    print(f"\nGrafic salvat: {output_file}")

    # Tabel sumar
    print(f"\n=== Cadenţa observată per clasă × sol ({durata:.0f} zile) ===\n")
    print(f"{'Clasă (T_min cerut)':<32}", end="")
    for s_key in SOLURI_KEYS:
        print(f"{SOIL_LABEL[s_key]:>18}", end="")
    print()
    for cls_key in CLASE_KEYS:
        T_min_z = WATERING_CLASSES[cls_key]["T_min_zile"]
        target = WATERING_CLASSES[cls_key]["target_dose_ml"]
        label = f"{cls_key} (T={T_min_z:.1f}z, {target}ml)"
        print(f"  {label:<30}", end="")
        for sol_key in SOLURI_KEYS:
            _, _, rez = rezultate[(cls_key, sol_key)]
            cadenta = durata / max(rez.numar_udari, 1)
            print(f"  {rez.numar_udari:2d}u/{cadenta:4.1f}z/{rez.ml_total:4.0f}ml", end="")
        print()

    print("\n  Citire: 'Nu udări / cadenţă observată zile / ml total'")
    print("  Aşteptat: cadenţa observată ≈ T_min specificat (cu mici abateri din safety/τ).")


if __name__ == "__main__":
    main()

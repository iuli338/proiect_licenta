"""
Simularea 4 — Cazuri extreme (stres-test)
=========================================
Testează acordarea IMC la capetele spectrului:

  Worst-case (a) "însetat": Mentă (setpoint 65%) + sol drenant (τ=17h)
    → uscare rapidă, setpoint mare → regulatorul trebuie să livreze multă
    apă în doze frecvente.

  Worst-case (b) "leneş":  Cactus (setpoint 35%) + turbă (τ=54h)
    → uscare lentă, setpoint mic → regulatorul are timp mult, doze mici.

  Comparaţie cu cazul "tipic": Ficus + universal (mediu × mediu).

Întrebare: rămâne acordarea IMC stabilă la capete sau apar oscilaţii?
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


def main() -> None:
    scenarii = [
        scenariu("ridicat", "scazut",
                 "EXTREM însetat: Mentă (need ridicat) × Sol drenant"),
        scenariu("mediu",   "mediu",
                 "TIPIC: Ficus (need mediu) × Sol universal"),
        scenariu("scazut",  "ridicat",
                 "EXTREM leneş: Cactus (need scăzut) × Turbă"),
    ]
    culori = ['#c14b3a', '#2563a8', '#3a9d5d']
    etichete_scurte = ['Extrem însetat', 'Tipic', 'Extrem leneş']

    fig, axes = plt.subplots(3, 1, figsize=(13, 10), sharex=True)

    rezultate = []
    for ax, s, c, et in zip(axes, scenarii, culori, etichete_scurte):
        rez = simulate(s, durata_zile=7.0, h0=30.0)
        p = params_din_scenariu(s)
        rezultate.append((s, p, rez, et))

        zile = t_in_zile(rez.t_min)

        ax.axhspan(p.setpoint - p.histerezis, p.setpoint,
                   color=c, alpha=0.10)
        ax.axhline(p.setpoint, color=c, linestyle='--', linewidth=1.0,
                   alpha=0.7)
        ax.plot(zile, rez.h, color=c, linewidth=1.6)

        # Bare verticale + adnotări la udări
        for t, ml in zip(rez.udari_t, rez.udari_ml):
            zi = t / (24 * 60)
            ax.axvline(zi, color=c, linewidth=0.6, alpha=0.4)

        sumar = (f"τ={p.tau_h:.0f}h  λ={p.lambda_h:.0f}h  Kp={p.Kp:.2f}\n"
                 f"setpoint={p.setpoint:.0f}%\n"
                 f"{rez.numar_udari} udări · {rez.ml_total:.0f} ml\n"
                 f"medie={rez.h_mediu:.1f}%  range=[{rez.h_min:.0f},{rez.h_max:.0f}]%")
        ax.text(0.99, 0.05, sumar, transform=ax.transAxes,
                fontsize=8, ha='right', va='bottom', family='monospace',
                bbox=dict(boxstyle='round,pad=0.4',
                          facecolor='white', edgecolor=c, linewidth=1))

        ax.set_ylabel(f'{et}\n[%]', fontsize=10, fontweight='bold')
        ax.grid(True, alpha=0.3)
        ax.set_ylim(0, 85)

    axes[-1].set_xlabel('Timp [zile]')
    axes[0].set_title(
        "Simularea 4 — Cazuri extreme: stres-test pentru acordarea IMC\n"
        "7 zile, sol uscat la pornire (30%)",
        fontsize=11, fontweight='bold')

    plt.tight_layout()
    output_file = OUTPUT / "sim_4_cazuri_extreme.png"
    plt.savefig(output_file, dpi=130, bbox_inches='tight')
    print(f"\nGrafic salvat: {output_file}")

    print("\n=== Comparare cazuri extreme ===")
    print(f"  {'Scenariu':<25} {'Setpoint':>10} {'τ':>6} {'Udări':>8} "
          f"{'ml/zi':>10} {'h mediu':>10}")
    for s, p, rez, et in rezultate:
        print(f"  {et:<25} {p.setpoint:>9.0f}% {p.tau_h:>5.0f}h "
              f"{rez.numar_udari:>8} {rez.ml_total/7:>9.0f}ml "
              f"{rez.h_mediu:>9.1f}%")


if __name__ == "__main__":
    main()

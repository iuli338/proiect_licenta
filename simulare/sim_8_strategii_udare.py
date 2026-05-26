"""
Simularea 8 — Compararea strategiilor de declanşare a udării
============================================================
Aceeaşi acordare PI (Ficus + sol universal), 4 strategii diferite:

  • interval_fix:  baseline — udă la fiecare 24h dacă h < setpoint-hist (5%)
  • prag_doza:     udă DOAR când doza calculată >= 15 ml (PI acumulează datoria)
  • hist_larg:     histerezis lărgit la 15% — cadenţă naturală dictată de τ
  • predictie:     calculează cu modelul când va atinge pragul, udă cu 30 min în avans

Întrebare: dacă lăsăm regulatorul să aleagă cadenţa în loc să o impunem
noi (24h), ce câştigăm?

Safety nets aplicate la TOATE strategiile:
  • Anti-twitch: min 6h între udări (nu udăm de 2× într-o oră)
  • Max interval: 7 zile fără udare → udare obligatorie (planta nu moare)
"""

from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding='utf-8')

import matplotlib.pyplot as plt
from simulare.proces import simulate, params_din_scenariu, t_in_zile
from simulare.scenarii import BAZA


OUTPUT = Path(__file__).resolve().parent / "output"
OUTPUT.mkdir(exist_ok=True)


def main() -> None:
    strategii = [
        ("interval_fix", "Interval fix (24h)",              "#c14b3a"),
        ("prag_doza",    "Prag pe doză (≥ 15 ml)",          "#2563a8"),
        ("hist_larg",    "Histerezis lărgit (15%)",         "#3a9d5d"),
        ("predictie",    "Predicţie cu modelul (30 min)",   "#7e5cb5"),
    ]

    fig, axes = plt.subplots(4, 1, figsize=(13, 11), sharex=True)
    p = params_din_scenariu(BAZA)

    rezultate = []
    for ax, (key, label, c) in zip(axes, strategii):
        rez = simulate(BAZA, durata_zile=7.0, h0=30.0, strategie=key)
        rezultate.append((key, label, rez))

        zile = t_in_zile(rez.t_min)

        # Banda de toleranţă "tradiţională" (setpoint - 5% .. setpoint).
        # Pentru hist_larg afişăm şi banda mai mare ca să vedem decuplarea.
        ax.axhspan(p.setpoint - p.histerezis, p.setpoint,
                   color='#b8f0c9', alpha=0.10)
        if key == "hist_larg":
            ax.axhspan(p.setpoint - 15, p.setpoint - p.histerezis,
                       color='#b8f0c9', alpha=0.05,
                       label='Banda lărgită (15%)')
        ax.axhline(p.setpoint, color='gray', linestyle='--',
                   linewidth=0.9, alpha=0.6,
                   label=f'Setpoint = {p.setpoint:.0f}%')

        ax.plot(zile, rez.h, color=c, linewidth=1.5)

        for t, ml in zip(rez.udari_t, rez.udari_ml):
            zi = t / (24 * 60)
            ax.axvline(zi, color=c, linewidth=0.5, alpha=0.35)

        sumar = (f"{rez.numar_udari} udări · {rez.ml_total:.0f} ml total\n"
                 f"h ∈ [{rez.h_min:.0f}%, {rez.h_max:.0f}%]  medie={rez.h_mediu:.1f}%")
        ax.text(0.99, 0.05, sumar, transform=ax.transAxes,
                fontsize=9, ha='right', va='bottom', family='monospace',
                bbox=dict(boxstyle='round,pad=0.4',
                          facecolor='white', edgecolor=c, linewidth=1.2))

        ax.set_ylabel(label, fontsize=10, fontweight='bold')
        ax.grid(True, alpha=0.3)
        ax.set_ylim(15, 75)

    axes[-1].set_xlabel('Timp [zile]')
    axes[0].set_title(
        "Simularea 8 — Strategii alternative de declanşare a udării\n"
        f"{BAZA.label}, 7 zile, sol uscat la pornire (30%)",
        fontsize=11, fontweight='bold')

    plt.tight_layout()
    output_file = OUTPUT / "sim_8_strategii_udare.png"
    plt.savefig(output_file, dpi=130, bbox_inches='tight')
    print(f"\nGrafic salvat: {output_file}")

    print(f"\n=== Comparare strategii pe {BAZA.label} ===")
    print(f"  {'Strategie':<28} {'Udări':>8} {'ml total':>10} "
          f"{'h min':>8} {'h max':>8} {'h mediu':>10}")
    for key, label, rez in rezultate:
        print(f"  {label:<28} {rez.numar_udari:>8} {rez.ml_total:>9.0f}ml "
              f"{rez.h_min:>7.1f}% {rez.h_max:>7.1f}% {rez.h_mediu:>9.1f}%")


if __name__ == "__main__":
    main()

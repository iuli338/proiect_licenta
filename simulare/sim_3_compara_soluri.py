"""
Simularea 3 — Comparare 3 soluri × aceeaşi plantă
=================================================
Aceeaşi plantă (Ficus, necesar mediu) + 3 soluri cu retenţii diferite:
  • Drenant   (retenţie scăzută → τ ≈ 17 h, uscare rapidă)
  • Universal (retenţie medie   → τ ≈ 32 h, referinţa)
  • Turbă     (retenţie ridicată → τ ≈ 54 h, păstrează apa)

Întrebare: cum se schimbă frecvenţa udărilor + volumul livrat?
Vizual: 3 subploturi verticale + tabel cu metrici.
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
        scenariu("mediu", "scazut",  "Sol drenant (τ mic)"),
        scenariu("mediu", "mediu",   "Sol universal (τ referinţă)"),
        scenariu("mediu", "ridicat", "Turbă (τ mare)"),
    ]
    culori = ['#c14b3a', '#2563a8', '#5b3a7a']

    fig, axes = plt.subplots(3, 1, figsize=(12, 9), sharex=True)

    rezultate = []
    for ax, s, c in zip(axes, scenarii, culori):
        rez = simulate(s, durata_zile=7.0, h0=30.0)
        p = params_din_scenariu(s)
        rezultate.append((s, p, rez))

        zile = t_in_zile(rez.t_min)

        ax.axhspan(p.setpoint - p.histerezis, p.setpoint,
                   color=c, alpha=0.10)
        ax.axhline(p.setpoint, color=c, linestyle='--', linewidth=1.0,
                   alpha=0.7,
                   label=f'Setpoint = {p.setpoint:.0f}%')
        ax.plot(zile, rez.h, color=c, linewidth=1.6, label='h(t)')

        for t, ml in zip(rez.udari_t, rez.udari_ml):
            ax.axvline(t / (24 * 60), color=c, linewidth=0.6, alpha=0.4)

        sumar = (f"τ = {p.tau_h:.0f} h\n"
                 f"{rez.numar_udari} udări · {rez.ml_total:.0f} ml\n"
                 f"medie={rez.h_mediu:.1f}%")
        ax.text(0.99, 0.05, sumar, transform=ax.transAxes,
                fontsize=9, ha='right', va='bottom',
                bbox=dict(boxstyle='round,pad=0.4',
                          facecolor='white', edgecolor=c, linewidth=1))

        ax.set_ylabel(f'{s.soil.name.split()[0]}\n[%]', fontsize=10)
        ax.legend(loc='lower left', fontsize=8, framealpha=0.95)
        ax.grid(True, alpha=0.3)
        ax.set_ylim(15, 70)

    axes[-1].set_xlabel('Timp [zile]')
    axes[0].set_title(
        "Simularea 3 — Aceeaşi plantă, soluri diferite\n"
        "Ficus (necesar mediu), 7 zile, sol uscat la pornire (30%)",
        fontsize=11, fontweight='bold')

    plt.tight_layout()
    output_file = OUTPUT / "sim_3_compara_soluri.png"
    plt.savefig(output_file, dpi=130, bbox_inches='tight')
    print(f"\nGrafic salvat: {output_file}")

    print("\n=== Comparare ===")
    print(f"  {'Sol':<28} {'τ':>6} {'Udări':>8} {'ml total':>10} "
          f"{'h mediu':>10}")
    for s, p, rez in rezultate:
        print(f"  {s.soil.name:<28} {p.tau_h:>5.0f}h {rez.numar_udari:>8} "
              f"{rez.ml_total:>9.0f}ml {rez.h_mediu:>9.1f}%")


if __name__ == "__main__":
    main()

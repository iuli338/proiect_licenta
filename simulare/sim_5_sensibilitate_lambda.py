"""
Simularea 5 — Sensibilitatea la λ (parametrul de acordare IMC)
==============================================================
Acelaşi proces (Ficus + sol universal), dar 3 valori pentru λ:

  • λ = 10 h  (agresiv) → Kp şi Ki mari, răspuns rapid, posibil overshoot
  • λ = 30 h  (default)  → echilibru
  • λ = 80 h  (lent)     → Kp şi Ki mici, răspuns blând, menţinere mai netedă

Întrebare: ce trade-off facem când alegem λ? Mic = rapid dar oscilant;
mare = lent dar predictibil. λ implicit (30h) ar trebui să fie un compromis bun.

Vizual: 3 curbe suprapuse pe acelaşi grafic + axă secundară cu doza per udare.
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
    lambdas = [10.0, 30.0, 80.0]
    etichete = ['λ=10h (agresiv)', 'λ=30h (default)', 'λ=80h (lent)']
    culori = ['#c14b3a', '#2563a8', '#5b3a7a']

    fig, axes = plt.subplots(2, 1, figsize=(12, 8), sharex=True,
                             height_ratios=[3, 1])

    rezultate = []
    for lam, et, c in zip(lambdas, etichete, culori):
        s = scenariu("mediu", "mediu", et)
        s.lambda_h_override = lam
        rez = simulate(s, durata_zile=7.0, h0=30.0)
        p = params_din_scenariu(s)
        rezultate.append((s, p, rez, et))

        zile = t_in_zile(rez.t_min)

        # Curba de umiditate
        axes[0].plot(zile, rez.h, color=c, linewidth=1.5,
                     label=f'{et}  (Kp={p.Kp:.2f}, Ki={p.Ki:.4f})')

        # Punctul fiecărei udări — pe axa de doze
        for t, ml in zip(rez.udari_t, rez.udari_ml):
            axes[1].plot(t / (24 * 60), ml, 'o', color=c, markersize=7)

    # Banda de toleranţă (aceeaşi pentru toate, depinde doar de plantă)
    p_ref = rezultate[0][1]
    axes[0].axhspan(p_ref.setpoint - p_ref.histerezis, p_ref.setpoint,
                    color='#b8f0c9', alpha=0.15)
    axes[0].axhline(p_ref.setpoint, color='gray', linestyle='--',
                    linewidth=1.0, alpha=0.7,
                    label=f'Setpoint = {p_ref.setpoint:.0f}%')

    axes[0].set_ylabel('Umiditate sol [%]')
    axes[0].set_title(
        "Simularea 5 — Sensibilitatea la λ (acordare IMC)\n"
        "Ficus + sol universal, 7 zile, sol uscat la pornire (30%)",
        fontsize=11, fontweight='bold')
    axes[0].legend(loc='lower right', fontsize=9, framealpha=0.95)
    axes[0].grid(True, alpha=0.3)
    axes[0].set_ylim(15, 80)

    axes[1].set_ylabel('Doză per udare [ml]')
    axes[1].set_xlabel('Timp [zile]')
    axes[1].grid(True, alpha=0.3)

    # Legendă pentru axa de doze
    for c, et in zip(culori, etichete):
        axes[1].plot([], [], 'o', color=c, label=et)
    axes[1].legend(loc='upper right', fontsize=8, framealpha=0.95)

    plt.tight_layout()
    output_file = OUTPUT / "sim_5_sensibilitate_lambda.png"
    plt.savefig(output_file, dpi=130, bbox_inches='tight')
    print(f"\nGrafic salvat: {output_file}")

    print("\n=== Sensibilitatea la λ ===")
    print(f"  {'λ':>6} {'Kp':>8} {'Ki':>8} {'Udări':>8} {'ml total':>10} "
          f"{'h max':>8} {'h mediu':>10}")
    for s, p, rez, et in rezultate:
        print(f"  {p.lambda_h:>5.0f}h {p.Kp:>7.3f} {p.Ki:>7.4f} "
              f"{rez.numar_udari:>8} {rez.ml_total:>9.0f}ml "
              f"{rez.h_max:>7.1f}% {rez.h_mediu:>9.1f}%")


if __name__ == "__main__":
    main()

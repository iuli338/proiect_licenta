"""
Simularea 6 — PI vs bang-bang (termostat simplu)
================================================
Comparaţie directă pe acelaşi scenariu (Ficus + sol universal):

  • Bang-bang: porneşte udare cu doza fixă (dose_estimat_ml) când h <
    setpoint-histerezis. Fără memorie, fără adaptare.

  • PI: aceleaşi condiţii, dar doza calculată dinamic din Kp·e + I.

Întrebare: ce câştigăm folosind PI faţă de un termostat simplu?
Vizual: 2 subploturi suprapuse cu aceeaşi axă timp.
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
    rez_pi = simulate(BAZA, durata_zile=7.0, h0=30.0, regulator="pi")
    rez_bb = simulate(BAZA, durata_zile=7.0, h0=30.0, regulator="bangbang")
    p = params_din_scenariu(BAZA)

    fig, axes = plt.subplots(2, 1, figsize=(12, 9), sharex=True)

    # ---------- Subplot 1: PI ----------
    zile = t_in_zile(rez_pi.t_min)
    axes[0].axhspan(p.setpoint - p.histerezis, p.setpoint,
                    color='#b8f0c9', alpha=0.15)
    axes[0].axhline(p.setpoint, color='#3a9d5d', linestyle='--',
                    linewidth=1.0, alpha=0.7,
                    label=f'Setpoint = {p.setpoint:.0f}%')
    axes[0].plot(zile, rez_pi.h, color='#3a9d5d', linewidth=1.7,
                 label=f'Regulator PI (doze adaptive)')
    for t, ml in zip(rez_pi.udari_t, rez_pi.udari_ml):
        zi = t / (24 * 60)
        axes[0].axvline(zi, color='#3a9d5d', linewidth=0.6, alpha=0.4)
        axes[0].annotate(f'{ml:.0f}ml', xy=(zi, 60), xytext=(zi + 0.04, 60),
                         fontsize=7, color='#3a9d5d')

    sumar_pi = (f"PI — {rez_pi.numar_udari} udări · "
                f"{rez_pi.ml_total:.0f} ml total\n"
                f"medie={rez_pi.h_mediu:.1f}%  "
                f"range=[{rez_pi.h_min:.0f}, {rez_pi.h_max:.0f}]%")
    axes[0].text(0.99, 0.05, sumar_pi, transform=axes[0].transAxes,
                 fontsize=9, ha='right', va='bottom', family='monospace',
                 bbox=dict(boxstyle='round,pad=0.4', facecolor='white',
                           edgecolor='#3a9d5d', linewidth=1))

    axes[0].set_ylabel('Umiditate [%]')
    axes[0].legend(loc='lower left', fontsize=9, framealpha=0.95)
    axes[0].grid(True, alpha=0.3)
    axes[0].set_ylim(15, 75)
    axes[0].set_title(
        "Simularea 6 — PI vs bang-bang (termostat simplu)\n"
        f"Ficus + sol universal, 7 zile, doza bang-bang fixă = "
        f"{p.dose_estimat_ml:.0f} ml",
        fontsize=11, fontweight='bold')

    # ---------- Subplot 2: bang-bang ----------
    zile_bb = t_in_zile(rez_bb.t_min)
    axes[1].axhspan(p.setpoint - p.histerezis, p.setpoint,
                    color='#b8f0c9', alpha=0.15)
    axes[1].axhline(p.setpoint, color='#c14b3a', linestyle='--',
                    linewidth=1.0, alpha=0.7,
                    label=f'Setpoint = {p.setpoint:.0f}%')
    axes[1].plot(zile_bb, rez_bb.h, color='#c14b3a', linewidth=1.7,
                 label=f'Bang-bang (doza fixă {p.dose_estimat_ml:.0f} ml)')
    for t, ml in zip(rez_bb.udari_t, rez_bb.udari_ml):
        zi = t / (24 * 60)
        axes[1].axvline(zi, color='#c14b3a', linewidth=0.6, alpha=0.4)

    sumar_bb = (f"Bang-bang — {rez_bb.numar_udari} udări · "
                f"{rez_bb.ml_total:.0f} ml total\n"
                f"medie={rez_bb.h_mediu:.1f}%  "
                f"range=[{rez_bb.h_min:.0f}, {rez_bb.h_max:.0f}]%")
    axes[1].text(0.99, 0.05, sumar_bb, transform=axes[1].transAxes,
                 fontsize=9, ha='right', va='bottom', family='monospace',
                 bbox=dict(boxstyle='round,pad=0.4', facecolor='white',
                           edgecolor='#c14b3a', linewidth=1))

    axes[1].set_ylabel('Umiditate [%]')
    axes[1].set_xlabel('Timp [zile]')
    axes[1].legend(loc='lower left', fontsize=9, framealpha=0.95)
    axes[1].grid(True, alpha=0.3)
    axes[1].set_ylim(15, 75)

    plt.tight_layout()
    output_file = OUTPUT / "sim_6_pi_vs_bangbang.png"
    plt.savefig(output_file, dpi=130, bbox_inches='tight')
    print(f"\nGrafic salvat: {output_file}")

    print("\n=== PI vs Bang-bang ===")
    print(f"  {'Regulator':<15} {'Udări':>8} {'ml total':>10} "
          f"{'h mediu':>10} {'h min':>10} {'h max':>10}")
    for nume, rez in [("PI", rez_pi), ("Bang-bang", rez_bb)]:
        print(f"  {nume:<15} {rez.numar_udari:>8} {rez.ml_total:>9.0f}ml "
              f"{rez.h_mediu:>9.1f}% {rez.h_min:>9.1f}% {rez.h_max:>9.1f}%")


if __name__ == "__main__":
    main()

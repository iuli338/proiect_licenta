"""
Simularea 1 — Răspuns de bază al regulatorului PI
=================================================
Scenariu: plantă cu necesar mediu de apă (Ficus) în sol universal (retenţie
medie), pornind de la 30% umiditate (sol uscat). 7 zile, citiri la 10 min.

Întrebări la care răspunde:
  • Cum reacţionează regulatorul la sol uscat la pornire?
  • Câte udări sunt necesare şi cum se stabilizează doza?
  • Vizual: când scade umiditatea sub prag, când porneşte udarea,
    cât revine umiditatea după fiecare udare?

Graficul afişează:
  • Curba umidităţii reale h(t)
  • Setpoint-ul + banda de histerezis (zonă vizuală)
  • Bare verticale + adnotări la momentele udărilor (ml-i livraţi)
"""

from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding='utf-8')

import matplotlib.pyplot as plt
import matplotlib.dates as mdates

from simulare.proces import simulate, params_din_scenariu, afiseaza_metrici, t_in_zile
from simulare.scenarii import BAZA


OUTPUT = Path(__file__).resolve().parent / "output"
OUTPUT.mkdir(exist_ok=True)


def main() -> None:
    rez = simulate(BAZA, durata_zile=7.0, h0=30.0)
    p = params_din_scenariu(BAZA)
    afiseaza_metrici(rez, BAZA, p)

    # Două variante: fără zgomot (curată) + cu zgomot ±1% (realistă).
    rez_zgomot = simulate(BAZA, durata_zile=7.0, h0=30.0,
                          seed_zgomot=42, sigma_zgomot=1.0)

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 8),
                                    sharex=True, height_ratios=[3, 1])

    # ---------- Plot 1: umiditatea ----------
    zile = t_in_zile(rez.t_min)

    # Banda de histerezis (vizual)
    ax1.axhspan(p.setpoint - p.histerezis, p.setpoint,
                color='#b8f0c9', alpha=0.15,
                label=f'Bandă de toleranţă ({p.setpoint - p.histerezis:.0f}–{p.setpoint:.0f}%)')
    ax1.axhline(p.setpoint, color='#3a9d5d', linestyle='--', linewidth=1.2,
                label=f'Setpoint = {p.setpoint:.0f}%')
    ax1.axhline(p.setpoint - p.histerezis, color='#d97a3a', linestyle=':',
                linewidth=1.0, alpha=0.7,
                label=f'Prag declanşare = {p.setpoint - p.histerezis:.0f}%')

    # Curba ideală (fără zgomot)
    ax1.plot(zile, rez.h, color='#2563a8', linewidth=1.8,
             label='Umiditate reală h(t)')

    # Curba cu zgomot ±1%
    zile_z = t_in_zile(rez_zgomot.t_min)
    ax1.plot(zile_z, rez_zgomot.h_masurat, color='#999', linewidth=0.6,
             alpha=0.5, label='Citire senzor (±1% zgomot)')

    # Bare verticale la fiecare udare + adnotare cu ml
    for t, ml in zip(rez.udari_t, rez.udari_ml):
        zi = t / (24 * 60)
        ax1.axvline(zi, color='#2563a8', linewidth=0.8, alpha=0.3)
        ax1.annotate(f'{ml:.0f} ml',
                     xy=(zi, p.setpoint + 8),
                     xytext=(zi + 0.05, p.setpoint + 10),
                     fontsize=8, color='#2563a8',
                     bbox=dict(boxstyle='round,pad=0.3',
                               facecolor='white', edgecolor='#2563a8',
                               linewidth=0.8))

    ax1.set_ylabel('Umiditate sol [%]')
    ax1.set_title(
        f"Simularea 1 — Răspuns de bază al regulatorului PI\n"
        f"{BAZA.label}, 7 zile, condiţie iniţială: sol uscat (30 %)",
        fontsize=11, fontweight='bold')
    ax1.legend(loc='lower right', fontsize=9, framealpha=0.95)
    ax1.grid(True, alpha=0.3)
    ax1.set_ylim(0, max(70, p.setpoint + 20))

    # ---------- Plot 2: dozele cumulate ----------
    cumulat_ml = []
    cumulat_t = []
    total = 0
    for t, ml in zip(rez.udari_t, rez.udari_ml):
        total += ml
        cumulat_t.append(t / (24 * 60))
        cumulat_ml.append(total)

    if cumulat_t:
        ax2.step([0] + cumulat_t + [7], [0] + cumulat_ml + [cumulat_ml[-1]],
                 where='post', color='#3a9d5d', linewidth=2,
                 label=f'Apă cumulată: {rez.ml_total:.0f} ml')
    ax2.set_xlabel('Timp [zile]')
    ax2.set_ylabel('Apă cumulată [ml]')
    ax2.legend(loc='upper left', fontsize=9)
    ax2.grid(True, alpha=0.3)
    ax2.set_xlim(0, 7)

    # Sumar text în colţul de jos al graficului 1
    sumar = (f"Parametri:  K={p.K:.2f} %/ml  τ={p.tau_h:.0f} h  "
             f"λ={p.lambda_h:.0f} h  Kp={p.Kp:.3f}  Ki={p.Ki:.4f}\n"
             f"Rezultat:  {rez.numar_udari} udări · {rez.ml_total:.0f} ml total · "
             f"medie={rez.h_mediu:.1f}%  min={rez.h_min:.1f}%  max={rez.h_max:.1f}%")
    fig.text(0.5, 0.01, sumar, ha='center', fontsize=8,
             color='#555', style='italic')

    plt.tight_layout(rect=[0, 0.03, 1, 1])
    output_file = OUTPUT / "sim_1_raspuns_baza.png"
    plt.savefig(output_file, dpi=130, bbox_inches='tight')
    print(f"\nGrafic salvat: {output_file}")


if __name__ == "__main__":
    main()

"""
Dropwise — identificarea modelului de proces din date experimentale
===================================================================

Anexă de licenţă. NU face parte din aplicaţia Flask — rulează separat:

    python misc/identificare_model.py

Scop
----
Datele din `soil_data_complete.csv` (10 zile, eşantion la ~10 min, 2 udări
controlate de 25 ml şi 75 ml) descriu procesul fizic pe care îl reglăm:
umiditatea solului dintr-un ghiveci.

1. Semnalul de proces — de la raw la umiditate %
------------------------------------------------
Senzorul rezistiv dă `soil_moisture_raw` INVERS faţă de umiditate şi e
puternic neliniar la capete (saturează spre ADC = 4095). Identificarea pe
raw brut dă un câştig contradictoriu (vezi prima rulare: K = 64 vs 20).
De aceea îl convertim întâi în umiditate procentuală, pe o scală liniară:

    umiditate% = 100 * (RAW_USCAT - raw) / (RAW_USCAT - RAW_UMED)

  RAW_USCAT = 4095  → sol complet uscat   → 0%
  RAW_UMED          → minimul după udare  → 100%

raw mare → 0% (uscat), raw mic → 100% (umed).

2. Modelul de sol — proces de ordinul 1
---------------------------------------
Lăsat în pace, solul se usucă exponenţial spre o umiditate de echilibru:

    h(t) = h_inf + (h0 - h_inf) * exp(-t / tau)

  tau   — constanta de timp a uscării [ore]. Solul care reţine apă (turbă,
          argilos) are tau mare; cel drenant, tau mic. → din RETENŢIA solului.
  h_inf — umiditatea de echilibru (solul "uscat", ~0%).

O udare ridică umiditatea instantaneu. Câştigul procesului la udare:

    K = delta_h / volum_apa   [% umiditate / ml]

În umiditate %, K e aproape acelaşi la ambele udări — neliniaritatea
senzorului a fost eliminată prin conversie.

3. Regulatorul — PI acordat prin IMC
------------------------------------
Pentru un proces de ordinul 1 (K, tau), metoda IMC (Internal Model Control)
leagă direct parametrii PI de model, printr-un singur parametru de acordare
lambda (constanta de timp dorită în buclă închisă):

    Kp = tau / (K * lambda)
    Ki = Kp / tau            (echivalent: timp integral Ti = tau)

  lambda mic  → regulator agresiv (udă mult, repede)
  lambda mare → regulator blând   (udă puţin, prudent)

Solul   → parametrii MODELULUI   (K, tau).
Planta  → parametrii REGULATORULUI (setpoint din necesarul de apă + lambda).

Script-ul: citeşte CSV-ul, curăţă artefactele, converteşte în %, detectează
udările, identifică (K, tau), apoi tipăreşte tabelele parametrizate pe cele
3 niveluri de sol şi de plantă.
"""

from __future__ import annotations

import csv
import os
import sys

import numpy as np

# Consola Windows e tipic pe cp1250 şi nu poate afişa diacritice / simboluri.
# Forţăm UTF-8 pe stdout ca raportul să iasă lizibil.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


# Volumele celor 2 udări controlate din experiment, în ordine cronologică.
VOLUM_UDARE_ML = (25.0, 75.0)

# Capătul "uscat" al scalei: saturaţia ADC a senzorului rezistiv.
RAW_USCAT = 4095.0

# Salt minim de raw care marchează o udare reală (restul e zgomot de senzor).
PRAG_UDARE = 300

CSV_PATH = os.path.join(os.path.dirname(__file__), "soil_data_complete.csv")


# ---------------------------------------------------------------- citire date

def incarca_date(path: str):
    """Citeşte CSV-ul; returnează (timp_ore, raw) ca array-uri numpy.

    Curăţă artefactele cunoscute de senzor:
      - soil_temp_c == 85.00       → eroare de citire (valoare santinelă)
      - soil_moisture_raw >= 4095  → saturaţie ADC / senzor scos din ghiveci
    """
    ts, raw = [], []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if r["soil_temp_c"] == "85.00":
                continue
            val = int(r["soil_moisture_raw"])
            if val >= RAW_USCAT:
                continue
            ts.append(int(r["timestamp"]))
            raw.append(val)
    ts = np.array(ts, dtype=float)
    raw = np.array(raw, dtype=float)
    t_ore = (ts - ts[0]) / 3600.0     # timp relativ, în ore
    return t_ore, raw


def raw_la_umiditate(raw: np.ndarray, raw_umed: float) -> np.ndarray:
    """Converteşte raw în umiditate %, pe scală liniară [0% uscat .. 100% umed]."""
    return 100.0 * (RAW_USCAT - raw) / (RAW_USCAT - raw_umed)


# ---------------------------------------------------------------- udări

def detecteaza_udari(raw: np.ndarray) -> list[int]:
    """Indexii eşantioanelor unde raw scade brusc (= udare)."""
    return [i for i in range(1, len(raw))
            if raw[i] - raw[i - 1] < -PRAG_UDARE]


# ---------------------------------------------------------------- model ordin 1

def model_uscare(t, h_inf, h0, tau):
    """Răspuns de ordinul 1: umiditatea se relaxează spre h_inf cu constanta tau."""
    return h_inf + (h0 - h_inf) * np.exp(-t / tau)


def _fit_tau(t0: np.ndarray, h_seg: np.ndarray, h_inf: float):
    """Pentru un h_inf dat, identifică tau prin liniarizare logaritmică.

    Modelul de ordin 1 se rescrie (uscare → h scade spre h_inf):
        h(t) - h_inf = (h0 - h_inf) * exp(-t / tau)
        ln(h - h_inf) = ln(h0 - h_inf) - t / tau
    adică o dreaptă în (t, ln(h - h_inf)) cu panta -1/tau.
    Returnează (h0, tau, rmse) sau None dacă h_inf e neplauzibil.
    """
    diff = h_seg - h_inf
    if np.any(diff <= 0):
        return None                       # h_inf trebuie sub tot semnalul
    panta, intercept = np.polyfit(t0, np.log(diff), 1)
    if panta >= 0:
        return None                       # nu e uscare → respins
    tau = -1.0 / panta
    h0 = h_inf + np.exp(intercept)
    pred = model_uscare(t0, h_inf, h0, tau)
    rmse = float(np.sqrt(np.mean((pred - h_seg) ** 2)))
    return h0, tau, rmse


def identifica_segment(t_seg: np.ndarray, h_seg: np.ndarray):
    """Identifică modelul de ordin 1 pe un segment de uscare, fără scipy.

    tau se obţine prin liniarizare logaritmică (regresie liniară); h_inf
    nu apare liniar, deci îl căutăm 1D minimizând RMSE-ul fitting-ului.
    Returnează (h_inf, h0, tau, rmse).
    """
    t0 = t_seg - t_seg[0]
    # h_inf (umiditatea de echilibru) e sub minimul observat; căutăm de la
    # 20% sub minim până la minimul însuşi.
    h_min = h_seg.min()
    candidati = np.linspace(h_min - 20.0, h_min - 0.5, 400)

    cel_mai_bun = None
    for h_inf in candidati:
        rez = _fit_tau(t0, h_seg, h_inf)
        if rez is None:
            continue
        h0, tau, rmse = rez
        if cel_mai_bun is None or rmse < cel_mai_bun[3]:
            cel_mai_bun = (h_inf, h0, tau, rmse)

    if cel_mai_bun is None:
        raise RuntimeError("identificarea a eşuat pe acest segment")
    return cel_mai_bun


# ---------------------------------------------------------------- acordare IMC

def acordare_imc(K: float, tau: float, lam: float):
    """Parametrii PI dintr-un model de ordin 1 (K, tau), prin metoda IMC.

      Kp = tau / (K * lambda)
      Ki = Kp / tau

    lambda = constanta de timp dorită în buclă închisă [ore].
    Returnează (Kp, Ki).
    """
    Kp = tau / (K * lam)
    Ki = Kp / tau
    return Kp, Ki


# ---------------------------------------------------------------- raport

def main():
    print("=" * 66)
    print(" Dropwise — identificarea modelului de sol şi acordarea PI")
    print("=" * 66)

    t, raw = incarca_date(CSV_PATH)
    print(f"Eşantioane valide (după curăţare): {len(raw)}")
    print(f"Interval mediu de eşantionare: {np.median(np.diff(t)) * 60:.1f} min")

    udari = detecteaza_udari(raw)
    print(f"Udări detectate: {len(udari)}")

    # Capătul "umed" al scalei = cel mai mic raw observat (cel mai umed sol).
    raw_umed = raw.min()
    h = raw_la_umiditate(raw, raw_umed)
    print(f"Scală umiditate: RAW_USCAT={RAW_USCAT:.0f} (0%)  "
          f"RAW_UMED={raw_umed:.0f} (100%)")

    # ---- Câştigul K: salt de umiditate / volum apă ----
    # Atenţie: cele 2 udări s-au făcut pe stări diferite ale solului —
    #   #1 pe sol lăsat să se usuce complet (absoarbe lacom → K mare),
    #   #2 pe sol care avea deja apă (o parte se redistribuie → K mic).
    # K NU e constant: depinde de umiditatea curentă (proces neliniar).
    # Regulatorul lucrează în jurul setpoint-ului (35-65%), deci în zona
    # de mijloc — nici uscat complet, nici saturat. Fixăm un K nominal
    # efectiv pentru această zonă de operare.
    K_OPERARE = 1.5     # %/ml — câştig nominal în zona de reglare
    print("\n--- Câştig la udare (K), în umiditate % ---")
    for nr, idx in enumerate(udari):
        delta_h = h[idx] - h[idx - 1]        # creştere de umiditate
        vol = VOLUM_UDARE_ML[nr] if nr < len(VOLUM_UDARE_ML) else None
        if vol:
            stare = "sol uscat complet" if nr == 0 else "sol cu apă reziduală"
            K = delta_h / vol
            print(f"  Udare #{nr + 1}: delta_h={delta_h:5.1f}%  "
                  f"volum={vol:.0f} ml  ->  K = {K:.3f} %/ml  ({stare})")
    K_nominal = K_OPERARE
    print(f"  K nominal ales (zona de operare ~setpoint): "
          f"{K_nominal:.3f} %/ml")

    # ---- tau: fitting pe segmentele de uscare ----
    # Referinţa de tau e segmentul #1: cel mai lung (96h), cu asimptotă
    # clară şi cel mai bun fitting. Segmentul #2 e mai scurt şi mai
    # zgomotos — îl identificăm doar pentru verificare, nu îl mediem.
    print("\n--- Constanta de timp a uscării (tau) ---")
    granite = udari + [len(raw)]
    tau_segmente = []
    for nr, idx in enumerate(udari):
        sfarsit = granite[nr + 1]
        # Sărim primele 2 eşantioane: redistribuţia rapidă a apei imediat
        # după udare nu respectă încă modelul de uscare de ordin 1.
        a = idx + 2
        t_seg, h_seg = t[a:sfarsit], h[a:sfarsit]
        if len(h_seg) < 10:
            tau_segmente.append(None)
            continue
        h_inf, h0, tau, rmse = identifica_segment(t_seg, h_seg)
        tau_segmente.append(tau)
        rol = "referinţă" if nr == 0 else "verificare"
        print(f"  Segment #{nr + 1}: n={len(h_seg):3d}  tau={tau:6.1f} h  "
              f"h_inf={h_inf:6.1f}%  RMSE={rmse:.2f}%  ({rol})")
    tau_nominal = tau_segmente[0]
    print(f"  tau nominal ales (segment #1): {tau_nominal:.1f} h")

    # ---- Model de sol parametrizat ----
    # Solul "universal / mediu" = referinţa identificată mai sus.
    # Retenţia hidrică scalează tau: drenant se usucă repede (tau mic),
    # turbă/argilos reţin apa (tau mare). K depinde de senzor, nu de sol.
    print("\n--- MODEL DE SOL (retention → K, tau) ---")
    factori_tau = {"scazut": 0.55, "mediu": 1.00, "ridicat": 1.70}
    print(f"  {'retenţie':<10} {'K [%/ml]':>10} {'tau [h]':>10}")
    model_sol = {}
    for nivel, f in factori_tau.items():
        tau_n = tau_nominal * f
        model_sol[nivel] = (K_nominal, tau_n)
        print(f"  {nivel:<10} {K_nominal:>10.3f} {tau_n:>10.1f}")

    # ---- Regulator parametrizat ----
    # Planta dă: setpoint-ul (din necesarul de apă) şi lambda (agresivitatea).
    # Necesar ridicat → setpoint mai sus + lambda mic (reacţie promptă).
    # Necesar scăzut  → setpoint jos + lambda mare (udare prudentă, rară).
    setpoint = {"scazut": 35, "mediu": 50, "ridicat": 65}      # % umiditate
    lambda_h = {"scazut": 48.0, "mediu": 30.0, "ridicat": 18.0}  # ore
    print("\n--- REGULATOR PI (water_need → setpoint, lambda, Kp, Ki) ---")
    print("    [acordare IMC pe modelul de sol 'mediu']")
    K_ref, tau_ref = model_sol["mediu"]
    print(f"  {'necesar':<10} {'setpoint':>9} {'lambda[h]':>10} "
          f"{'Kp':>9} {'Ki[1/h]':>10}")
    for nivel in ("scazut", "mediu", "ridicat"):
        Kp, Ki = acordare_imc(K_ref, tau_ref, lambda_h[nivel])
        print(f"  {nivel:<10} {setpoint[nivel]:>8}% {lambda_h[nivel]:>10.0f} "
              f"{Kp:>9.3f} {Ki:>10.4f}")

    print("\nInterpretare:")
    print("  - Modelul (K, tau) vine din SOL: identificat pe date, scalat")
    print("    cu retenţia. Kp/Ki se recalculează cu (K, tau) ale solului ales.")
    print("  - Regulatorul (setpoint, lambda) vine din PLANTĂ: cât de umed")
    print("    ţinem solul şi cât de agresiv dozăm apa.")
    print("  - Comanda PI = volumul unei udări (ml); udare cel mult o dată")
    print("    pe zi, pe prag, cu anti-windup pe integrator.")
    print("=" * 66)


if __name__ == "__main__":
    main()

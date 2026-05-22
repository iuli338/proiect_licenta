# Dropwise — model matematic și regulator

Document de sinteză. Rezumă identificarea procesului din datele experimentale
și acordarea regulatorului. Detaliile numerice se obțin rulând
`identificare_model.py` pe `soil_data_complete.csv`.

## 1. Datele experimentale

Un ghiveci a fost monitorizat **10 zile** (16–26 martie 2026), cu un eșantion
la fiecare ~10 minute — 1400 de măsurători valide. În acest interval s-au
făcut **două udări controlate**: una de **25 ml** și una de **75 ml**.

Mărimea de interes e `soil_moisture_raw`, citirea unui senzor capacitiv de
umiditate. Senzorul răspunde **invers** (raw mare = sol uscat, raw mic = sol
umed) și e **neliniar la capete**, saturând spre valoarea ADC 4095.

Pentru a obține un semnal cu sens fizic și liniar, raw-ul a fost convertit în
**umiditate procentuală**:

```
umiditate% = 100 · (4095 − raw) / (4095 − raw_umed)
```

unde `4095` = sol complet uscat (0%) și `raw_umed` = minimul observat după o
udare (100%). Înainte de conversie s-au eliminat artefactele de senzor
(citiri de temperatură santinelă 85 °C, saturații ADC).

## 2. Modelul matematic al procesului

Lăsat în pace, solul se usucă lent prin evaporare și absorbție de către
plantă. Curba de uscare observată în date este o **relaxare exponențială
către o valoare de echilibru** — adică un **proces de ordinul 1**:

```
h(t) = h_inf + (h0 − h_inf) · e^(−t/τ)
```

- **τ** — constanta de timp a uscării. Cât de repede pierde solul apa.
- **h_inf** — umiditatea de echilibru (solul „uscat", aproape de 0%).

Modelul are doi parametri identificabili din date:

- **τ** se obține prin **liniarizare logaritmică**: ecuația de ordin 1
  devine o dreaptă în `ln(h − h_inf)` față de timp, a cărei pantă este
  `−1/τ`. Pe segmentul de uscare cel mai lung (96 h) fitting-ul dă
  **τ ≈ 32 h**, cu o eroare RMSE de sub 2% umiditate — o potrivire foarte
  bună, care confirmă structura de ordinul 1.

- **K** (câștigul) — cât crește umiditatea per mililitru de apă:
  `K = Δumiditate / volum`. Cele două udări dau valori diferite (3.5 vs
  1.1 %/ml) pentru că au fost făcute pe **stări diferite ale solului**: pe
  sol uscat complet apa e absorbită lacom (K mare), pe sol care avea deja
  apă o parte se redistribuie și drenează (K mic). Câștigul este deci
  **neliniar**, dependent de umiditatea curentă. Pentru model se folosește
  o valoare nominală **K ≈ 1.5 %/ml**, reprezentativă pentru **zona de
  operare** a regulatorului (sol nici uscat, nici saturat).

### Parametrizarea după sol

Tipul de sol nu schimbă structura modelului, ci valorile lui. **Retenția
hidrică** a solului scalează constanta de timp: un substrat drenant pierde
apa repede (τ mic), turba sau solul argilos o rețin (τ mare). Astfel,
**alegerea solului în interfață fixează parametrii modelului** — concret τ,
pornind de la valoarea identificată pentru solul de referință.

## 3. Regulatorul

### Structură

Pentru un proces de ordinul 1, structura potrivită — solidă, dar fără a fi
exagerată — este un **regulator PI** (proporțional-integral). Componenta
derivativă (D) a fost omisă deliberat: ar amplifica zgomotul senzorului de
umiditate fără un câștig real de performanță pe un proces atât de lent.

Regulatorul nu lucrează continuu. Udarea este un **eveniment rar** (cel mult
o dată pe zi): aparatul monitorizează umiditatea, iar când aceasta scade sub
prag, PI-ul calculează **volumul de apă** al unei singure udări (comanda este
în ml). Integratorul are **anti-windup**, necesar pentru că între udări trece
mult timp. Acest mecanism — monitorizare continuă, decizie dozată pe baza
modelului — este ceea ce face aparatul „inteligent", spre deosebire de un
simplu prag on/off.

### Acordare prin IMC

Parametrii PI se obțin din model prin metoda **IMC** (Internal Model
Control), care leagă direct acordarea de model printr-un singur parametru
de reglaj **λ** (constanta de timp dorită în bucla închisă):

```
Kp = τ / (K · λ)        Ki = Kp / τ
```

- **λ mic** → regulator agresiv (udă mult, reacționează prompt);
- **λ mare** → regulator blând (udă prudent, rar).

### Parametrizarea după plantă

**Alegerea plantei fixează parametrii regulatorului.** Necesarul de apă al
plantei (`scăzut / mediu / ridicat`) determină:

- **setpoint-ul** — umiditatea-țintă la care e menținut solul;
- **λ** — agresivitatea reglării.

O plantă cu necesar ridicat are setpoint mai sus și λ mai mic (reglare
promptă); una cu necesar scăzut, setpoint jos și λ mare (udare rară,
prudentă). Kp și Ki se recalculează apoi cu (K, τ) ale solului ales.

## 4. Concluzie

```
   SOL    ──►  parametrii MODELULUI      (K, τ)
   PLANTĂ ──►  parametrii REGULATORULUI  (setpoint, λ ─► Kp, Ki)
```

Fiecare ghiveci primește astfel un model și un regulator proprii, derivate
automat din cele două alegeri din wizard. Modelul nu este presupus, ci
**identificat din date reale**; regulatorul nu are parametri inventați, ci
**acordați analitic pe model**.

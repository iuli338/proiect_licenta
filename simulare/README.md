# Simulări regulator PI

Scripturi Python care simulează regulatorul PI Dropwise înainte de implementarea pe firmware. Folosesc aceleaşi formule şi constante ca [node_config.py](../node_config.py) — orice modificare în acordare (K, τ, λ, setpoint) se reflectă automat.

## Rulare

```bash
python simulare/sim_1_raspuns_baza.py
python simulare/sim_2_compara_plante.py
python simulare/sim_3_compara_soluri.py
python simulare/sim_4_cazuri_extreme.py
python simulare/sim_5_sensibilitate_lambda.py
python simulare/sim_6_pi_vs_bangbang.py
python simulare/sim_7_grid_complet.py
```

Fiecare script:
- Tipăreşte metricile-cheie în consolă (număr udări, ml total, h min/mediu/max)
- Salvează PNG în `simulare/output/`

Dependinţe: `matplotlib`, `numpy`. Sunt deja în `requirements.txt`.

## Ce face fiecare simulare

| Script | Scenariu | Întrebare |
|---|---|---|
| **sim_1** | Ficus + sol universal (baza) | Cum reacţionează PI-ul de la sol uscat la pornire? |
| **sim_2** | 3 plante × sol mediu | Cum se schimbă cadenţa în funcţie de plantă? |
| **sim_3** | Ficus × 3 soluri | Cum se schimbă frecvenţa udărilor în funcţie de sol? |
| **sim_4** | 3 scenarii: extrem însetat, tipic, extrem leneş | Acordarea IMC rămâne stabilă la capete? |
| **sim_5** | Ficus + sol mediu × 3 valori λ | Ce trade-off facem când alegem λ? |
| **sim_6** | PI vs bang-bang pe acelaşi scenariu | Ce câştigăm folosind PI faţă de termostat simplu? |
| **sim_7** | Grila 3×3 plante × soluri | Cum arată comportamentul pe tot spectrul wizard-ului? |
| **sim_8** | 4 strategii de declanşare pe scenariul de bază | Cum se schimbă comportamentul dacă lăsăm regulatorul să decidă cadenţa în loc de 24h fix? |
| **sim_9** | 4 strategii × 9 combinaţii (heatmap) | Există o strategie universal câştigătoare? |
| **sim_10** | 5 clase de udare × 3 soluri (matrice biologic motivată) | Respectă regulatorul cadenţa biologică pe toate combinaţiile? |

## Configuraţie comună

- Pas simulare: **1 minut** (integrare Euler pentru modelul de proces).
- Pas regulator: **10 minute** (cum va funcţiona pe firmware — nu reacţionăm la spike-uri).
- Durată: **7 zile** = ~1000 paşi regulator, ~10 080 paşi proces.
- Pornire: **30 % umiditate** (sol uscat, ca să vedem prima udare).
- Debit pompă: **3.21 ml/s** (calibrat empiric, vezi `PUMP_FLOW_ML_PER_SEC`).
- Doza clamp: **5..200 ml** per udare.
- Min interval: **24 h** între udări (din `node_config.py`).

## Concluzii vizibile în grafice

1. **PI funcţionează corect** pe scenariile tipice (sim_1): doza se stabilizează după 1-2 cicluri.
2. **Solul retentiv reduce consumul** (sim_3): turba foloseşte ~60 % din apa unui sol drenant.
3. **Acordarea IMC are limite** (sim_4, sim_7): la setpoint mare + sol uscat la pornire, PI-ul saturează doza (200 ml) şi atinge overshoot 90-100 %.
4. **λ default = 30 h e bun** (sim_5): λ=10h dă oscilaţii, λ=80h nu menţine setpoint-ul.
5. **PI ≈ bang-bang în regim permanent** (sim_6): diferenţa apare doar la pornire şi la perturbaţii.
6. **Intervalul fix de 24h e suboptim** (sim_8, sim_9):
   - Pe Cactus×Turbă forţează 14 udări/14zile când 9 ar fi suficiente.
   - Pe Mentă×Drenant produce overshoot la 100% — un singur puls mare la 24h e prea mult pentru un sol care se usucă rapid.
7. **Strategiile alternative îşi schimbă rolurile pe scenarii diferite**:
   - **Prag pe doză** = bun compromis general; cadenţă adaptivă pentru plantele care cer puţin (Cactus în Turbă: 9 vs 14 udări).
   - **Histerezis lărgit** = cadenţă naturală dictată de τ, dar pe sol drenant + plantă însetată face 56 udări (4× pe zi).
   - **Predicţie cu modelul** = curba cea mai netedă (range 8-21%), dar over-udează pe soluri retentive.
   - **Niciuna nu rezolvă overshoot-ul la Mentă×Universal/Turbă** (92-100%) — acolo limitarea e fizica modelului, nu strategia.

## Recomandare finală pentru firmware

Pe baza simulărilor, **strategia "clasa plantei" (sim_10) e cea mai potrivită**:

- Cadenţa **se setează biologic** prin alegerea plantei, nu se calculează matematic. Cactusul vrea 14 zile între udări — punct.
- Cele 5 clase (`foarte_rar`/`rar`/`echilibrat`/`frecvent`/`zilnic`) acoperă întreaga gamă fiziologică (1× la 2 săptămâni → 2× pe zi).
- Doza se livrează ca `max(target_dose_ml, PI_calculat)` — PI rămâne pentru ajustare fină, dar plantei i se garantează "udarea reală" (nu duş simbolic).
- λ-ul regulatorului se scalează cu T_min al clasei → regulator lent pentru plante rare, rapid pentru plante zilnice.
- Solul **NU afectează frecvenţa udărilor** — afectează doar curba uscării între ele (cum se vede în sim_10).

Configuraţia recomandată:

```
PI cu IMC (deja avem) — λ depinde de clasa plantei, nu de water_need
  + strategia "clasa_planta"
  + T_min, target_dose, λ vin din WATERING_CLASSES (5 clase)
  + safety_min = 6h (anti-twitch, comun)
  + safety_max = 1.2× T_min (override doar la întârziere > 20%)
```

Modificările necesare în `node_config.py`:
- Adăugare câmp `watering_class` pe Plant în `catalog.json` (cele 5 valori)
- Refactor `_LAMBDA_H = {scazut, mediu, ridicat}` → `λ` din clasa de udare
- Adăugare `target_dose_ml` şi `T_min_min` în output-ul `derive_regulator()`

Modificările pe firmware:
- Adăugare câmp `T_min_min` şi `target_dose_ml` în `RegParams` (bump EEPROM_LAYOUT_VERSION)
- Logica regulator în `hub_regulator.ino` (nouă) — vezi planul detaliat

Pentru lucrare, sim_10 e argumentul-cheie: **regulatorul nu mai luptă cu fiziologia plantei** — o respectă explicit.

## Structură

```
simulare/
├── proces.py            # simulator + regulator PI/bang-bang
├── scenarii.py          # preseturi plante/soluri (3 + 3 combinaţii)
├── __init__.py
├── sim_1..sim_7.py      # 7 scripturi independente
├── output/              # PNG-urile generate
└── README.md            # acest fişier
```

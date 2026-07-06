/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   Arduino concateneaza automat toate fisierele .ino din folder;
   variabilele globale si include-urile sunt in esp32_hub_v6.ino.
   ============================================================ */

// ============================================================
//  Watering (non-blocking state machine)
// ============================================================

// Porneşte o udare. `ml = 0` înseamnă udare manuală nelimitată (se opreşte
// abia la /water/stop). `ml > 0` activează modul "dose": pompa se opreşte
// automat după ml/pumpFlowMlPerSec secunde (debitul activ, încărcat din
// EEPROM la boot şi editabil din dashboard).
void startWatering(int port, uint16_t ml) {

  Serial.print("Starting watering on port ");
  Serial.print(port + 1);
  if (ml > 0) {
    Serial.print(" cu doza ");
    Serial.print(ml);
    Serial.print(" ml (~");
    Serial.print((uint32_t)(ml / pumpFlowMlPerSec));
    Serial.print(" s)");
  }
  Serial.println();

  // Salvăm doza ca să o putem folosi la PHASE_PUMP_STOPPING (statistici)
  // şi la calculul timeout-ului în PHASE_PUMPING.
  doseLastMl     = ml;
  doseDurationMs = (ml > 0) ? (unsigned long)(ml * 1000UL / pumpFlowMlPerSec) : 0;

  // Deschide valva imediat
  digitalWrite(valvePin[port], HIGH);
  valveOn[port] = true;
  wateringPort = port;
  wateringPhase = PHASE_VALVE_OPENING;
  phaseStartTime = millis();
}

void stopWatering() {

  if (wateringPort < 0) return;

  int port = wateringPort;
  Serial.print("Stopping watering on port ");
  Serial.println(port + 1);

  // Opreste pompa imediat
  digitalWrite(PIN_PUMP, LOW);
  pumpOn = false;
  wateringPhase = PHASE_PUMP_STOPPING;
  phaseStartTime = millis();
}

// ============================================================
//  Regulator PI automat — decizie de udare per port
//  Implementeaza fidel misc/decizie_udare_diagrama.svg.
// ============================================================
//
// Apelata periodic din loopNormal (autoWateringEvaluate). Pentru fiecare port
// confirmat + configurat + cu auto-udare activata, ruleaza un "tick" de
// regulator la fiecare REG_TICK_MS. Algoritmul (vezi diagrama):
//   h  = umiditate masurata; dt = minute de la ultima udare
//   1. dt >= safety_max         -> UDARE FORTATA (target_dose_ml)
//   2. dt <  ANTI_TWITCH        -> NU UDA (cooldown)
//   3. e = setpoint - h; daca e>0: I += Ki·e·Δt  (acumulez datoria de apa)
//   4. h > setpoint - hist      -> NU UDA (solul are inca apa)
//   5. dt <  T_min              -> NU UDA (asteptam cadenta biologica)
//   6. doza = clamp(max(Kp·e + I, target_dose_ml), 5, 200) -> UDARE; I = 0

// Minute de la ultima udare a portului (din NodeStats.lastWatering + RTC).
// Daca nu avem RTC sau nu s-a udat niciodata, intoarce un numar foarte mare
// (tratam ca "demult", deci cadenta/safety sunt satisfacute).
static uint32_t minutesSinceLastWatering(const char* name) {
  if (!rtcOk) return 0xFFFFFFFFUL;
  uint32_t now = rtcEpoch();
  NodeStats st;
  if (!storageLoadStats(name, st) || st.lastWatering == 0 || now == 0) {
    return 0xFFFFFFFFUL;
  }
  if (now <= st.lastWatering) return 0;
  return (now - st.lastWatering) / 60U;
}

// Ruleaza un tick de regulator pentru un singur port. Intoarce true daca a
// declansat o udare (caz in care apelantul nu mai evalueaza alte porturi in
// acelasi tur — un singur port udat simultan).
static bool autoWateringTickPort(int port) {
  const char* name = portName[port];

  // Conditii de baza: port confirmat fizic, cu senzor proaspat.
  if (!portConfirmed[port] || name[0] == '\0') return false;
  if (portSensors[port].lastUpdateMs == 0) return false;   // niciun SENSE inca
  float h = portSensors[port].soilMoisturePct;
  if (isnan(h) || h < 0) return false;                     // senzor sol absent

  // Config + parametri din EEPROM; auto-udare trebuie sa fie activata.
  NodeConfig cfg; RegParams rp;
  if (!storageLoadConfig(name, cfg) || !cfg.configured) return false;
  if (!storageLoadParams(name, rp) || !rp.autoWateringEnabled) return false;

  float setpoint   = rp.setpoint10  / 10.0f;
  float histerezis = rp.hysteresis10 / 10.0f;
  uint32_t T_min   = rp.tMinMin;
  uint32_t safety  = rp.safetyMaxMin;
  uint16_t target  = rp.targetDoseMl;
  float Kp = rp.Kp, Ki = rp.Ki;

  uint32_t dt = minutesSinceLastWatering(name);   // minute de la ultima udare
  float& I = portReg[port].integralMl;            // acumulator integral [ml]

  // --- 1. SAFETY MAX: prea mult fara udare -> udare fortata cu target ---
  if (dt >= safety) {
    uint16_t doza = target;
    if (doza < DOSE_MIN_ML) doza = DOSE_MIN_ML;
    if (doza > DOSE_MAX_ML) doza = DOSE_MAX_ML;
    Serial.printf("[AUTO %s] SAFETY (dt=%lumin >= %lumin) -> udare fortata %u ml\n",
                  name, (unsigned long)dt, (unsigned long)safety, doza);
    startWatering(port, doza);
    I = 0;   // reset anti-windup
    return true;
  }

  // --- 2. ANTI-TWITCH: am udat foarte recent -> cooldown ---
  if (dt < ANTI_TWITCH_MIN) {
    return false;
  }

  // --- 3. Acumulare integrala (doar cat timp avem deficit, e>0) ---
  float e = setpoint - h;          // eroare [%]
  if (e > 0) {
    I += Ki * e * REG_DT_H;        // Ki [ml/(%·h)] · e [%] · Δt [h] = [ml]
    // Clamp anti-windup: integrala nu poate depasi doza maxima utila.
    if (I > DOSE_MAX_ML) I = DOSE_MAX_ML;
  }
  if (I < 0) I = 0;

  // --- 4. Histerezis: solul inca are destula apa -> nu uda ---
  if (h > setpoint - histerezis) {
    return false;
  }

  // --- 5. Cadenta biologica: nu a trecut inca T_min -> asteptam ---
  if (dt < T_min) {
    return false;
  }

  // --- 6. Calcul doza PI + udare + reset integrala ---
  float doza_pi = Kp * e + I;
  float doza = doza_pi > target ? doza_pi : target;
  if (doza < DOSE_MIN_ML) doza = DOSE_MIN_ML;
  if (doza > DOSE_MAX_ML) doza = DOSE_MAX_ML;
  uint16_t dozaMl = (uint16_t)(doza + 0.5f);

  Serial.printf("[AUTO %s] UDARE PI: h=%.1f%% e=%.1f%% I=%.1fml Kp=%.3f Ki=%.4f "
                "-> doza=%u ml (dt=%lumin)\n",
                name, h, e, I, Kp, Ki, dozaMl, (unsigned long)dt);
  startWatering(port, dozaMl);
  I = 0;   // reset anti-windup dupa udare
  return true;
}

// Evaluata periodic din loopNormal. Ruleaza tick-uri de regulator la
// REG_TICK_MS pentru porturile eligibile. Sare complet daca o udare (manuala
// sau automata) e deja in curs — un singur port udat simultan.
void autoWateringEvaluate() {
  if (wateringPhase != PHASE_IDLE) return;   // udare in curs -> nu pornim alta
  if (!eepromReady) return;                  // fara EEPROM nu avem config/params
  // Fara RTC nu putem calcula cadenta (dt) corect: minutesSinceLastWatering ar
  // intoarce mereu "demult" si udarea automata ar declansa la fiecare safety.
  // RTC-ul e deci obligatoriu pentru udarea automata sigura.
  if (!rtcOk) return;

  unsigned long now = millis();
  for (int p = 0; p < NUM_PORTS; p++) {
    // Tick doar daca a trecut REG_TICK_MS de la ultimul tick al portului.
    if (portReg[p].lastTickMs != 0 && (now - portReg[p].lastTickMs) < REG_TICK_MS) {
      continue;
    }
    portReg[p].lastTickMs = now;
    if (autoWateringTickPort(p)) {
      // A declansat o udare — ne oprim (un singur port simultan). Celelalte
      // porturi vor fi evaluate la urmatoarele tick-uri, dupa ce udarea se termina.
      break;
    }
  }
}

void updateWateringStateMachine() {

  unsigned long now = millis();

  switch (wateringPhase) {

    case PHASE_VALVE_OPENING:
      if (now - phaseStartTime >= VALVE_OPEN_DELAY) {
        // Porneste pompa — şi memorăm momentul (pentru auto-stop dose).
        digitalWrite(PIN_PUMP, HIGH);
        pumpOn = true;
        wateringPhase = PHASE_PUMPING;
        phaseStartTime = now;
        Serial.println("Pump ON");
      }
      break;

    case PHASE_PUMPING:
      // RECOVERY: cat timp livram o doza fixa, salvam periodic in EEPROM cati
      // ml mai raman, ca sa putem relua daca se ia curentul. Doar in mod "dose"
      // (doseDurationMs > 0) — udarea manuala nelimitata nu are tinta de reluat.
      if (doseDurationMs > 0 && wateringPort >= 0 &&
          (now - recoveryLastSaveMs) >= RECOVERY_SAVE_MS) {
        recoveryLastSaveMs = now;
        // ml livrati pana acum = debit × timp_scurs; ml ramasi = doza − livrati.
        float deliveredMl = pumpFlowMlPerSec * (now - phaseStartTime) / 1000.0f;
        int remaining = (int)doseLastMl - (int)(deliveredMl + 0.5f);
        if (remaining < 0) remaining = 0;
        saveWateringProgress(wateringPort, (uint16_t)remaining);
      }
      // Dacă suntem în mod "dose", oprim automat după durata calculată.
      // Pentru udarea manuală (doseDurationMs == 0), aşteptăm /water/stop.
      if (doseDurationMs > 0 && (now - phaseStartTime) >= doseDurationMs) {
        Serial.print("Dose complete (");
        Serial.print(doseLastMl);
        Serial.println(" ml) — stopping pump");
        digitalWrite(PIN_PUMP, LOW);
        pumpOn = false;
        wateringPhase = PHASE_PUMP_STOPPING;
        phaseStartTime = now;
      }
      break;

    case PHASE_PUMP_STOPPING:
      if (now - phaseStartTime >= PUMP_STOP_DELAY) {
        int finishedPort = wateringPort;
        // Inchide valva
        if (finishedPort >= 0) {
          digitalWrite(valvePin[finishedPort], LOW);
          valveOn[finishedPort] = false;
        }
        wateringPort = -1;
        wateringPhase = PHASE_IDLE;
        Serial.println("Watering stopped completely");

        // Înregistrăm udarea în statisticile EEPROM ale nodului.
        // Pentru udarea cu cantitate fixă ("dose"), folosim ml-ii reali
        // ceruţi. Pentru udare manuală nelimitată, fallback pe estimarea
        // salvată în RegParams (până la regulator PI cu debitmetru).
        if (finishedPort >= 0 && portConfirmed[finishedPort]) {
          const char* name = portName[finishedPort];
          uint16_t ml = doseLastMl;
          if (ml == 0) {
            RegParams rp;
            if (storageLoadParams(name, rp)) {
              ml = rp.doseEstimatMl;
            }
          }
          if (statsRecordWatering(name, ml)) {
            Serial.print("Stats updated for ");
            Serial.print(name);
            Serial.print(": +");
            Serial.print(ml);
            Serial.println(" ml");
          }
        }
        // RECOVERY: udarea s-a terminat normal — zeroizam slotul de recovery
        // ca sa nu apara un fals "udare intrerupta" la urmatorul boot.
        storageClearRecovery();

        // Reset state pentru următoarea udare.
        doseDurationMs = 0;
        doseLastMl     = 0;
      }
      break;

    default:
      break;
  }
}

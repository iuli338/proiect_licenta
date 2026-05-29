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
        // Reset state pentru următoarea udare.
        doseDurationMs = 0;
        doseLastMl     = 0;
      }
      break;

    default:
      break;
  }
}

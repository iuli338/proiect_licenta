/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   Arduino concateneaza automat toate fisierele .ino din folder;
   variabilele globale si include-urile sunt in esp32_hub_v6.ino.
   ============================================================ */

// ============================================================
//  Watering (non-blocking state machine)
// ============================================================

void startWatering(int port) {

  Serial.print("Starting watering on port ");
  Serial.println(port + 1);

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
        // Porneste pompa
        digitalWrite(PIN_PUMP, HIGH);
        pumpOn = true;
        wateringPhase = PHASE_PUMPING;
        Serial.println("Pump ON");
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
        // Doza livrată: o estimăm din `doseEstimatMl` salvat la
        // configurare (aproximaţie până la regulator PI cu debitmetru).
        if (finishedPort >= 0 && portConfirmed[finishedPort]) {
          const char* name = portName[finishedPort];
          RegParams rp;
          uint16_t ml = 0;
          if (storageLoadParams(name, rp)) {
            ml = rp.doseEstimatMl;
          }
          if (statsRecordWatering(name, ml)) {
            Serial.print("Stats updated for ");
            Serial.print(name);
            Serial.print(": +");
            Serial.print(ml);
            Serial.println(" ml");
          }
        }
      }
      break;

    default:
      break;
  }
}

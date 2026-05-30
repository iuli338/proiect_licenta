/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   Arduino concateneaza automat toate fisierele .ino din folder;
   variabilele globale si include-urile sunt in esp32_hub_v6.ino.
   ============================================================ */

// Format float pentru JSON: NaN / Inf / -Inf → "null".
// `decimals` controlează numărul de zecimale (umiditate / temperaturi 1, lux 0).
static String jsonFloat(float v, int decimals) {
  if (isnan(v) || isinf(v)) return String("null");
  char buf[16];
  dtostrf(v, 0, decimals, buf);
  return String(buf);
}

// Predictie "Următoarea udare" — proiecteaza in viitor ACELASI regulator PI
// care decide udarea (vezi autoWateringTickPort + misc/decizie_udare_diagrama).
// Estimeaza CAND vor fi indeplinite conditiile de udare ale PI-ului si CE doza
// ar livra atunci, ca afisajul din dashboard sa fie coerent cu ce face firmware-ul.
//
// Conditiile PI de udare: (dt >= T_min SI h <= setpoint-hist), sau dt >= safety.
// Deci momentul = min(safety, max(t_prag, t_cadenta)):
//   t_prag    = τ · ln(h / (setpoint - histerezis))    [ore → min]  (cand h scade sub prag)
//   t_cadenta = T_min - dt                              [min]        (cand se atinge cadenta)
//   t_safety  = safety_max - dt                         [min]        (override siguranta)
// Doza estimata = clamp(max(Kp·e_estim + I_curent, target), 5, 200), unde e_estim
// e eroarea proiectata la momentul udarii (≈ histerezis, h ≈ prag) si I_curent e
// integrala acumulata de regulator pana acum (parametru `integral_ml`).
static bool predictNextWatering(const RegParams& rp,
                                float h_curent,
                                uint32_t minutes_since_last,
                                float integral_ml,
                                uint32_t& out_minutes,
                                uint16_t& out_dose_ml,
                                const char*& out_reason) {
  if (isnan(h_curent) || h_curent < 0) return false;

  float setpoint   = rp.setpoint10  / 10.0f;
  float histerezis = rp.hysteresis10 / 10.0f;
  float tau_h      = rp.tauH;
  uint32_t T_min   = rp.tMinMin;
  uint32_t safety_max = rp.safetyMaxMin;
  uint16_t target  = rp.targetDoseMl;
  float Kp         = rp.Kp;

  // 1. Timp până sub prag (uscare exponenţială).
  float prag = setpoint - histerezis;
  float t_prag_min;
  if (h_curent <= prag) {
    t_prag_min = 0;
  } else if (h_curent <= 0.5f || prag <= 0) {
    return false;   // imposibil de calculat
  } else {
    float t_prag_h = tau_h * logf(h_curent / prag);
    t_prag_min = t_prag_h * 60.0f;
  }

  // 2. Timp până la T_min.
  float t_cadenta_min = (minutes_since_last >= T_min)
                         ? 0.0f : (float)(T_min - minutes_since_last);
  // 3. Safety max.
  float t_safety_min = (minutes_since_last >= safety_max)
                         ? 0.0f : (float)(safety_max - minutes_since_last);

  float t_principal = t_prag_min > t_cadenta_min ? t_prag_min : t_cadenta_min;
  float t_final;
  if (t_safety_min <= t_principal) {
    t_final = t_safety_min;
    out_reason = "safety";
  } else {
    t_final = t_principal;
    out_reason = (t_cadenta_min > t_prag_min) ? "cadenta" : "prag";
  }

  if (t_final < 0) t_final = 0;
  out_minutes = (uint32_t)(t_final + 0.5f);

  // Doza estimată — aceeasi formula ca regulatorul PI la momentul udarii:
  // la atingerea pragului, h ≈ setpoint-hist, deci eroarea proiectata e_estim
  // ≈ histerezis. doza = max(Kp·e_estim + I_curent, target), clamp 5..200.
  float e_estim = histerezis;
  float doza = Kp * e_estim + integral_ml;
  if (doza < target) doza = target;
  if (doza < DOSE_MIN_ML) doza = DOSE_MIN_ML;
  if (doza > DOSE_MAX_ML) doza = DOSE_MAX_ML;
  out_dose_ml = (uint16_t)(doza + 0.5f);

  return true;
}

// Trimite header-ele CORS — dashboard-ul accesează hub-ul din browser.
void sendCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
}

// ============================================================
//  HTTP handlers
// ============================================================

int parsePortFromUri(const String& uri, const String& prefix) {
  // Extrage numarul portului din URI gen "/water/start/2"
  int idx = uri.lastIndexOf('/');
  if (idx < 0) return -1;
  String numStr = uri.substring(idx + 1);
  int port = numStr.toInt() - 1;  // user-facing 1-based, intern 0-based
  if (port < 0 || port >= NUM_PORTS) return -1;
  return port;
}

void handleWaterStart() {

  if (!checkAccessCode()) return;   // cod lipsa/gresit => 404
  sendCorsHeaders();

  int port = parsePortFromUri(server.uri(), "/water/start/");
  if (port < 0) {
    server.send(400, "application/json", "{\"error\":\"invalid port\"}");
    return;
  }

  if (!portConfirmed[port]) {
    server.send(400, "application/json", "{\"error\":\"port not confirmed\"}");
    return;
  }

  if (wateringPhase != PHASE_IDLE && wateringPort != port) {
    server.send(409, "application/json", "{\"error\":\"another port is watering\"}");
    return;
  }

  if (wateringPort == port && wateringPhase != PHASE_IDLE) {
    // Already watering this port, idempotent
    server.send(200, "application/json", "{\"status\":\"already watering\"}");
    return;
  }

  startWatering(port, 0);   // ml=0 => udare manuală nelimitată

  String json = "{\"status\":\"watering\",\"port\":";
  json += port + 1;
  json += "}";
  server.send(200, "application/json", json);
}

// POST /dose/<port>?ml=<ml> — porneşte o udare cu cantitate fixă pe portul
// specificat. NU cere portConfirmed (e endpoint de test/calibrare — trebuie
// să meargă şi cu nodul deconectat). Răspunde 200 imediat cu duraţa
// estimată (ms). Pompa se opreşte automat după acea durată; UI-ul
// detectează asta prin polling pe /status (wateringPort revine la -1).
void handleDose() {

  if (!checkAccessCode()) return;   // cod lipsa/gresit => 404
  sendCorsHeaders();

  // Port: parsate din URI ("/dose/1"); ml: argument query "?ml=50".
  int port = parsePortFromUri(server.uri(), "/dose/");
  if (port < 0) {
    server.send(400, "application/json", "{\"error\":\"invalid port\"}");
    return;
  }
  if (!server.hasArg("ml")) {
    server.send(400, "application/json",
      "{\"error\":\"missing ?ml=<n>\"}");
    return;
  }
  int mlArg = server.arg("ml").toInt();
  if (mlArg < 1 || mlArg > 500) {
    server.send(400, "application/json",
      "{\"error\":\"ml out of range (1..500)\"}");
    return;
  }
  int portArg = port + 1;

  // Lock: orice udare în curs (manuală sau dose) blochează un nou start.
  if (wateringPhase != PHASE_IDLE) {
    server.send(409, "application/json",
      "{\"error\":\"watering already active\"}");
    return;
  }
  // Lock: pompa pornită manual prin /toggle/16 blochează dozarea.
  if (pumpOn) {
    server.send(409, "application/json",
      "{\"error\":\"pump is on manually\"}");
    return;
  }

  startWatering(port, (uint16_t)mlArg);

  // Durata totală estimată (ms): valve open delay + dose duration + pump stop delay.
  unsigned long doseMs = (unsigned long)(mlArg * 1000UL / pumpFlowMlPerSec);
  unsigned long totalMs = VALVE_OPEN_DELAY + doseMs + PUMP_STOP_DELAY;

  String json = "{\"status\":\"dosing\",\"port\":";
  json += portArg;
  json += ",\"ml\":";
  json += mlArg;
  json += ",\"dose_ms\":";
  json += doseMs;
  json += ",\"total_ms\":";
  json += totalMs;
  json += "}";
  server.send(200, "application/json", json);
}

void handleWaterStop() {

  if (!checkAccessCode()) return;   // cod lipsa/gresit => 404
  sendCorsHeaders();

  int port = parsePortFromUri(server.uri(), "/water/stop/");
  if (port < 0) {
    server.send(400, "application/json", "{\"error\":\"invalid port\"}");
    return;
  }

  if (wateringPort != port) {
    server.send(200, "application/json", "{\"status\":\"not watering this port\"}");
    return;
  }

  stopWatering();

  String json = "{\"status\":\"stopped\",\"port\":";
  json += port + 1;
  json += "}";
  server.send(200, "application/json", json);
}

// Toggle individual pin handlers (for the Control tab)
void handleTogglePin(int pin, bool& stateRef) {

  if (!checkAccessCode()) return;   // cod lipsa/gresit => 404

  // Daca o udare automata e activa, nu permite toggle manual
  if (wateringPhase != PHASE_IDLE) {
    sendCorsHeaders();
    server.send(409, "application/json",
      "{\"error\":\"watering active, manual toggle blocked\"}");
    return;
  }

  stateRef = !stateRef;
  digitalWrite(pin, stateRef ? HIGH : LOW);

  // Mentine sincron starile pompa/valve
  if (pin == PIN_PUMP)   pumpOn = stateRef;
  if (pin == PIN_VALVE1) valveOn[0] = stateRef;
  if (pin == PIN_VALVE2) valveOn[1] = stateRef;
  if (pin == PIN_VALVE3) valveOn[2] = stateRef;

  String json = "{\"pin\":";
  json += pin;
  json += ",\"state\":";
  json += stateRef ? "true" : "false";
  json += "}";

  sendCorsHeaders();
  server.send(200, "application/json", json);
}

void handleToggle16() { handleTogglePin(PIN_PUMP,   pumpOn); }
void handleToggle17() { handleTogglePin(PIN_VALVE1, valveOn[0]); }
void handleToggle18() { handleTogglePin(PIN_VALVE2, valveOn[1]); }
void handleToggle19() { handleTogglePin(PIN_VALVE3, valveOn[2]); }

void handleStatus() {

  if (!checkAccessCode()) return;   // cod lipsa/gresit => 404

  String json = "{\"ports\":[";

  for (int i = 0; i < NUM_PORTS; i++) {
    if (i > 0) json += ",";
    json += "{";
    json += "\"port\":";
    json += i + 1;
    json += ",\"physical\":";
    json += (portPhysical[i] ? "true" : "false");
    json += ",\"confirmed\":";
    json += (portConfirmed[i] ? "true" : "false");
    json += ",\"name\":\"";
    json += portName[i];
    json += "\",\"valve\":";
    json += (valveOn[i] ? "true" : "false");
    // Citirile senzorilor — null dacă portul nu a trimis încă nimic.
    // Câmpurile individuale sunt null când senzorul respectiv lipseşte
    // (NAN convertit prin jsonFloat).
    json += ",\"sensors\":";
    if (portConfirmed[i] && portSensors[i].lastUpdateMs > 0) {
      json += "{\"soil_moisture_pct\":"; json += jsonFloat(portSensors[i].soilMoisturePct, 1);
      json += ",\"air_temp_c\":";         json += jsonFloat(portSensors[i].airTempC,        1);
      json += ",\"air_humidity_pct\":";   json += jsonFloat(portSensors[i].airHumidityPct,  1);
      json += ",\"lux\":";                json += jsonFloat(portSensors[i].lux,             0);
      json += ",\"age_ms\":";             json += (uint32_t)(millis() - portSensors[i].lastUpdateMs);
      json += "}";
    } else {
      json += "null";
    }

    // Predicţia "Următoarea udare" — doar pentru porturile confirmate cu
    // configuraţie validă, senzor proaspăt şi auto-udare activată.
    // Frontend afişează block-ul de status auto pe baza acestor date.
    json += ",\"next_watering\":";
    bool predicted = false;
    if (portConfirmed[i] && portName[i][0] != '\0' &&
        portSensors[i].lastUpdateMs > 0) {
      NodeConfig cfg; RegParams rp; NodeStats st;
      if (storageLoadConfig(portName[i], cfg) && cfg.configured &&
          storageLoadParams(portName[i], rp) && rp.autoWateringEnabled) {
        storageLoadStats(portName[i], st);
        // Minute de la ultima udare. RTC epoch curent − lastWatering.
        uint32_t nowEpoch = rtcOk ? rtcEpoch() : 0;
        uint32_t mins_since = 0;
        if (nowEpoch > 0 && st.lastWatering > 0 && nowEpoch >= st.lastWatering) {
          mins_since = (nowEpoch - st.lastWatering) / 60;
        }
        uint32_t mins_until = 0;
        uint16_t est_dose = 0;
        const char* reason = "";
        if (predictNextWatering(rp, portSensors[i].soilMoisturePct,
                                mins_since, portReg[i].integralMl,
                                mins_until, est_dose, reason)) {
          json += "{\"minutes_until\":";       json += mins_until;
          json += ",\"estimated_dose_ml\":";   json += est_dose;
          json += ",\"reason\":\"";            json += reason; json += "\"";
          json += ",\"minutes_since_last\":";  json += mins_since;
          json += "}";
          predicted = true;
        }
      }
    }
    if (!predicted) json += "null";

    json += "}";
  }

  json += "],\"channel\":";
  json += currentWifiChannel;
  json += ",\"pump\":";
  json += (pumpOn ? "true" : "false");
  json += ",\"wateringPort\":";
  json += wateringPort < 0 ? -1 : wateringPort + 1;
  // uptime_ms — folosit de PC ca să detecteze un reboot al hub-ului
  // (uptime scade brusc => boot nou => recer log-ul de diagnostic).
  json += ",\"uptime_ms\":";
  json += (uint32_t)millis();
  // Ora curentă din RTC, format HH:MM (european). Null dacă RTC absent.
  if (rtcOk) {
    char tbuf[6];
    snprintf(tbuf, sizeof(tbuf), "%02u:%02u", rtcHour, rtcMinute);
    json += ",\"time\":\"";
    json += tbuf;
    json += "\"";
  } else {
    json += ",\"time\":null";
  }
  // Debitul activ al pompei [ml/s] — afişat şi editabil din tab-ul Setări.
  {
    int whole = (int)pumpFlowMlPerSec;
    int frac  = (int)((pumpFlowMlPerSec - whole) * 100.0f + 0.5f);
    char fbuf[16];
    snprintf(fbuf, sizeof(fbuf), "%d.%02d", whole, frac);
    json += ",\"flow_ml_per_sec\":";
    json += fbuf;
  }
  json += "}";

  sendCorsHeaders();
  server.send(200, "application/json", json);
}

// Returneaza log-ul de boot + status pe module ca JSON. Folosit de UI
// la apasarea butonului "Vezi diagnostica" pe cardul de stare hub.
void handleDiagnostics() {
  if (!checkAccessCode()) return;
  sendCorsHeaders();

  // Buffer-ul de log poate contine caractere care strica JSON-ul ({"},\
  // \n). Escapem la trimitere.
  String escaped;
  escaped.reserve(bootLogLen + 32);
  for (size_t i = 0; i < bootLogLen; i++) {
    char c = bootLog[i];
    if (c == '"')      escaped += "\\\"";
    else if (c == '\\') escaped += "\\\\";
    else if (c == '\n') escaped += "\\n";
    else if (c == '\r') escaped += "\\r";
    else if (c == '\t') escaped += "\\t";
    else if ((uint8_t)c < 0x20) {
      // alte control chars — skip
    } else {
      escaped += c;
    }
  }

  String json = "{";
  json += "\"uptime_ms\":";  json += (uint32_t)millis();
  json += ",\"oled\":";      json += (oledOk      ? "true" : "false");
  json += ",\"eeprom\":";    json += (eepromReady ? "true" : "false");
  json += ",\"rtc\":";       json += (rtcOk       ? "true" : "false");
  json += ",\"boot_log\":\""; json += escaped;       json += "\"";
  json += "}";

  server.send(200, "application/json", json);
}

void handleOptions() {
  sendCorsHeaders();
  server.send(204);
}

// Setarea orei RTC din UI — POST /time, body: {"time":"HH:MM"}.
// Validare strictă: ambele câmpuri 2 cifre, 00..23 şi 00..59.
void handleSetTime() {
  if (!checkAccessCode()) return;
  sendCorsHeaders();

  if (!rtcOk) {
    server.send(503, "application/json", "{\"error\":\"rtc absent\"}");
    return;
  }

  String body = server.hasArg("plain") ? server.arg("plain") : "";
  // Parsing simplu — căutăm \"time\":\"HH:MM\".
  int k = body.indexOf("\"time\"");
  if (k < 0) {
    server.send(400, "application/json", "{\"error\":\"missing time\"}");
    return;
  }
  int q1 = body.indexOf('"', body.indexOf(':', k) + 1);
  int q2 = body.indexOf('"', q1 + 1);
  if (q1 < 0 || q2 < 0 || q2 - q1 != 6) {
    server.send(400, "application/json", "{\"error\":\"format invalid (HH:MM)\"}");
    return;
  }
  String t = body.substring(q1 + 1, q2);   // "HH:MM"
  if (t.length() != 5 || t.charAt(2) != ':') {
    server.send(400, "application/json", "{\"error\":\"format invalid\"}");
    return;
  }
  int hh = t.substring(0, 2).toInt();
  int mm = t.substring(3, 5).toInt();
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    server.send(400, "application/json", "{\"error\":\"valori in afara intervalului\"}");
    return;
  }
  if (!rtcSetHourMinute((uint8_t)hh, (uint8_t)mm)) {
    server.send(500, "application/json", "{\"error\":\"rtc write failed\"}");
    return;
  }
  Serial.print("RTC: ora setata manual la ");
  Serial.print(hh); Serial.print(":"); Serial.println(mm);

  char resp[40];
  snprintf(resp, sizeof(resp), "{\"ok\":true,\"time\":\"%02d:%02d\"}", hh, mm);
  server.send(200, "application/json", resp);
}

// Setarea debitului pompei din UI — POST /flow-rate, body:
// {"flow_ml_per_sec": 3.21}. Validare: PUMP_FLOW_MIN..PUMP_FLOW_MAX.
//
// Comportament în funcţie de starea EEPROM-ului:
//   - EEPROM OK  : scrie persistent + actualizează variabila globală;
//                  răspunde {"ok":true,"persisted":true,...}.
//   - EEPROM lipsă: actualizează DOAR variabila globală (debitul e valabil
//                  până la următorul reboot); răspunde {"ok":true,
//                  "persisted":false,...}. UI-ul arată un avertisment galben.
void handleSetFlowRate() {
  if (!checkAccessCode()) return;   // cod lipsa/gresit => 404
  sendCorsHeaders();

  String body = server.hasArg("plain") ? server.arg("plain") : "";
  int k = body.indexOf("\"flow_ml_per_sec\"");
  if (k < 0) {
    server.send(400, "application/json",
      "{\"error\":\"missing flow_ml_per_sec\"}");
    return;
  }
  // Valoarea e după primul ':' care urmează cheii (număr, nu string).
  int colon = body.indexOf(':', k);
  if (colon < 0) {
    server.send(400, "application/json", "{\"error\":\"format invalid\"}");
    return;
  }
  float v = body.substring(colon + 1).toFloat();
  if (v < PUMP_FLOW_MIN || v > PUMP_FLOW_MAX) {
    server.send(400, "application/json",
      "{\"error\":\"flow out of range\"}");
    return;
  }

  bool persisted = false;
  if (eepromReady) {
    // saveFlowRate scrie EEPROM + actualizează variabila globală.
    persisted = saveFlowRate(v);
    if (!persisted) {
      server.send(500, "application/json",
        "{\"error\":\"eeprom write failed\"}");
      return;
    }
  } else {
    // Fără EEPROM: aplicăm doar în RAM (se pierde la reboot).
    pumpFlowMlPerSec = v;
    Serial.print("Debit pompa setat DOAR in RAM (EEPROM lipsa): ");
    Serial.print(pumpFlowMlPerSec);
    Serial.println(" ml/s");
  }

  // Răspundem cu debitul efectiv aplicat (rotunjit la 2 zecimale prin x100)
  // şi cu flag-ul persisted, ca UI-ul să decidă tipul de toast.
  int whole = (int)pumpFlowMlPerSec;
  int frac  = (int)((pumpFlowMlPerSec - whole) * 100.0f + 0.5f);
  char resp[80];
  snprintf(resp, sizeof(resp),
    "{\"ok\":true,\"persisted\":%s,\"flow_ml_per_sec\":%d.%02d}",
    persisted ? "true" : "false", whole, frac);
  server.send(200, "application/json", resp);
}

// Sterge credentialele la cerere de la dashboard (reset de la distanta).
// Cere cod de acces — la fel ca restul endpoint-urilor private — ca să nu
// poată reseta cineva din reţea fără autentificare.
void handleResetProvisioning() {
  if (!checkAccessCode()) return;   // cod lipsa/gresit => 404
  sendCorsHeaders();
  clearCredentials();
  server.send(200, "application/json",
    "{\"status\":\"provisioning reset, rebooting\"}");
  delay(500);
  ESP.restart();
}

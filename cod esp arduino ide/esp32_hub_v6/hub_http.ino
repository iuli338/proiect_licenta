/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   Arduino concateneaza automat toate fisierele .ino din folder;
   variabilele globale si include-urile sunt in esp32_hub_v6.ino.
   ============================================================ */

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

  startWatering(port);

  String json = "{\"status\":\"watering\",\"port\":";
  json += port + 1;
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

// Sterge credentialele la cerere de la dashboard (reset de la distanta).
void handleResetProvisioning() {
  sendCorsHeaders();
  clearCredentials();
  server.send(200, "application/json",
    "{\"status\":\"provisioning reset, rebooting\"}");
  delay(500);
  ESP.restart();
}

/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   ============================================================

   HTTP handlers pentru configuraţia + statisticile per nod, persistate
   în EEPROM-ul AT24C256.

   Rute:
     GET  /node/<P>/config   → JSON cu plant + soil + params + stats
     POST /node/<P>/config   → primeşte JSON din wizard / pagina Parametri
     GET  /node/<P>/stats    → doar statisticile
     POST /node/<P>/forget   → şterge slot-ul (la deconectare fizică)

   Toate verifică codul de acces prin header X-Access-Code. Parsing JSON
   simplu, manual (la fel ca handleAuth din hub_auth.ino).
   ============================================================ */

// ---------- Utilitare parsing JSON minimal ----------

// Extrage valoarea textuală a unei chei JSON de tip string: "key":"value".
// Returnează "" dacă lipseşte. Nu suportă escape (nu avem nevoie).
static String jsonStr(const String& body, const char* key) {
  String pat = String("\"") + key + "\"";
  int k = body.indexOf(pat);
  if (k < 0) return "";
  int c = body.indexOf(':', k);
  if (c < 0) return "";
  int q1 = body.indexOf('"', c + 1);
  if (q1 < 0) return "";
  int q2 = body.indexOf('"', q1 + 1);
  if (q2 < 0) return "";
  return body.substring(q1 + 1, q2);
}

// Extrage o valoare numerică (int sau float). Returnează `defaultVal` dacă
// lipseşte sau e malformată.
static double jsonNum(const String& body, const char* key, double defaultVal) {
  String pat = String("\"") + key + "\"";
  int k = body.indexOf(pat);
  if (k < 0) return defaultVal;
  int c = body.indexOf(':', k);
  if (c < 0) return defaultVal;
  // Sărim peste whitespace.
  int p = c + 1;
  while (p < (int)body.length() &&
         (body[p] == ' ' || body[p] == '\t' || body[p] == '\n')) p++;
  // Citim caractere până la separator (virgulă, } sau spaţiu).
  int end = p;
  while (end < (int)body.length() &&
         body[end] != ',' && body[end] != '}' && body[end] != ' ' &&
         body[end] != '\n' && body[end] != '\r' && body[end] != '\t') {
    end++;
  }
  if (end == p) return defaultVal;
  return body.substring(p, end).toDouble();
}

// ---------- Identificare port din URI ----------

// URI-uri de forma /node/P1/config -> port 0; P2 -> 1; P3 -> 2.
static int parsePortFromNodeUri(const String& uri) {
  // Caut "/node/P" şi citesc cifra următoare.
  int k = uri.indexOf("/node/P");
  if (k < 0) return -1;
  if ((int)uri.length() <= k + 7) return -1;
  char c = uri.charAt(k + 7);
  if (c < '1' || c > '9') return -1;
  int port = (c - '1');
  if (port < 0 || port >= NUM_PORTS) return -1;
  return port;
}

// ---------- Serializare config + stats ca JSON ----------

static String escapeJson(const char* s) {
  String out;
  out.reserve(strlen(s) + 4);
  for (const char* p = s; *p; p++) {
    char c = *p;
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else out += c;
  }
  return out;
}

static const char* waterNeedStr(uint8_t v) {
  switch (v) { case 0: return "scazut"; case 1: return "mediu";
               case 2: return "ridicat"; }
  return "mediu";
}
static const char* retentionStr(uint8_t v) {
  switch (v) { case 0: return "scazut"; case 1: return "mediu";
               case 2: return "ridicat"; }
  return "mediu";
}
static uint8_t parseLevel(const String& s) {
  if (s == "scazut")  return 0;
  if (s == "ridicat") return 2;
  return 1;
}

static String buildNodeJson(int port, const NodeConfig& cfg,
                            const RegParams& rp, const NodeStats& st) {
  String json = "{";
  json += "\"port\":";
  json += (port + 1);
  json += ",\"configured\":";
  json += (cfg.configured ? "true" : "false");

  // plant
  json += ",\"plant\":{";
  json += "\"id\":\"";    json += escapeJson(cfg.plantId);   json += "\",";
  json += "\"name\":\"";  json += escapeJson(cfg.plantName); json += "\",";
  json += "\"water_need\":\""; json += waterNeedStr(cfg.waterNeed); json += "\",";
  json += "\"custom\":";  json += (cfg.plantCustom ? "true" : "false");
  json += "}";

  // soil
  json += ",\"soil\":{";
  json += "\"id\":\"";    json += escapeJson(cfg.soilId);   json += "\",";
  json += "\"name\":\"";  json += escapeJson(cfg.soilName); json += "\",";
  json += "\"retention\":\""; json += retentionStr(cfg.retention); json += "\",";
  json += "\"custom\":";  json += (cfg.soilCustom ? "true" : "false");
  json += "}";

  json += ",\"color\":\""; json += escapeJson(cfg.color); json += "\"";

  // regulator
  json += ",\"regulator\":{";
  json += "\"model\":{\"K\":";  json += String(rp.K, 3);
  json += ",\"tau_h\":";        json += String(rp.tauH, 1);   json += "},";
  json += "\"setpoint\":";      json += (rp.setpoint10 / 10.0);
  json += ",\"hysteresis\":";   json += (rp.hysteresis10 / 10.0);
  json += ",\"lambda_h\":";     json += String(rp.lambdaH, 1);
  json += ",\"Kp\":";           json += String(rp.Kp, 3);
  json += ",\"Ki\":";           json += String(rp.Ki, 4);
  json += ",\"min_interval_min\":"; json += rp.minIntervalMin;
  json += ",\"dose_estimat_ml\":";  json += rp.doseEstimatMl;
  json += "}";

  // stats
  json += ",\"stats\":{";
  json += "\"created_at\":";        json += st.createdAt;
  json += ",\"last_watering\":";    json += st.lastWatering;
  json += ",\"last_seen\":";        json += st.lastSeen;
  json += ",\"total_waterings\":";  json += st.totalWaterings;
  json += ",\"total_ml\":";         json += st.totalMl;
  json += ",\"last_dose_ml\":";     json += st.lastDoseMl;
  json += ",\"last_moisture_pct\":"; json += st.lastMoisturePct;
  json += "}";

  json += "}";
  return json;
}

// ---------- Handlers ----------

void handleNodeGet() {
  if (!checkAccessCode()) return;
  sendCorsHeaders();

  int port = parsePortFromNodeUri(server.uri());
  if (port < 0) {
    server.send(400, "application/json", "{\"error\":\"invalid port\"}");
    return;
  }

  NodeConfig cfg; RegParams rp; NodeStats st;
  storageLoadConfig(port, cfg);
  storageLoadParams(port, rp);
  storageLoadStats(port,  st);

  server.send(200, "application/json", buildNodeJson(port, cfg, rp, st));
}

void handleNodeStats() {
  if (!checkAccessCode()) return;
  sendCorsHeaders();

  int port = parsePortFromNodeUri(server.uri());
  if (port < 0) {
    server.send(400, "application/json", "{\"error\":\"invalid port\"}");
    return;
  }

  NodeStats st;
  storageLoadStats(port, st);

  String json = "{";
  json += "\"port\":";             json += (port + 1);
  json += ",\"created_at\":";      json += st.createdAt;
  json += ",\"last_watering\":";   json += st.lastWatering;
  json += ",\"last_seen\":";       json += st.lastSeen;
  json += ",\"total_waterings\":"; json += st.totalWaterings;
  json += ",\"total_ml\":";        json += st.totalMl;
  json += ",\"last_dose_ml\":";    json += st.lastDoseMl;
  json += ",\"last_moisture_pct\":"; json += st.lastMoisturePct;
  json += "}";
  server.send(200, "application/json", json);
}

void handleNodePost() {
  if (!checkAccessCode()) return;
  sendCorsHeaders();

  int port = parsePortFromNodeUri(server.uri());
  if (port < 0) {
    server.send(400, "application/json", "{\"error\":\"invalid port\"}");
    return;
  }

  String body = server.hasArg("plain") ? server.arg("plain") : "";
  if (body.length() == 0) {
    server.send(400, "application/json", "{\"error\":\"empty body\"}");
    return;
  }

  // Pornim de la valorile EXISTENTE (ca un PATCH parţial).
  NodeConfig cfg; RegParams rp; NodeStats st;
  storageLoadConfig(port, cfg);
  storageLoadParams(port, rp);
  storageLoadStats(port,  st);

  // --- plant ---
  String pid    = jsonStr(body, "plant_id");
  String pname  = jsonStr(body, "plant_name");
  String pneed  = jsonStr(body, "water_need");
  if (pid.length())   { strncpy(cfg.plantId,   pid.c_str(),   sizeof(cfg.plantId)   - 1); cfg.plantId[sizeof(cfg.plantId)-1] = 0; }
  if (pname.length()) { strncpy(cfg.plantName, pname.c_str(), sizeof(cfg.plantName) - 1); cfg.plantName[sizeof(cfg.plantName)-1] = 0; }
  if (pneed.length()) { cfg.waterNeed = parseLevel(pneed); }
  cfg.plantCustom = (jsonNum(body, "plant_custom", cfg.plantCustom) != 0) ? 1 : 0;

  // --- soil ---
  String sid    = jsonStr(body, "soil_id");
  String sname  = jsonStr(body, "soil_name");
  String sret   = jsonStr(body, "retention");
  if (sid.length())   { strncpy(cfg.soilId,   sid.c_str(),   sizeof(cfg.soilId)   - 1); cfg.soilId[sizeof(cfg.soilId)-1] = 0; }
  if (sname.length()) { strncpy(cfg.soilName, sname.c_str(), sizeof(cfg.soilName) - 1); cfg.soilName[sizeof(cfg.soilName)-1] = 0; }
  if (sret.length())  { cfg.retention = parseLevel(sret); }
  cfg.soilCustom = (jsonNum(body, "soil_custom", cfg.soilCustom) != 0) ? 1 : 0;

  // --- color ---
  String color = jsonStr(body, "color");
  if (color.length()) {
    strncpy(cfg.color, color.c_str(), sizeof(cfg.color) - 1);
    cfg.color[sizeof(cfg.color)-1] = 0;
  }

  // --- regulator (toate optionale — PATCH) ---
  rp.K              = (float)jsonNum(body, "K",              rp.K);
  rp.tauH           = (float)jsonNum(body, "tau_h",          rp.tauH);
  rp.lambdaH        = (float)jsonNum(body, "lambda_h",       rp.lambdaH);
  rp.Kp             = (float)jsonNum(body, "Kp",             rp.Kp);
  rp.Ki             = (float)jsonNum(body, "Ki",             rp.Ki);
  rp.setpoint10     = (uint16_t)(jsonNum(body, "setpoint",   rp.setpoint10  / 10.0) * 10.0);
  rp.hysteresis10   = (uint16_t)(jsonNum(body, "hysteresis", rp.hysteresis10 / 10.0) * 10.0);
  rp.minIntervalMin = (uint16_t)jsonNum(body, "min_interval_min", rp.minIntervalMin);
  rp.doseEstimatMl  = (uint16_t)jsonNum(body, "dose_estimat_ml",  rp.doseEstimatMl);

  // --- created_at: o singura data, la prima configurare ---
  uint32_t now = (uint32_t)(time(nullptr));   // 0 daca NTP nu e configurat
  uint32_t createdAt = (uint32_t)jsonNum(body, "created_at", st.createdAt);
  if (st.createdAt == 0) {
    st.createdAt = (createdAt != 0) ? createdAt : now;
  }

  cfg.configured = 1;

  // --- persist (cu un retry la nivel de operaţie, pentru I2C contention) ---
  // Blocăm redesenarea OLED-ului cât scriem — acelaşi bus I2C, evităm
  // ca drawCircles să intervină între cele 3 scrieri (config + params + stats).
  i2cBusyDepth++;
  bool okCfg = storageSaveConfig(port, cfg);
  if (!okCfg) { delay(100); okCfg = storageSaveConfig(port, cfg); }
  bool okPrm = storageSaveParams(port, rp);
  if (!okPrm) { delay(100); okPrm = storageSaveParams(port, rp); }
  bool okSt  = storageSaveStats(port,  st);
  if (!okSt)  { delay(100); okSt  = storageSaveStats(port,  st);  }
  i2cBusyDepth--;

  if (!okCfg || !okPrm || !okSt) {
    Serial.print("storageSave failed after retry: cfg=");
    Serial.print(okCfg);
    Serial.print(" prm=");
    Serial.print(okPrm);
    Serial.print(" st=");
    Serial.print(okSt);
    Serial.print("  eepromReady=");
    Serial.println(eepromReady);
    server.send(500, "application/json", "{\"error\":\"eeprom write failed\"}");
    return;
  }

  Serial.print("Node P");
  Serial.print(port + 1);
  Serial.println(" config saved to EEPROM");

  // Întoarcem starea finală — ca client-ul să poată confirma valorile.
  server.send(200, "application/json", buildNodeJson(port, cfg, rp, st));
}

void handleNodeForget() {
  if (!checkAccessCode()) return;
  sendCorsHeaders();

  int port = parsePortFromNodeUri(server.uri());
  if (port < 0) {
    server.send(400, "application/json", "{\"error\":\"invalid port\"}");
    return;
  }

  // Blocăm OLED-ul cât zeroizăm slot-ul (bus I2C partajat).
  // Retry pe nivel de slot — dacă pică, facem o pauză şi reîncercăm o dată.
  i2cBusyDepth++;
  bool ok = storageClearNode(port);
  if (!ok) {
    Serial.print("storageClearNode P");
    Serial.print(port + 1);
    Serial.println(" attempt 1 failed, retry");
    delay(100);
    ok = storageClearNode(port);
  }
  i2cBusyDepth--;

  if (!ok) {
    Serial.print("storageClearNode P");
    Serial.print(port + 1);
    Serial.println(" failed after retry");
    server.send(500, "application/json",
                "{\"error\":\"eeprom clear failed\"}");
    return;
  }

  Serial.print("Node P");
  Serial.print(port + 1);
  Serial.println(" cleared from EEPROM");
  server.send(200, "application/json", "{\"ok\":true}");
}

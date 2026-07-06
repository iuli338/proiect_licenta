/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   ============================================================

   Persistenţa configuraţiei nodurilor + parametrilor regulatorului
   + statisticilor. Foloseşte driver-ul EEPROM (hub_eeprom.ino).

   Layout-ul detaliat e în esp32_hub_v6.ino (EEPROM_OFFSET_*).

   Strategia:
   - La pornire verificăm header-ul ("DROPv01"). Dacă lipseşte/diferă,
     zeroizăm toate slot-urile şi rescriem header-ul corect (init layout).
   - Operaţiile sunt simple: read/write fix la offset-ul slot-ului.
     Nu folosim CRC per slot — AT24C256 e fiabil intern; eventualitatea
     de slot corupt e rară şi se rezolvă prin reconfigurare din UI.
   ============================================================ */

// Verificări de dimensiuni — dacă struct-urile cresc, layout-ul se rupe.
static_assert(sizeof(EepromHeader)  == 32, "EepromHeader trebuie sa fie 32 B");
static_assert(sizeof(NodeConfig)    == NODE_CONFIG_SIZE, "NodeConfig != 128 B");
static_assert(sizeof(RegParams)     == REG_PARAMS_SIZE,  "RegParams != 64 B");
static_assert(sizeof(NodeStats)     == NODE_STATS_SIZE,  "NodeStats != 64 B");
static_assert(sizeof(SystemConfig)  == SYS_CONFIG_SIZE,  "SystemConfig != 64 B");
static_assert(sizeof(RecoveryState) == RECOVERY_SIZE,    "RecoveryState != 64 B");

// ---------- Offset per NUME NOD ----------
//
// IMPORTANT: slot-urile sunt indexate pe nume (P1/P2/P3 — gravat în firmware-ul
// nodului prin NODE_NAME), NU pe portul fizic. Astfel, configuraţia urmează
// nodul: dacă muţi nodul P1 de pe portul 1 pe portul 2, configul lui rămâne
// în acelaşi slot EEPROM.
//
// Convertim nume → index intern (0/1/2) printr-o singură funcţie nodeIndex(),
// apoi index → offset. Slot 0 = P1, slot 1 = P2, slot 2 = P3.

static int nodeIndex(const char* nodeName) {
  if (!nodeName) return -1;
  if (nodeName[0] != 'P' || nodeName[1] == 0 || nodeName[2] != 0) return -1;
  char c = nodeName[1];
  if (c < '1' || c > '9') return -1;
  int idx = c - '1';
  if (idx < 0 || idx >= NUM_PORTS) return -1;
  return idx;
}

static uint16_t configOffset(int slot) {
  switch (slot) {
    case 0: return EEPROM_OFFSET_CONFIG_P1;
    case 1: return EEPROM_OFFSET_CONFIG_P2;
    case 2: return EEPROM_OFFSET_CONFIG_P3;
  }
  return 0xFFFF;
}
static uint16_t paramsOffset(int slot) {
  switch (slot) {
    case 0: return EEPROM_OFFSET_PARAMS_P1;
    case 1: return EEPROM_OFFSET_PARAMS_P2;
    case 2: return EEPROM_OFFSET_PARAMS_P3;
  }
  return 0xFFFF;
}
static uint16_t statsOffset(int slot) {
  switch (slot) {
    case 0: return EEPROM_OFFSET_STATS_P1;
    case 1: return EEPROM_OFFSET_STATS_P2;
    case 2: return EEPROM_OFFSET_STATS_P3;
  }
  return 0xFFFF;
}

// ---------- Header + init layout ----------

// Citeşte header-ul. Returnează true dacă "DROPv0X" + versiunea aşteptată.
static bool readHeader(EepromHeader& h) {
  if (!eepromRead(EEPROM_OFFSET_HEADER, (uint8_t*)&h, sizeof(h))) return false;
  if (memcmp(h.magic, EEPROM_MAGIC, 8) != 0) return false;
  if (h.version != EEPROM_LAYOUT_VERSION) return false;
  return true;
}

// Zeroizează un slot. Continuă peste erori intermitente (nu se opreşte
// la prima pagină ratată) — asta minimizează cazul "slot pe jumătate
// zeroizat" care produce valori absurde la GET (ex: totalWaterings =
// 0x7F7F7F7F dacă unele octeţi rămân nesetaţi sau corupţi).
// Returnează true dacă TOATE chunk-urile au mers; false dacă măcar unul
// a picat (dar restul s-a tot încercat).
static bool zeroSlot(uint16_t offset, size_t len) {
  uint8_t zeros[64];
  memset(zeros, 0, sizeof(zeros));
  size_t done = 0;
  bool allOk = true;
  while (done < len) {
    size_t chunk = len - done;
    if (chunk > sizeof(zeros)) chunk = sizeof(zeros);
    if (!eepromWrite(offset + done, zeros, chunk)) {
      Serial.print("zeroSlot: chunk pic la 0x");
      Serial.println(offset + done, HEX);
      allOk = false;
      // NU return — continuăm cu următorul chunk pentru a zeroiza cât
      // mai mult; un slot complet zeroizat e mai bun decât unul hibrid.
    }
    done += chunk;
  }
  return allOk;
}

// La pornire: dacă header-ul lipseşte, iniţializăm layout-ul (toate slot-urile
// pe zero, configured=0) şi scriem header-ul corect.
bool storageInit() {
  if (!eepromReady) return false;

  EepromHeader h;
  if (readHeader(h)) {
    Serial.println("EEPROM layout OK");
    return true;
  }

  Serial.println("EEPROM layout absent — initializez slot-urile");
  bootLogf("EEPROM layout absent — zeroizez slot-urile\n");

  // Zeroize toate slot-urile.
  for (int s = 0; s < NUM_PORTS; s++) {
    if (!zeroSlot(configOffset(s), NODE_CONFIG_SIZE)) {
      bootLogf("storageInit: zeroSlot config P%d ESUAT\n", s + 1);
      return false;
    }
    if (!zeroSlot(paramsOffset(s), REG_PARAMS_SIZE)) {
      bootLogf("storageInit: zeroSlot params P%d ESUAT\n", s + 1);
      return false;
    }
    if (!zeroSlot(statsOffset(s),  NODE_STATS_SIZE)) {
      bootLogf("storageInit: zeroSlot stats P%d ESUAT\n", s + 1);
      return false;
    }
  }

  // Slot global de sistem (debit pompă). Zeroizat => valid=0 => firmware-ul
  // foloseşte debitul implicit până la prima setare din dashboard.
  if (!zeroSlot(EEPROM_OFFSET_SYSCFG, SYS_CONFIG_SIZE)) {
    bootLogf("storageInit: zeroSlot syscfg ESUAT\n");
    return false;
  }

  // Scriem header-ul ABIA la final — dacă init-ul cade la mijloc, la
  // pornirea următoare retry-uim de la zero (header-ul lipseşte încă).
  memset(&h, 0, sizeof(h));
  memcpy(h.magic, EEPROM_MAGIC, 8);
  h.version = EEPROM_LAYOUT_VERSION;
  if (!eepromWrite(EEPROM_OFFSET_HEADER, (uint8_t*)&h, sizeof(h))) {
    bootLogf("storageInit: scriere header ESUATA\n");
    return false;
  }

  Serial.println("EEPROM layout initializat");
  bootLogf("EEPROM layout initializat OK\n");
  return true;
}

// ---------- NodeConfig (indexat pe nume nod) ----------

bool storageLoadConfig(const char* nodeName, NodeConfig& cfg) {
  int slot = nodeIndex(nodeName);
  if (slot < 0 || !eepromReady) {
    memset(&cfg, 0, sizeof(cfg));
    return false;
  }
  return eepromRead(configOffset(slot), (uint8_t*)&cfg, sizeof(cfg));
}

bool storageSaveConfig(const char* nodeName, const NodeConfig& cfg) {
  int slot = nodeIndex(nodeName);
  if (slot < 0 || !eepromReady) return false;
  return eepromWrite(configOffset(slot), (const uint8_t*)&cfg, sizeof(cfg));
}

// ---------- RegParams ----------

bool storageLoadParams(const char* nodeName, RegParams& p) {
  int slot = nodeIndex(nodeName);
  if (slot < 0 || !eepromReady) {
    memset(&p, 0, sizeof(p));
    return false;
  }
  return eepromRead(paramsOffset(slot), (uint8_t*)&p, sizeof(p));
}

bool storageSaveParams(const char* nodeName, const RegParams& p) {
  int slot = nodeIndex(nodeName);
  if (slot < 0 || !eepromReady) return false;
  return eepromWrite(paramsOffset(slot), (const uint8_t*)&p, sizeof(p));
}

// ---------- NodeStats ----------

bool storageLoadStats(const char* nodeName, NodeStats& s) {
  int slot = nodeIndex(nodeName);
  if (slot < 0 || !eepromReady) {
    memset(&s, 0, sizeof(s));
    return false;
  }
  return eepromRead(statsOffset(slot), (uint8_t*)&s, sizeof(s));
}

bool storageSaveStats(const char* nodeName, const NodeStats& s) {
  int slot = nodeIndex(nodeName);
  if (slot < 0 || !eepromReady) return false;
  return eepromWrite(statsOffset(slot), (const uint8_t*)&s, sizeof(s));
}

// ---------- Update helpers (NodeStats) ----------

// Înregistrează o udare reuşită pentru un nod: incrementează totalWaterings,
// adaugă ml-ii livraţi, setează lastWatering la epoch-ul curent din RTC.
// Apelat din state machine-ul de udare după finalizarea ciclului.
//
// Protejat de guard-ul i2cBusyDepth ca să nu se intersecteze cu OLED.
bool statsRecordWatering(const char* nodeName, uint16_t ml) {
  int slot = nodeIndex(nodeName);
  if (slot < 0 || !eepromReady) return false;

  NodeStats st;
  if (!storageLoadStats(nodeName, st)) return false;

  st.totalWaterings++;
  st.totalMl     += ml;
  st.lastDoseMl   = ml;
  uint32_t now = rtcEpoch();
  if (now != 0) st.lastWatering = now;

  i2cBusyDepth++;
  bool ok = storageSaveStats(nodeName, st);
  i2cBusyDepth--;
  return ok;
}

// Marchează ultima oră de comunicare cu nodul (heartbeat / SENSE / HELLO).
// Apelat din onDataRecv când vine un mesaj de la un nod cunoscut. Pentru
// moment, HELLO-ul din ESP-NOW poate apela asta; SENSE-ul va veni ulterior.
bool statsTouchLastSeen(const char* nodeName) {
  int slot = nodeIndex(nodeName);
  if (slot < 0 || !eepromReady) return false;
  uint32_t now = rtcEpoch();
  if (now == 0) return false;   // fără RTC nu avem ce scrie

  NodeStats st;
  if (!storageLoadStats(nodeName, st)) return false;
  // Optimizare: nu rescriem dacă diferenţa e <60s — evităm uzura EEPROM.
  if (st.lastSeen != 0 && (now - st.lastSeen) < 60) return true;
  st.lastSeen = now;

  i2cBusyDepth++;
  bool ok = storageSaveStats(nodeName, st);
  i2cBusyDepth--;
  return ok;
}

// Ştergerea unui nod (resetare completă a slot-ului). Zeroizăm TOATE
// secţiunile (config, params, stats) chiar dacă vreuna pică intermitent —
// asta evită cazul "slot pe jumătate şters" care confundă UI-ul.
bool storageClearNode(const char* nodeName) {
  int slot = nodeIndex(nodeName);
  if (slot < 0 || !eepromReady) return false;
  bool ok1 = zeroSlot(configOffset(slot), NODE_CONFIG_SIZE);
  bool ok2 = zeroSlot(paramsOffset(slot), REG_PARAMS_SIZE);
  bool ok3 = zeroSlot(statsOffset(slot),  NODE_STATS_SIZE);
  Serial.print("storageClearNode "); Serial.print(nodeName);
  Serial.print(": cfg="); Serial.print(ok1);
  Serial.print(" prm="); Serial.print(ok2);
  Serial.print(" st=");  Serial.println(ok3);
  return ok1 && ok2 && ok3;
}

// ---------- SystemConfig (debit pompă, global) ----------

bool storageLoadSystem(SystemConfig& sc) {
  if (!eepromReady) { memset(&sc, 0, sizeof(sc)); return false; }
  return eepromRead(EEPROM_OFFSET_SYSCFG, (uint8_t*)&sc, sizeof(sc));
}

bool storageSaveSystem(const SystemConfig& sc) {
  if (!eepromReady) return false;
  i2cBusyDepth++;
  bool ok = eepromWrite(EEPROM_OFFSET_SYSCFG, (const uint8_t*)&sc, sizeof(sc));
  i2cBusyDepth--;
  return ok;
}

// La boot (după storageInit): dacă EEPROM-ul are un debit salvat valid şi
// în interval, îl încarcă în variabila globală pumpFlowMlPerSec. Altfel
// lasă valoarea de fabrică. Apelat din startNormalMode().
void loadFlowRate() {
  if (!eepromReady) {
    bootLogf("Debit pompa: EEPROM lipsa -> implicit %d.%02d ml/s\n",
             (int)PUMP_FLOW_DEFAULT,
             (int)((PUMP_FLOW_DEFAULT - (int)PUMP_FLOW_DEFAULT) * 100));
    return;
  }
  SystemConfig sc;
  if (storageLoadSystem(sc) && sc.valid == 1 && sc.flowMlPerSecX100 > 0) {
    float v = sc.flowMlPerSecX100 / 100.0f;
    if (v >= PUMP_FLOW_MIN && v <= PUMP_FLOW_MAX) {
      pumpFlowMlPerSec = v;
      bootLogf("Debit pompa: incarcat din EEPROM = %d.%02d ml/s\n",
               sc.flowMlPerSecX100 / 100, sc.flowMlPerSecX100 % 100);
      return;
    }
  }
  bootLogf("Debit pompa: slot gol/invalid -> implicit %d.%02d ml/s\n",
           (int)PUMP_FLOW_DEFAULT,
           (int)((PUMP_FLOW_DEFAULT - (int)PUMP_FLOW_DEFAULT) * 100));
}

// Setează un debit nou: validează intervalul, scrie în EEPROM ŞI actualizează
// variabila globală (ambele în acelaşi pas, ca să nu divergă). Returnează
// false dacă valoarea e în afara intervalului sau scrierea EEPROM a picat.
bool saveFlowRate(float mlPerSec) {
  if (mlPerSec < PUMP_FLOW_MIN || mlPerSec > PUMP_FLOW_MAX) return false;
  SystemConfig sc;
  memset(&sc, 0, sizeof(sc));
  sc.valid = 1;
  sc.flowMlPerSecX100 = (uint16_t)(mlPerSec * 100.0f + 0.5f);
  if (!storageSaveSystem(sc)) return false;
  pumpFlowMlPerSec = sc.flowMlPerSecX100 / 100.0f;
  Serial.print("Debit pompa setat: ");
  Serial.print(pumpFlowMlPerSec);
  Serial.println(" ml/s");
  return true;
}

// ---------- RecoveryState (udare intrerupta de pana de curent) ----------

bool storageLoadRecovery(RecoveryState& rs) {
  if (!eepromReady) { memset(&rs, 0, sizeof(rs)); return false; }
  return eepromRead(EEPROM_OFFSET_RECOVERY, (uint8_t*)&rs, sizeof(rs));
}

bool storageSaveRecovery(const RecoveryState& rs) {
  if (!eepromReady) return false;
  i2cBusyDepth++;
  bool ok = eepromWrite(EEPROM_OFFSET_RECOVERY, (const uint8_t*)&rs, sizeof(rs));
  i2cBusyDepth--;
  return ok;
}

// Zeroizeaza slotul de recovery (valid = 0). Apelat la finalul unei udari
// normale, cand userul accepta reluarea, sau cand o refuza.
void storageClearRecovery() {
  RecoveryState rs;
  memset(&rs, 0, sizeof(rs));
  storageSaveRecovery(rs);
  recoveryPending = false;   // sincronizam si starea din RAM
}

// Salveaza progresul udarii curente in EEPROM. Apelata periodic din PHASE_PUMPING.
// `remainingMl` = cati ml mai raman de livrat (deja calculati de apelant).
// Numele plantei se ia din NodeConfig-ul portului (pentru afisare in modal).
void saveWateringProgress(int port, uint16_t remainingMl) {
  if (!eepromReady || port < 0 || port >= NUM_PORTS) return;
  RecoveryState rs;
  memset(&rs, 0, sizeof(rs));
  rs.valid       = 1;
  rs.port        = (uint8_t)port;
  rs.remainingMl = remainingMl;
  rs.timestamp   = rtcOk ? rtcEpoch() : 0;
  // Numele plantei din configul nodului (daca e configurat).
  NodeConfig cfg;
  if (storageLoadConfig(portName[port], cfg) && cfg.configured) {
    strncpy(rs.plantName, cfg.plantName, sizeof(rs.plantName) - 1);
  }
  storageSaveRecovery(rs);
}

// La boot (dupa loadFlowRate): verifica daca a ramas o udare neterminata in
// EEPROM. Daca da, umple variabilele globale recoveryPending* si logheaza —
// udarea NU se reia automat, ci asteapta decizia userului (expusa in /status).
void checkWateringRecovery() {
  recoveryPending = false;
  if (!eepromReady) return;
  RecoveryState rs;
  if (!storageLoadRecovery(rs)) return;
  if (rs.valid != 1) return;
  if (rs.port >= NUM_PORTS) { storageClearRecovery(); return; }
  // Doza restanta trebuie sa fie plauzibila; altfel ignoram slotul.
  if (rs.remainingMl == 0 || rs.remainingMl > DOSE_MAX_ML) { storageClearRecovery(); return; }

  recoveryPending     = true;
  recoveryPendingPort = rs.port;
  recoveryPendingMl   = rs.remainingMl;
  memcpy(recoveryPendingPlant, rs.plantName, sizeof(recoveryPendingPlant));
  recoveryPendingPlant[sizeof(recoveryPendingPlant) - 1] = '\0';

  bootLogf("RECOVERY: udare intrerupta pe P%d, %u ml ramasi (%s)\n",
           rs.port + 1, rs.remainingMl,
           recoveryPendingPlant[0] ? recoveryPendingPlant : "neconfigurat");
}

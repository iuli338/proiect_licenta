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
static_assert(sizeof(EepromHeader) == 32, "EepromHeader trebuie sa fie 32 B");
static_assert(sizeof(NodeConfig)   == NODE_CONFIG_SIZE, "NodeConfig != 96 B");
static_assert(sizeof(RegParams)    == REG_PARAMS_SIZE,  "RegParams != 64 B");
static_assert(sizeof(NodeStats)    == NODE_STATS_SIZE,  "NodeStats != 64 B");

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

// Zeroizează un slot, util la init şi la "şters" un nod.
static bool zeroSlot(uint16_t offset, size_t len) {
  uint8_t zeros[64];
  memset(zeros, 0, sizeof(zeros));
  size_t done = 0;
  while (done < len) {
    size_t chunk = len - done;
    if (chunk > sizeof(zeros)) chunk = sizeof(zeros);
    if (!eepromWrite(offset + done, zeros, chunk)) return false;
    done += chunk;
  }
  return true;
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

  // Zeroize toate slot-urile.
  for (int s = 0; s < NUM_PORTS; s++) {
    if (!zeroSlot(configOffset(s), NODE_CONFIG_SIZE)) return false;
    if (!zeroSlot(paramsOffset(s), REG_PARAMS_SIZE))  return false;
    if (!zeroSlot(statsOffset(s),  NODE_STATS_SIZE))  return false;
  }

  // Scriem header-ul ABIA la final — dacă init-ul cade la mijloc, la
  // pornirea următoare retry-uim de la zero (header-ul lipseşte încă).
  memset(&h, 0, sizeof(h));
  memcpy(h.magic, EEPROM_MAGIC, 8);
  h.version = EEPROM_LAYOUT_VERSION;
  if (!eepromWrite(EEPROM_OFFSET_HEADER, (uint8_t*)&h, sizeof(h))) return false;

  Serial.println("EEPROM layout initializat");
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

// Ştergerea unui nod (resetare completă a slot-ului).
bool storageClearNode(const char* nodeName) {
  int slot = nodeIndex(nodeName);
  if (slot < 0 || !eepromReady) return false;
  if (!zeroSlot(configOffset(slot), NODE_CONFIG_SIZE)) return false;
  if (!zeroSlot(paramsOffset(slot), REG_PARAMS_SIZE))  return false;
  if (!zeroSlot(statsOffset(slot),  NODE_STATS_SIZE))  return false;
  return true;
}

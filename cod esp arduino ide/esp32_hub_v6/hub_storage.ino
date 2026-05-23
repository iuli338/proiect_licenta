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

// ---------- Offset per port ----------

static uint16_t configOffset(int port) {
  switch (port) {
    case 0: return EEPROM_OFFSET_CONFIG_P1;
    case 1: return EEPROM_OFFSET_CONFIG_P2;
    case 2: return EEPROM_OFFSET_CONFIG_P3;
  }
  return 0xFFFF;
}
static uint16_t paramsOffset(int port) {
  switch (port) {
    case 0: return EEPROM_OFFSET_PARAMS_P1;
    case 1: return EEPROM_OFFSET_PARAMS_P2;
    case 2: return EEPROM_OFFSET_PARAMS_P3;
  }
  return 0xFFFF;
}
static uint16_t statsOffset(int port) {
  switch (port) {
    case 0: return EEPROM_OFFSET_STATS_P1;
    case 1: return EEPROM_OFFSET_STATS_P2;
    case 2: return EEPROM_OFFSET_STATS_P3;
  }
  return 0xFFFF;
}

// ---------- Header + init layout ----------

// Citeşte header-ul. Returnează true dacă "DROPv01" + versiunea aşteptată.
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
    Serial.println("EEPROM layout OK (DROPv01)");
    return true;
  }

  Serial.println("EEPROM layout absent — initializez slot-urile");

  // Zeroize toate slot-urile.
  for (int p = 0; p < NUM_PORTS; p++) {
    if (!zeroSlot(configOffset(p), NODE_CONFIG_SIZE)) return false;
    if (!zeroSlot(paramsOffset(p), REG_PARAMS_SIZE))  return false;
    if (!zeroSlot(statsOffset(p),  NODE_STATS_SIZE))  return false;
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

// ---------- NodeConfig ----------

bool storageLoadConfig(int port, NodeConfig& cfg) {
  if (port < 0 || port >= NUM_PORTS || !eepromReady) {
    memset(&cfg, 0, sizeof(cfg));
    return false;
  }
  return eepromRead(configOffset(port), (uint8_t*)&cfg, sizeof(cfg));
}

bool storageSaveConfig(int port, const NodeConfig& cfg) {
  if (port < 0 || port >= NUM_PORTS || !eepromReady) return false;
  return eepromWrite(configOffset(port), (const uint8_t*)&cfg, sizeof(cfg));
}

// ---------- RegParams ----------

bool storageLoadParams(int port, RegParams& p) {
  if (port < 0 || port >= NUM_PORTS || !eepromReady) {
    memset(&p, 0, sizeof(p));
    return false;
  }
  return eepromRead(paramsOffset(port), (uint8_t*)&p, sizeof(p));
}

bool storageSaveParams(int port, const RegParams& p) {
  if (port < 0 || port >= NUM_PORTS || !eepromReady) return false;
  return eepromWrite(paramsOffset(port), (const uint8_t*)&p, sizeof(p));
}

// ---------- NodeStats ----------

bool storageLoadStats(int port, NodeStats& s) {
  if (port < 0 || port >= NUM_PORTS || !eepromReady) {
    memset(&s, 0, sizeof(s));
    return false;
  }
  return eepromRead(statsOffset(port), (uint8_t*)&s, sizeof(s));
}

bool storageSaveStats(int port, const NodeStats& s) {
  if (port < 0 || port >= NUM_PORTS || !eepromReady) return false;
  return eepromWrite(statsOffset(port), (const uint8_t*)&s, sizeof(s));
}

// Ştergerea unui nod (la deconectare fizică sau reconfigurare completă).
bool storageClearNode(int port) {
  if (port < 0 || port >= NUM_PORTS || !eepromReady) return false;
  if (!zeroSlot(configOffset(port), NODE_CONFIG_SIZE)) return false;
  if (!zeroSlot(paramsOffset(port), REG_PARAMS_SIZE))  return false;
  if (!zeroSlot(statsOffset(port),  NODE_STATS_SIZE))  return false;
  return true;
}

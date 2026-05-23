/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   ============================================================

   Driver EEPROM extern AT24C256 (I2C, 32 KB, pe acelaşi bus cu OLED-ul).

   Particularităţi AT24C256:
   - Adresare internă pe 16 biţi (high byte mai întâi).
   - Pagina de scriere: 64 B. Nu poţi face un singur write care depăşeşte
     o graniţă de 64 B — sau, mai exact, se "înfăşoară" în interiorul
     paginii (rezultat: corup pagina). Driver-ul de aici sparge automat.
   - Ciclu intern de scriere ~5 ms. După un write, chip-ul nu acceptă
     comenzi noi. Aşteptăm prin "ACK polling" (ping-uri repetate până
     răspunde) — mai rapid decât un delay fix.
   - La power-up are o perioadă scurtă de t_PU (~10 ms tipic) în care
     uneori nu răspunde — de-aceea ping-uim cu retry la boot.
   ============================================================ */

#include <Wire.h>

// ---------- Adresare ----------

// Setează adresa internă (16-bit big-endian) ca preambul al unei tranzacţii.
// NU termină transmisia — caller-ul continuă cu Write() / requestFrom().
static void eepromBeginAddr(uint16_t addr) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write((uint8_t)(addr >> 8));     // high byte
  Wire.write((uint8_t)(addr & 0xFF));   // low byte
}

// ---------- Ping (verifică prezenţa chip-ului) ----------

bool eepromPing() {
  Wire.beginTransmission(EEPROM_ADDR);
  return Wire.endTransmission() == 0;   // 0 = ACK primit
}

// Aşteaptă ca EEPROM-ul să termine un ciclu intern de scriere — ping cu
// timeout. Întoarce true dacă a răspuns la timp.
static bool eepromWaitReady(unsigned long timeout_ms) {
  unsigned long start = millis();
  while (millis() - start < timeout_ms) {
    if (eepromPing()) return true;
    delay(1);
  }
  return false;
}

// ---------- Diagnoză I2C (folosită doar la debug) ----------
//
// Scanează tot bus-ul I2C (0x03..0x77) şi listează adresele care dau ACK.
// La hub-ul Dropwise ne aşteptăm să vedem cel puţin 0x3C (OLED) şi 0x50
// (EEPROM AT24C256). Orice altceva e străin sau adresa EEPROM-ului diferă.
void i2cScan() {
  bootLogf("Scanare I2C...\n");
  int found = 0;
  bool first = true;
  // Logăm direct adresele într-un singur rând, ca să iasă lizibil în UI.
  for (uint8_t addr = 0x03; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    uint8_t err = Wire.endTransmission();
    if (err == 0) {
      bootLogf("%s0x%02X", first ? "Adrese gasite: " : ", ", addr);
      if (addr == 0x3C) oledOk = true;
      if (addr == RTC_I2C_ADDR) rtcOk = true;
      // (EEPROM-ul îşi setează propriul flag prin eepromInit.)
      first = false;
      found++;
    }
  }
  if (first) bootLogf("Niciun dispozitiv I2C detectat.");
  bootLogf("\n");
}

// ---------- Recuperare bus I2C blocat ----------
//
// Cauză tipică: un slave (EEPROM-ul nostru, sau OLED-ul) a fost întrerupt
// în mijlocul unei tranzacţii şi ţine SDA LOW aşteptând cicluri de ceas
// care nu mai vin. Bus-ul rămâne stuck — niciun slave nu mai răspunde
// (ACK fails / NACK on address — I2C err 2).
//
// Procedura standard de recovery:
//   1. Eliberăm Wire (pinii devin GPIO normali).
//   2. Pulsăm SCL până la 9 ori (un byte + ACK) — forţăm slave-ul să
//      finalizeze tranzacţia pe care o avea în curs şi să elibereze SDA.
//   3. Generăm o secvenţă de STOP manuală (SDA: LOW → HIGH cu SCL HIGH).
//   4. Reactivăm Wire.
void i2cBusRecovery() {
  Serial.println("I2C bus recovery: pulsez SCL...");
  Wire.end();
  delay(5);

  pinMode(21, INPUT_PULLUP);   // SDA
  pinMode(22, OUTPUT);          // SCL
  digitalWrite(22, HIGH);
  delayMicroseconds(10);

  // Până la 9 cicluri de ceas — eliberează SDA dacă un slave îl ţine.
  for (int i = 0; i < 9 && digitalRead(21) == LOW; i++) {
    digitalWrite(22, LOW);  delayMicroseconds(10);
    digitalWrite(22, HIGH); delayMicroseconds(10);
  }

  // STOP manual: SDA LOW → HIGH cu SCL HIGH.
  pinMode(21, OUTPUT);
  digitalWrite(21, LOW);
  delayMicroseconds(10);
  digitalWrite(22, HIGH); delayMicroseconds(10);
  digitalWrite(21, HIGH); delayMicroseconds(10);

  // Reactivăm I2C.
  Wire.begin(21, 22);
  delay(5);
}

// ---------- Iniţializare la boot ----------

// Aştept t_PU şi probez chip-ul cu retry. Setez `eepromReady` global.
bool eepromInit() {
  delay(EEPROM_BOOT_DELAY_MS);

  for (int i = 0; i < EEPROM_PING_RETRIES; i++) {
    if (eepromPing()) {
      eepromReady = true;
      bootLogf("EEPROM AT24C256 detectat la 0x%02X (incercare %d) - OK\n",
               EEPROM_ADDR, i + 1);
      return true;
    }
    bootLogf("EEPROM ping fail, retry %d\n", i + 1);
    delay(EEPROM_PING_GAP_MS);
  }

  eepromReady = false;
  bootLogf("EEPROM NOT FOUND - persistenta dezactivata\n");
  return false;
}

// Reîncearcă să "vadă" EEPROM-ul după ce bus-ul a fost blocat. Apelat
// din retry-ul write/read când primim NACK persistent.
static void eepromTryRecover() {
  i2cBusRecovery();
  // Ping nou — dacă chip-ul răspunde, marcăm înapoi `ready`.
  if (eepromPing()) {
    eepromReady = true;
    Serial.println("EEPROM recovered after bus reset");
  } else {
    eepromReady = false;
    Serial.println("EEPROM still unreachable after bus reset");
  }
}

// ---------- Citire ----------

// Citeşte `len` octeţi de la `addr`. Bus-ul I2C are limită de buffer (32 B
// standard pe AVR, 128 B pe ESP32), aşa că spargem în chunks de 32 B să fim
// portabili. Retry pe NACK — bus-ul e partajat cu OLED-ul.
bool eepromRead(uint16_t addr, uint8_t* buf, size_t len) {
  if (!eepromReady) return false;
  if (addr + len > EEPROM_SIZE_BYTES) return false;

  size_t done = 0;
  while (done < len) {
    size_t chunk = len - done;
    if (chunk > 32) chunk = 32;

    bool ok = false;
    for (int attempt = 0; attempt < 3 && !ok; attempt++) {
      eepromBeginAddr(addr + done);
      if (Wire.endTransmission(false) != 0) {        // restart
        delay(10);
        continue;
      }
      size_t got = Wire.requestFrom((int)EEPROM_ADDR, (int)chunk);
      if (got != chunk) {
        delay(10);
        continue;
      }
      for (size_t i = 0; i < chunk; i++) buf[done + i] = Wire.read();
      ok = true;
    }
    if (!ok) {
      Serial.print("eepromRead failed at 0x");
      Serial.println(addr + done, HEX);
      // Bus probabil blocat — recovery + o ultimă încercare.
      eepromTryRecover();
      if (!eepromReady) return false;
      eepromBeginAddr(addr + done);
      if (Wire.endTransmission(false) != 0) return false;
      size_t got = Wire.requestFrom((int)EEPROM_ADDR, (int)chunk);
      if (got != chunk) return false;
      for (size_t i = 0; i < chunk; i++) buf[done + i] = Wire.read();
    }
    done += chunk;
  }
  return true;
}

// ---------- Scriere ----------
//
// AT24C256 acceptă "page writes": pornind de la o adresă, poţi scrie consecutiv
// până la 64 B într-o singură tranzacţie I2C, dar NU peste graniţa unei pagini
// (adresa de scriere "se înfăşoară" la începutul paginii curente — corupere).
// După fiecare tranzacţie de scriere, chip-ul intră într-un ciclu intern de
// programare (~5 ms tipic, max 10 ms). În acest interval nu acceptă comenzi
// noi: orice tranzacţie nouă trebuie să aştepte.
//
// Strategia driver-ului:
//   - spargem buf-ul la fiecare graniţă de pagină (64 B aliniat);
//   - scriem fiecare bucată într-o singură tranzacţie Wire (chunk max 64 B);
//   - aşteptăm fix EEPROM_WRITE_CYCLE_MS între tranzacţii (10 ms — robust).

// Scrie o singură "porţie" care nu depăşeşte limitele paginii AT24C256.
// Folosit intern de eepromWrite(). Retry pe NACK — bus-ul I2C e partajat cu
// OLED-ul, iar OLED-ul poate ţine bus-ul ocupat exact când vrem să scriem.
// La 3 NACK-uri consecutive declanşăm bus recovery şi mai facem o încercare.
static bool eepromWritePage(uint16_t addr, const uint8_t* buf, size_t len) {
  for (int attempt = 0; attempt < 3; attempt++) {
    eepromBeginAddr(addr);
    Wire.write(buf, len);
    uint8_t err = Wire.endTransmission();
    if (err == 0) {
      // Delay fix — mai sigur decât ACK polling, care uneori prinde un ACK
      // "fantomă" la mijlocul ciclului intern al AT24C şi reuşeşte un write
      // următor pe un chip încă ocupat (rezultat: bytes random).
      delay(EEPROM_WRITE_CYCLE_MS);
      return true;
    }
    Serial.print("eepromWritePage attempt ");
    Serial.print(attempt + 1);
    Serial.print(": I2C err ");
    Serial.print(err);
    Serial.print(" at 0x");
    Serial.println(addr, HEX);
    delay(20);   // pauză înainte de retry
  }

  // Bus probabil blocat — recovery + o ultimă încercare.
  eepromTryRecover();
  if (!eepromReady) return false;
  eepromBeginAddr(addr);
  Wire.write(buf, len);
  if (Wire.endTransmission() == 0) {
    delay(EEPROM_WRITE_CYCLE_MS);
    return true;
  }
  return false;
}

// Scrie `len` octeţi la `addr`. Spargem automat la graniţele paginii de 64 B
// (constrângere hardware AT24C256). În plus, limităm chunk-ul la 16 B —
// page write mai mare pică intermitent pe modulele AT24C cu Wire-ul ESP32
// (probabil buffer Wire incomplet sau timing marginal).
bool eepromWrite(uint16_t addr, const uint8_t* buf, size_t len) {
  if (!eepromReady) return false;
  if (addr + len > EEPROM_SIZE_BYTES) return false;

  const size_t MAX_CHUNK = 1;   // byte-write mode — cel mai sigur

  size_t done = 0;
  while (done < len) {
    uint16_t cur = addr + done;
    // Cât mai e până la sfârşitul paginii curente?
    uint16_t pageEnd = (cur / EEPROM_PAGE_SIZE + 1) * EEPROM_PAGE_SIZE;
    size_t chunk = pageEnd - cur;
    if (chunk > len - done) chunk = len - done;
    if (chunk > MAX_CHUNK) chunk = MAX_CHUNK;

    if (!eepromWritePage(cur, buf + done, chunk)) return false;
    done += chunk;
  }
  return true;
}

// ---------- Self-test rapid (folosit doar manual / debug) ----------
//
// Scrie un pattern la 0x7F00..0x7FFF (zona de la final, neutilizată) şi
// verifică ce s-a scris. NU rulează la fiecare boot — doar la cerere.
void eepromSelfTest() {
  if (!eepromReady) {
    Serial.println("EEPROM self-test: chip absent");
    return;
  }
  const uint16_t base = 0x7F00;
  uint8_t pattern[64];
  for (int i = 0; i < 64; i++) pattern[i] = (uint8_t)(i * 7 + 13);

  if (!eepromWrite(base, pattern, 64)) {
    Serial.println("EEPROM self-test: WRITE failed");
    return;
  }
  uint8_t readback[64];
  if (!eepromRead(base, readback, 64)) {
    Serial.println("EEPROM self-test: READ failed");
    return;
  }
  for (int i = 0; i < 64; i++) {
    if (readback[i] != pattern[i]) {
      Serial.print("EEPROM self-test: mismatch at ");
      Serial.print(i);
      Serial.print(" expected ");
      Serial.print(pattern[i]);
      Serial.print(" got ");
      Serial.println(readback[i]);
      return;
    }
  }
  Serial.println("EEPROM self-test: OK (64 B round-trip)");
}

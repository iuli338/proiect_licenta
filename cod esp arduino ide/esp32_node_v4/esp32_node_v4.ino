/* ============================================================
   Dropwise NODE — firmware ESP32 (v4)

   Nodul-senzor: citeşte 4 valori (umiditate sol, temperatură aer,
   umiditate aer, luminozitate) şi le trimite la hub prin ESP-NOW
   la fiecare 5 secunde. Hub-ul le agregă şi le expune dashboard-ului
   în /status.

   Sensori (toţi opţionali — la pornire fiecare e ping-uit, dacă
   lipseşte va trimite NAN la hub):
     • SHT40   I²C 0x44  — temperatură + umiditate aer
     • BH1750  I²C 0x23  — luminozitate (lux)
     • Sol analog GPIO34 — umiditate sol (% după calibrare)

   Pini:
     • GPIO 21 = SDA (I²C — partajat SHT40/BH1750)
     • GPIO 22 = SCL
     • GPIO 34 = analog umiditate sol (ADC1_CH6)
     • GPIO 26 = power gate pentru senzorul de sol (HIGH = alimentat)
     • GPIO  2 = LED stare (confirmare hub)
   ============================================================ */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Wire.h>
#include <math.h>

// Senzori
#include <BH1750.h>
#include <SensirionI2cSht4x.h>

// Schimba aici pentru fiecare nod ("P1", "P2", "P3")
#define NODE_NAME "P1"

#define LED_PIN          2
#define SOIL_POWER_PIN   26
#define SOIL_MOISTURE_PIN 34

// Calibrare ADC sol — valori măsurate cu senzorul nostru rezistiv pe 10
// zile de experiment cu 2 udări controlate (vezi misc/soil_data_complete.csv).
// ADC-ul scade când substratul se udă (rezistiv: umiditate ↑ → rezistenţă ↓).
//   • DRY = 4050  — sol complet uscat în ghiveci, înainte de udare
//                   (observat: 4048-4072 stabil pe idx 440-490)
//   • WET = 2270  — saturaţie maximă imediat după udare
//                   (observat: vârf raw=2268 pe idx 1069)
// Dacă schimbi senzorul, log-ul raw din readSoilMoisturePct() îţi spune
// noile valori — măsoară în aer şi în apă/sol saturat şi actualizează aici.
#define SOIL_ADC_DRY   4050   // sol uscat
#define SOIL_ADC_WET   2270   // sol saturat
#define SOIL_POWER_ON_DELAY_MS 100  // aştept stabilizarea citirii după power-on

// Cât de des citim senzorii (ms).
#define SENSOR_READ_INTERVAL_MS  5000

// SSID-ul hotspot-ului la care e conectat hub-ul -
// nodul nu se conecteaza, doar scaneaza ca sa afle pe ce canal e
const char* hubSsid = "Galaxy S20 0782";

// Mesaj HELLO/ACK — păstrat compatibil cu firmware-ul vechi.
typedef struct {
  char msgType[8];
  char nodeName[8];
  char message[24];
} EspNowMessage;

// Mesaj cu citiri senzori — trimis periodic. NAN denotă senzor absent
// (hub-ul îl serializează ca `null` în JSON). Câmpul `reserved` ţine
// dimensiunea fixă la 40 B după scoaterea senzorului DS18B20.
typedef struct __attribute__((packed)) {
  char     msgType[8];      // "SENSE"
  char     nodeName[8];     // "P1"/"P2"/"P3"
  float    soilMoisturePct; // 0..100
  float    reserved;        // ex-soilTempC (DS18B20 eliminat)
  float    airTempC;
  float    airHumidityPct;
  float    lux;
  uint32_t uptimeMs;        // debug
} SensorMessage;             // 40 B

uint8_t hubMac[] = {
  0x44, 0x1D, 0x64, 0xE4, 0x41, 0xA0
};

volatile bool confirmed = false;
uint8_t wifiChannel = 1;

unsigned long lastHello = 0;
unsigned long lastBlink = 0;
unsigned long lastChannelCheck = 0;
unsigned long lastSensorRead = 0;
bool ledState = false;

// ---------- Drivere senzori ----------

BH1750 bh1750;
SensirionI2cSht4x sht40;

// Disponibilitate detectată la boot — recheck la fiecare citire NU se face
// (probele iniţiale sunt suficiente; dacă un senzor cade pe parcurs vom
// trimite NAN pentru el oricum, fiindcă apelul lui va eşua).
bool hasSht40   = false;
bool hasBh1750  = false;
bool hasSoil    = true;   // ADC e mereu disponibil pe ESP32

// ---------- Init senzori ----------

bool initSht40() {
  sht40.begin(Wire, SHT40_I2C_ADDR_44);
  // Soft reset — confirmă comunicarea.
  if (sht40.softReset() != 0) {
    Serial.println("SHT40: lipsa (soft reset esuat)");
    return false;
  }
  delay(10);
  Serial.println("SHT40: OK");
  return true;
}

bool initBh1750() {
  // begin() face deja un Wire ping; întoarce false dacă nu răspunde.
  if (!bh1750.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23)) {
    Serial.println("BH1750: lipsa");
    return false;
  }
  Serial.println("BH1750: OK");
  return true;
}

void initSoilSensor() {
  pinMode(SOIL_POWER_PIN, OUTPUT);
  digitalWrite(SOIL_POWER_PIN, LOW);
  pinMode(SOIL_MOISTURE_PIN, INPUT);
  // ADC implicit 12 biţi, atenuare 11 dB ca să măsurăm până la ~3.1 V.
  analogReadResolution(12);
  analogSetPinAttenuation(SOIL_MOISTURE_PIN, ADC_11db);
  Serial.println("Sol analog: OK");
}

// ---------- Citiri ----------

float readSoilMoisturePct() {
  // Alimentează senzorul (anti-coroziune: pornit doar pe durata citirii).
  digitalWrite(SOIL_POWER_PIN, HIGH);
  delay(SOIL_POWER_ON_DELAY_MS);   // 100 ms — stabilizare modul + ADC
  // Mediem 10 sample-uri cu pauză 10 ms între ele — total ~100 ms de
  // eşantionare. Cifrele = aceleaşi ca în firmware-ul de referinţă.
  uint32_t sum = 0;
  for (int i = 0; i < 10; i++) {
    sum += analogRead(SOIL_MOISTURE_PIN);
    delay(10);
  }
  digitalWrite(SOIL_POWER_PIN, LOW);
  int raw = sum / 10;
  // Liniarizare DRY..WET → 0..100 %. Clamp la capete.
  float pct = 100.0f * (float)(SOIL_ADC_DRY - raw) /
              (float)(SOIL_ADC_DRY - SOIL_ADC_WET);
  if (pct < 0)   pct = 0;
  if (pct > 100) pct = 100;
  // Log calibrare — vezi valoarea raw în aer şi în apă, actualizezi
  // SOIL_ADC_DRY / SOIL_ADC_WET în funcţie de cifrele tale.
  Serial.print("Sol raw="); Serial.print(raw);
  Serial.print(" -> "); Serial.print(pct, 1); Serial.println("%");
  return pct;
}

bool readSht40(float& airTempC, float& airHumidityPct) {
  if (!hasSht40) { airTempC = NAN; airHumidityPct = NAN; return false; }
  float t = NAN, rh = NAN;
  // Măsurare cu precizie înaltă, blocant ~10 ms.
  int err = sht40.measureHighPrecision(t, rh);
  if (err != 0) {
    Serial.print("SHT40 read err="); Serial.println(err);
    airTempC = NAN; airHumidityPct = NAN;
    return false;
  }
  airTempC = t;
  airHumidityPct = rh;
  return true;
}

float readLux() {
  if (!hasBh1750) return NAN;
  // Aşteaptă noua măsurătoare (CONTINUOUS_HIGH_RES_MODE = 120 ms tipic).
  // Dacă rulăm la 5s avem oricum timp suficient — nu blocăm explicit.
  if (!bh1750.measurementReady(false)) return NAN;
  float lx = bh1750.readLightLevel();
  if (lx < 0) return NAN;
  return lx;
}

// ---------- ESP-NOW ----------

uint8_t findHubChannel() {

  Serial.print("Scanning for SSID: ");
  Serial.println(hubSsid);

  int n = WiFi.scanNetworks();

  for (int i = 0; i < n; i++) {

    if (WiFi.SSID(i) == hubSsid) {

      uint8_t ch = WiFi.channel(i);

      Serial.print("Found hub network on channel ");
      Serial.println(ch);

      WiFi.scanDelete();
      return ch;
    }
  }

  WiFi.scanDelete();
  Serial.println("Hub SSID not found, defaulting to ch 1");
  return 1;
}

void setupPeer() {

  // Sterge peer existent daca e
  if (esp_now_is_peer_exist(hubMac)) {
    esp_now_del_peer(hubMac);
  }

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, hubMac, 6);
  peerInfo.channel = wifiChannel;
  peerInfo.encrypt = false;
  peerInfo.ifidx = WIFI_IF_STA;

  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("Failed to add peer");
  } else {
    Serial.print("Peer added on channel ");
    Serial.println(wifiChannel);
  }
}

void sendHello() {

  EspNowMessage msg;
  strcpy(msg.msgType,  "HELLO");
  strcpy(msg.nodeName, NODE_NAME);
  strcpy(msg.message,  "connected");

  esp_err_t res = esp_now_send(
    hubMac,
    (uint8_t*)&msg,
    sizeof(msg)
  );

  Serial.print("HELLO sent as ");
  Serial.print(NODE_NAME);
  Serial.print(" on ch ");
  Serial.print(wifiChannel);
  Serial.print(" -> ");
  Serial.println(res == ESP_OK ? "OK" : "FAIL");
}

void sendSensorReadings() {

  SensorMessage msg;
  memset(&msg, 0, sizeof(msg));
  strcpy(msg.msgType,  "SENSE");
  strcpy(msg.nodeName, NODE_NAME);

  msg.soilMoisturePct = hasSoil ? readSoilMoisturePct() : NAN;
  msg.reserved        = NAN;       // ex-soilTempC (DS18B20 eliminat)

  float airT = NAN, airH = NAN;
  readSht40(airT, airH);
  msg.airTempC       = airT;
  msg.airHumidityPct = airH;

  msg.lux      = hasBh1750 ? readLux() : NAN;
  msg.uptimeMs = millis();

  esp_err_t res = esp_now_send(
    hubMac,
    (uint8_t*)&msg,
    sizeof(msg)
  );

  Serial.print("SENSE sent | sol=");
  Serial.print(isnan(msg.soilMoisturePct) ? -1 : msg.soilMoisturePct);
  Serial.print("% aerT=");
  Serial.print(isnan(msg.airTempC) ? -1 : msg.airTempC);
  Serial.print("C aerH=");
  Serial.print(isnan(msg.airHumidityPct) ? -1 : msg.airHumidityPct);
  Serial.print("% lux=");
  Serial.print(isnan(msg.lux) ? -1 : msg.lux);
  Serial.print(" -> ");
  Serial.println(res == ESP_OK ? "OK" : "FAIL");
}

void onDataSent(
  const uint8_t *mac_addr,
  esp_now_send_status_t status
) {
  // Logăm doar eşecurile — la 5 s/cycle, "OK" la fiecare ar inunda Serial.
  if (status != ESP_NOW_SEND_SUCCESS) {
    Serial.println("Send status: FAIL");
  }
}

void onDataRecv(
  const uint8_t *mac,
  const uint8_t *incomingData,
  int len
) {

  if (len != sizeof(EspNowMessage)) return;

  EspNowMessage msg;
  memcpy(&msg, incomingData, sizeof(msg));

  Serial.print("RX from hub | type: ");
  Serial.print(msg.msgType);
  Serial.print(" | for: ");
  Serial.print(msg.nodeName);
  Serial.print(" | msg: ");
  Serial.println(msg.message);

  if (
    strcmp(msg.msgType, "ACK") == 0 &&
    strcmp(msg.nodeName, NODE_NAME) == 0
  ) {
    confirmed = true;
    digitalWrite(LED_PIN, HIGH);
    Serial.println(">>> CONFIRMED by hub <<<");
  }
}

void setup() {

  Serial.begin(115200);
  delay(500);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.print("Node ");
  Serial.print(NODE_NAME);
  Serial.println(" starting...");

  // I²C — partajat de SHT40 (0x44) şi BH1750 (0x23).
  Wire.begin(21, 22);
  Wire.setClock(100000);

  // Aşteaptă stabilizarea modulelor după power-on. SHT40 are t_PU până la
  // ~1 ms, BH1750 ~10 ms după Power-On, dar pe breadboard cu fire lungi şi
  // capacitate parazită e mai sigur să dăm 200 ms tuturor înainte de scan.
  delay(200);

  // Iniţializare senzori. Fiecare driver e best-effort: dacă lipseşte,
  // marcăm flag-ul ca false şi vom trimite NAN.
  hasSht40   = initSht40();
  hasBh1750  = initBh1750();
  initSoilSensor();

  Serial.print("Sensori OK: ");
  if (hasSht40)   Serial.print("SHT40 ");
  if (hasBh1750)  Serial.print("BH1750 ");
  if (hasSoil)    Serial.print("SOL ");
  Serial.println();

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);

  // Gaseste canalul hub-ului prin scan
  wifiChannel = findHubChannel();

  // Forteaza acest canal
  esp_wifi_set_channel(wifiChannel, WIFI_SECOND_CHAN_NONE);

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW INIT FAILED");
    return;
  }

  esp_now_register_send_cb(onDataSent);
  esp_now_register_recv_cb(onDataRecv);

  setupPeer();

  Serial.println("Setup done, waiting for hub confirmation...");
}

void loop() {

  unsigned long now = millis();

  if (!confirmed) {

    // Blink LED: 1 sec ON, 1 sec OFF
    if (now - lastBlink >= 1000) {
      lastBlink = now;
      ledState = !ledState;
      digitalWrite(LED_PIN, ledState ? HIGH : LOW);
    }

    // Trimite HELLO la fiecare 1 sec
    if (now - lastHello >= 1000) {
      lastHello = now;
      sendHello();
    }

    // La fiecare 15 sec rescaneaza canalul - hotspot-ul Samsung
    // poate schimba canalul cand alti clienti se conecteaza/deconecteaza
    if (now - lastChannelCheck >= 15000) {
      lastChannelCheck = now;
      uint8_t newCh = findHubChannel();
      if (newCh != wifiChannel) {
        Serial.print("Channel changed: ");
        Serial.print(wifiChannel);
        Serial.print(" -> ");
        Serial.println(newCh);
        wifiChannel = newCh;
        esp_wifi_set_channel(wifiChannel, WIFI_SECOND_CHAN_NONE);
        setupPeer();
      }
    }

  } else {

    digitalWrite(LED_PIN, HIGH);

    // HELLO la 10 s — heartbeat ca hub-ul să ştie că nodul e online.
    if (now - lastHello >= 10000) {
      lastHello = now;
      sendHello();
    }

    // Citire şi trimitere senzori la fiecare SENSOR_READ_INTERVAL_MS.
    if (now - lastSensorRead >= SENSOR_READ_INTERVAL_MS) {
      lastSensorRead = now;
      sendSensorReadings();
    }
  }
}

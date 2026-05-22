/* ============================================================
   Dropwise HUB — firmware ESP32
   ============================================================

   Doua moduri de functionare, alese automat la pornire dupa
   existenta credentialelor WiFi in NVS (flash intern):

   1. MOD PROVISIONING (initial — fara credentiale salvate)
      - porneste un server GATT BLE numit "Dropwise HUB"
      - LED-ul intern (GPIO 2) palpaie continuu
      - asteapta sa primeasca SSID + parola de la dashboard
      - testeaza conexiunea WiFi, raporteaza rezultatul prin
        BLE notify, salveaza credentialele si face reboot

   2. MOD NORMAL (dupa provisioning — credentiale prezente)
      - se conecteaza la WiFi cu credentialele din NVS
      - ESP-NOW + server HTTP + OLED + udare (logica originala)
      - BLE este complet oprit

   Reset provisioning: tine apasat butonul BOOT (GPIO 0) ~3s la
   pornire => se sterg credentialele si hub-ul revine in
   modul provisioning.

   Contractul BLE (trebuie sa coincida cu ble_provisioning.py):
     Service UUID  : 8e7c0001-9b1a-4f3e-a2d4-0c1b2a3d4e5f
     Char WRITE    : 8e7c0002-...  -> primeste "SSID\nPAROLA"
     Char NOTIFY   : 8e7c0003-...  -> trimite "OK <ip>" / "FAIL <motiv>"
   ============================================================ */

#include <WiFi.h>
#include <WebServer.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Preferences.h>

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define OLED_ADDR 0x3C

// GPIO 16 = pompa
// GPIO 17, 18, 19 = valve port 1, 2, 3
#define PIN_PUMP   16
#define PIN_VALVE1 17
#define PIN_VALVE2 18
#define PIN_VALVE3 19

#define CON1_DETECT_OUT 25
#define CON1_DETECT_IN  26
#define CON2_DETECT_OUT 23
#define CON2_DETECT_IN  27
#define CON3_DETECT_OUT 32
#define CON3_DETECT_IN  33

#define NUM_PORTS 3
#define NAME_LEN  8

// Timing
#define VALVE_OPEN_DELAY  2000  // ms intre deschidere valva si pornire pompa
#define PUMP_STOP_DELAY   1000  // ms intre oprire pompa si inchidere valva

// ---------- Provisioning: pini + constante ----------

#define PIN_STATUS_LED  2   // LED-ul intern al placutei ESP32 DevKit
#define PIN_BOOT_BTN    0   // butonul BOOT — folosit pentru reset provisioning

#define LED_BLINK_MS    250 // viteza de palpaire a LED-ului in mod provisioning
#define RESET_HOLD_MS   3000 // cat trebuie tinut BOOT apasat pt. reset

// UUID-urile GATT — IDENTICE cu cele din ble_provisioning.py
#define BLE_SERVICE_UUID      "8e7c0001-9b1a-4f3e-a2d4-0c1b2a3d4e5f"
#define BLE_CHAR_CREDS_UUID   "8e7c0002-9b1a-4f3e-a2d4-0c1b2a3d4e5f"
#define BLE_CHAR_STATUS_UUID  "8e7c0003-9b1a-4f3e-a2d4-0c1b2a3d4e5f"

#define BLE_DEVICE_NAME       "Dropwise HUB"

// Cat asteptam conectarea la WiFi cand testam credentialele primite.
#define WIFI_PROV_TIMEOUT_MS  20000

// Cheile sub care salvam credentialele in NVS.
#define NVS_NAMESPACE  "dropwise"
#define NVS_KEY_SSID   "wifi_ssid"
#define NVS_KEY_PASS   "wifi_pass"

// ---------- Autentificare (cod de acces) ----------
//
// Codul de acces al hub-ului. Este FIX, definit aici si imprimat pe cutie.
// La conectarea din dashboard, utilizatorul introduce acest cod; hub-ul
// confirma daca e corect, iar serverul il retine in sesiunea utilizatorului.
#define HUB_ACCESS_CODE  "284095"

// ---------- Stare globala ----------

// Modul curent de functionare. Decis in setup().
enum DeviceMode { MODE_PROVISIONING, MODE_NORMAL };
DeviceMode deviceMode = MODE_PROVISIONING;

// Credentialele WiFi active (incarcate din NVS in mod normal).
String wifiSsid = "";
String wifiPass = "";

Preferences prefs;

Adafruit_SSD1306 display(
  SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET
);

WebServer server(80);

bool portPhysical[NUM_PORTS]  = { false, false, false };
bool portConfirmed[NUM_PORTS] = { false, false, false };
char portName[NUM_PORTS][NAME_LEN] = { "", "", "" };
uint8_t portNodeMac[NUM_PORTS][6] = {{0},{0},{0}};

int portDetectIn[NUM_PORTS] = {
  CON1_DETECT_IN, CON2_DETECT_IN, CON3_DETECT_IN
};
int portDetectOut[NUM_PORTS] = {
  CON1_DETECT_OUT, CON2_DETECT_OUT, CON3_DETECT_OUT
};
int valvePin[NUM_PORTS] = {
  PIN_VALVE1, PIN_VALVE2, PIN_VALVE3
};

// Hardware state
bool pumpOn = false;
bool valveOn[NUM_PORTS] = { false, false, false };

// Watering state machine
// -1 = idle, 0..2 = port currently being watered
int wateringPort = -1;

enum WateringPhase {
  PHASE_IDLE,
  PHASE_VALVE_OPENING,
  PHASE_PUMPING,
  PHASE_PUMP_STOPPING
};

WateringPhase wateringPhase = PHASE_IDLE;
unsigned long phaseStartTime = 0;

uint8_t currentWifiChannel = 1;

bool blinkState = false;
unsigned long lastBlink = 0;
unsigned long lastStatusLog = 0;

typedef struct {
  char msgType[8];
  char nodeName[NAME_LEN];
  char message[24];
} EspNowMessage;

// ---------- Stare provisioning (BLE) ----------

BLEServer*         bleServer       = nullptr;
BLECharacteristic* statusChar      = nullptr;  // caracteristica NOTIFY
volatile bool      bleClientConn   = false;
volatile bool      credsReceived   = false;    // setat de callback-ul BLE
String             pendingSsid     = "";
String             pendingPass     = "";
unsigned long      lastLedBlink    = 0;

void sendCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
}

// ============================================================
//  NVS — persistenta credentialelor WiFi
// ============================================================

// Citeste credentialele salvate. Returneaza true daca exista un SSID.
bool loadCredentials() {
  prefs.begin(NVS_NAMESPACE, true);   // true = read-only
  wifiSsid = prefs.getString(NVS_KEY_SSID, "");
  wifiPass = prefs.getString(NVS_KEY_PASS, "");
  prefs.end();
  return wifiSsid.length() > 0;
}

// Salveaza credentialele in NVS.
void saveCredentials(const String& ssid, const String& pass) {
  prefs.begin(NVS_NAMESPACE, false);  // false = read-write
  prefs.putString(NVS_KEY_SSID, ssid);
  prefs.putString(NVS_KEY_PASS, pass);
  prefs.end();
  Serial.println("Credentials saved to NVS");
}

// Sterge credentialele — readuce hub-ul in modul provisioning.
void clearCredentials() {
  prefs.begin(NVS_NAMESPACE, false);
  prefs.remove(NVS_KEY_SSID);
  prefs.remove(NVS_KEY_PASS);
  prefs.end();
  Serial.println("Credentials cleared from NVS");
}

// ============================================================
//  Display
// ============================================================

void drawCircles() {

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  display.println(WiFi.localIP());

  display.setCursor(0, 12);
  display.print("HUB ch:");
  display.print(currentWifiChannel);
  if (wateringPort >= 0) {
    display.print(" W:");
    display.print(portName[wateringPort]);
  }
  display.println();

  int y = 46;
  int cx[3] = { 24, 64, 104 };

  for (int i = 0; i < 3; i++) {
    int x = cx[i];
    display.drawCircle(x, y, 10, SSD1306_WHITE);
    if (i >= NUM_PORTS) continue;

    bool confirmed = portConfirmed[i];
    bool physical  = portPhysical[i];

    if (confirmed) {
      display.fillCircle(x, y, 10, SSD1306_WHITE);
      const char* name = portName[i];
      int len = strlen(name);
      if (len > 0) {
        int textW = len * 6 - 1;
        int textX = x - textW / 2;
        int textY = y - 3;
        display.setTextColor(SSD1306_BLACK);
        display.setCursor(textX, textY);
        display.print(name);
        display.setTextColor(SSD1306_WHITE);
      }
    } else if (physical && blinkState) {
      display.fillCircle(x, y, 10, SSD1306_WHITE);
    }

    // Iconita picatura deasupra cercului daca portul se uda
    if (wateringPort == i && blinkState) {
      // Picatura: triunghi cu varf in sus, baza rotunjita
      int dx = x;
      int dy = 28;
      display.drawLine(dx, dy - 5, dx - 3, dy,     SSD1306_WHITE);
      display.drawLine(dx, dy - 5, dx + 3, dy,     SSD1306_WHITE);
      display.drawLine(dx - 3, dy, dx - 3, dy + 2, SSD1306_WHITE);
      display.drawLine(dx + 3, dy, dx + 3, dy + 2, SSD1306_WHITE);
      display.drawPixel(dx - 2, dy + 3, SSD1306_WHITE);
      display.drawPixel(dx - 1, dy + 4, SSD1306_WHITE);
      display.drawPixel(dx,     dy + 4, SSD1306_WHITE);
      display.drawPixel(dx + 1, dy + 4, SSD1306_WHITE);
      display.drawPixel(dx + 2, dy + 3, SSD1306_WHITE);
    }
  }

  display.display();
}

// Ecran dedicat modului provisioning.
void drawProvisioningScreen(const char* statusLine) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("Dropwise HUB");
  display.drawLine(0, 10, SCREEN_WIDTH, 10, SSD1306_WHITE);

  display.setCursor(0, 18);
  display.println("Mod configurare");
  display.setCursor(0, 30);
  display.println("Conecteaza-te din");
  display.setCursor(0, 40);
  display.println("dashboard prin BLE");

  display.setCursor(0, 54);
  display.print("> ");
  display.print(statusLine);

  display.display();
}

// ============================================================
//  Connector detection
// ============================================================

void updateConnectorDetection() {

  for (int i = 0; i < NUM_PORTS; i++) {
    bool nowPhysical = (digitalRead(portDetectIn[i]) == HIGH);

    if (portPhysical[i] && !nowPhysical) {
      Serial.print("Port ");
      Serial.print(i + 1);
      Serial.println(" disconnected");

      // Daca portul deconectat era cel udat, opreste de urgenta
      if (wateringPort == i) {
        Serial.println("Emergency stop - port disconnected during watering");
        digitalWrite(PIN_PUMP, LOW);
        pumpOn = false;
        digitalWrite(valvePin[i], LOW);
        valveOn[i] = false;
        wateringPort = -1;
        wateringPhase = PHASE_IDLE;
      }

      portConfirmed[i] = false;
      portName[i][0] = '\0';
      memset(portNodeMac[i], 0, 6);
    }

    portPhysical[i] = nowPhysical;
  }
}

int findPortForName(const char* name) {
  for (int i = 0; i < NUM_PORTS; i++) {
    if (strcmp(portName[i], name) == 0) return i;
  }
  return -1;
}

int findFreePhysicalPort() {
  for (int i = 0; i < NUM_PORTS; i++) {
    if (portPhysical[i] && !portConfirmed[i]) return i;
  }
  return -1;
}

// ============================================================
//  ESP-NOW
// ============================================================

void sendAck(const uint8_t* mac, const char* nodeName) {

  if (!esp_now_is_peer_exist(mac)) {
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, mac, 6);
    peerInfo.channel = currentWifiChannel;
    peerInfo.encrypt = false;
    peerInfo.ifidx = WIFI_IF_STA;
    esp_now_add_peer(&peerInfo);
  }

  EspNowMessage ack;
  strcpy(ack.msgType, "ACK");
  strncpy(ack.nodeName, nodeName, NAME_LEN - 1);
  ack.nodeName[NAME_LEN - 1] = '\0';
  strcpy(ack.message, "registered");

  esp_err_t res = esp_now_send(mac, (uint8_t*)&ack, sizeof(ack));

  Serial.print("ACK sent to ");
  Serial.print(nodeName);
  Serial.print(" -> ");
  Serial.println(res == ESP_OK ? "OK" : "FAIL");
}

void onDataRecv(const uint8_t *mac, const uint8_t *incomingData, int len) {

  if (len != sizeof(EspNowMessage)) return;

  EspNowMessage msg;
  memcpy(&msg, incomingData, sizeof(msg));

  Serial.print("ESP-NOW from ");
  Serial.print(msg.nodeName);
  Serial.print(" | type: ");
  Serial.println(msg.msgType);

  if (strcmp(msg.msgType, "HELLO") == 0) {

    int existing = findPortForName(msg.nodeName);
    if (existing >= 0) {
      sendAck(mac, msg.nodeName);
      return;
    }

    int port = findFreePhysicalPort();
    if (port < 0) return;

    strncpy(portName[port], msg.nodeName, NAME_LEN - 1);
    portName[port][NAME_LEN - 1] = '\0';
    memcpy(portNodeMac[port], mac, 6);
    portConfirmed[port] = true;

    Serial.print("Node ");
    Serial.print(msg.nodeName);
    Serial.print(" on port ");
    Serial.println(port + 1);

    sendAck(mac, msg.nodeName);
    drawCircles();
  }
}

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
        // Inchide valva
        if (wateringPort >= 0) {
          digitalWrite(valvePin[wateringPort], LOW);
          valveOn[wateringPort] = false;
        }
        wateringPort = -1;
        wateringPhase = PHASE_IDLE;
        Serial.println("Watering stopped completely");
      }
      break;

    default:
      break;
  }
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
  json += "}";

  sendCorsHeaders();
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

// ---------- Autentificare prin cod de acces ----------
//
// Fiecare endpoint care poate cauza daune (status, toggle, water) verifica
// codul de acces, primit in header-ul HTTP "X-Access-Code". Fara cod corect
// hub-ul raspunde 404 — controlul nu e posibil pana nu te uiti pe cutie.

// Verifica codul de acces din header. La cod lipsa/gresit trimite 404 si
// returneaza false (handler-ul apelant trebuie sa se opreasca imediat).
bool checkAccessCode() {
  String code = server.hasHeader("X-Access-Code")
                  ? server.header("X-Access-Code") : "";
  if (code == HUB_ACCESS_CODE) {
    return true;
  }
  sendCorsHeaders();
  server.send(404, "application/json", "{\"error\":\"not found\"}");
  return false;
}

// POST /auth  body: {"code":"..."}  — verificarea initiala a codului,
// apelata din dialogul de conectare al dashboard-ului.
void handleAuth() {
  sendCorsHeaders();

  String body = server.hasArg("plain") ? server.arg("plain") : "";
  // Extragem valoarea campului "code" din JSON-ul simplu primit.
  String code = "";
  int k = body.indexOf("\"code\"");
  if (k >= 0) {
    int c = body.indexOf(':', k);
    int q1 = body.indexOf('"', c + 1);
    int q2 = body.indexOf('"', q1 + 1);
    if (q1 >= 0 && q2 > q1) code = body.substring(q1 + 1, q2);
  }

  if (code == HUB_ACCESS_CODE) {
    server.send(200, "application/json", "{\"ok\":true}");
  } else {
    server.send(401, "application/json",
      "{\"ok\":false,\"error\":\"cod gresit\"}");
  }
}

// ============================================================
//  MOD PROVISIONING — BLE
// ============================================================

// Incearca sa se conecteze la WiFi cu credentialele primite.
// Returneaza true la succes; populeaza outIp cu adresa IP.
bool tryWifiConnect(const String& ssid, const String& pass, String& outIp) {

  Serial.print("Testing WiFi credentials for SSID: ");
  Serial.println(ssid);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED &&
         millis() - start < WIFI_PROV_TIMEOUT_MS) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    outIp = WiFi.localIP().toString();
    Serial.print("WiFi OK, IP: ");
    Serial.println(outIp);
    return true;
  }

  Serial.println("WiFi connection failed");
  WiFi.disconnect(true);
  return false;
}

// Trimite un mesaj de status catre dashboard prin caracteristica NOTIFY.
void bleSendStatus(const String& text) {
  if (statusChar == nullptr) return;
  statusChar->setValue(text.c_str());
  statusChar->notify();
  Serial.print("BLE notify -> ");
  Serial.println(text);
}

// Callback pentru conectarea/deconectarea unui client BLE.
class HubServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override {
    bleClientConn = true;
    Serial.println("BLE client connected");
  }
  void onDisconnect(BLEServer* s) override {
    bleClientConn = false;
    Serial.println("BLE client disconnected");
    // Reluam advertising-ul ca sa poata reveni un client.
    BLEDevice::startAdvertising();
  }
};

// Callback pentru scrierea credentialelor in caracteristica WRITE.
class CredsWriteCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    // getValue() returneaza Arduino String pe core-ul ESP32 3.x si
    // std::string pe 2.x. String(...) accepta ambele => cod portabil.
    String raw = String(ch->getValue().c_str());
    if (raw.length() == 0) return;

    // Format primit: "SSID\nPAROLA"
    int nl = raw.indexOf('\n');
    if (nl < 0) {
      Serial.println("BLE creds: format invalid (lipseste \\n)");
      bleSendStatus("FAIL format invalid");
      return;
    }

    pendingSsid = raw.substring(0, nl);
    pendingPass = raw.substring(nl + 1);
    credsReceived = true;   // procesate in loop, nu in callback

    Serial.print("BLE creds received, SSID: ");
    Serial.println(pendingSsid);
  }
};

// Initializeaza serverul BLE GATT pentru provisioning.
void startBleProvisioning() {

  Serial.println("Starting BLE provisioning server...");

  BLEDevice::init(BLE_DEVICE_NAME);
  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new HubServerCallbacks());

  BLEService* service = bleServer->createService(BLE_SERVICE_UUID);

  // Caracteristica WRITE — dashboard-ul scrie aici credentialele.
  BLECharacteristic* credsChar = service->createCharacteristic(
    BLE_CHAR_CREDS_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  credsChar->setCallbacks(new CredsWriteCallbacks());

  // Caracteristica NOTIFY — hub-ul trimite aici rezultatul.
  statusChar = service->createCharacteristic(
    BLE_CHAR_STATUS_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  statusChar->addDescriptor(new BLE2902());

  service->start();

  // Advertising — include UUID-ul serviciului pentru ca dashboard-ul
  // sa poata identifica hub-ul.
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.print("BLE advertising as: ");
  Serial.println(BLE_DEVICE_NAME);
}

// Procesarea credentialelor primite (apelata din loop, nu din callback).
void processPendingCredentials() {

  credsReceived = false;
  bleSendStatus("Se incearca conectarea la WiFi...");
  drawProvisioningScreen("Conectare WiFi...");

  String ip;
  bool ok = tryWifiConnect(pendingSsid, pendingPass, ip);

  if (ok) {
    // Salvam credentialele si confirmam clientului.
    saveCredentials(pendingSsid, pendingPass);
    bleSendStatus("OK " + ip);
    drawProvisioningScreen("Conectat! Repornire");
    Serial.println("Provisioning complete, rebooting into normal mode");
    delay(1500);   // lasam timp notificarii BLE sa ajunga
    ESP.restart();
  } else {
    // Esec — raportam si ramanem in provisioning pentru o noua incercare.
    bleSendStatus("FAIL parola WiFi gresita sau retea indisponibila");
    drawProvisioningScreen("Esec - reincearca");
    pendingSsid = "";
    pendingPass = "";
  }
}

// Bucla modului provisioning — palpaie LED-ul si asteapta date.
void loopProvisioning() {

  // Palpaire LED intern.
  if (millis() - lastLedBlink > LED_BLINK_MS) {
    lastLedBlink = millis();
    blinkState = !blinkState;
    digitalWrite(PIN_STATUS_LED, blinkState ? HIGH : LOW);
  }

  // Daca au sosit credentiale, le procesam.
  if (credsReceived) {
    processPendingCredentials();
  }
}

// ============================================================
//  MOD NORMAL — initializare WiFi + ESP-NOW + HTTP
// ============================================================

void startNormalMode() {

  Serial.println("Starting NORMAL mode");

  WiFi.mode(WIFI_AP_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());

  unsigned long wifiStart = millis();
  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - wifiStart < 10000
  ) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi connected");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());

    uint8_t primary;
    wifi_second_chan_t second;
    esp_wifi_get_channel(&primary, &second);
    currentWifiChannel = primary;
    Serial.print("WiFi channel: ");
    Serial.println(currentWifiChannel);
  } else {
    Serial.println("WiFi timeout - forcing channel 1");
    currentWifiChannel = 1;
    esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  }

  Serial.print("MAC: ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed");
    return;
  }
  esp_now_register_recv_cb(onDataRecv);

  // Cerem serverului sa retina header-ul cu codul de acces — implicit
  // WebServer-ul nu pastreaza header-ele personalizate.
  const char* trackedHeaders[] = { "X-Access-Code" };
  server.collectHeaders(trackedHeaders, 1);

  // Rute HTTP
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/status", HTTP_OPTIONS, handleOptions);

  // Reset provisioning de la distanta (din tab-ul Setari al dashboard-ului)
  server.on("/reset", HTTP_POST,    handleResetProvisioning);
  server.on("/reset", HTTP_GET,     handleResetProvisioning);
  server.on("/reset", HTTP_OPTIONS, handleOptions);

  // Autentificare — verificarea initiala a codului de acces.
  server.on("/auth", HTTP_POST,    handleAuth);
  server.on("/auth", HTTP_OPTIONS, handleOptions);

  // Toggle individual pe pini (din tab-ul Control)
  server.on("/toggle/16", HTTP_GET, handleToggle16);
  server.on("/toggle/17", HTTP_GET, handleToggle17);
  server.on("/toggle/18", HTTP_GET, handleToggle18);
  server.on("/toggle/19", HTTP_GET, handleToggle19);
  server.on("/toggle/16", HTTP_OPTIONS, handleOptions);
  server.on("/toggle/17", HTTP_OPTIONS, handleOptions);
  server.on("/toggle/18", HTTP_OPTIONS, handleOptions);
  server.on("/toggle/19", HTTP_OPTIONS, handleOptions);

  // Inregistreaza /water/start/N si /water/stop/N pentru fiecare port
  for (int i = 1; i <= NUM_PORTS; i++) {
    String startUri = "/water/start/" + String(i);
    String stopUri  = "/water/stop/"  + String(i);
    server.on(startUri.c_str(), HTTP_GET,     handleWaterStart);
    server.on(startUri.c_str(), HTTP_POST,    handleWaterStart);
    server.on(startUri.c_str(), HTTP_OPTIONS, handleOptions);
    server.on(stopUri.c_str(),  HTTP_GET,     handleWaterStop);
    server.on(stopUri.c_str(),  HTTP_POST,    handleWaterStop);
    server.on(stopUri.c_str(),  HTTP_OPTIONS, handleOptions);
  }

  server.begin();

  // LED-ul intern ramane aprins fix in mod normal (semn de "operational").
  digitalWrite(PIN_STATUS_LED, HIGH);

  drawCircles();
}

// Bucla modului normal — logica originala de functionare.
void loopNormal() {

  server.handleClient();
  updateConnectorDetection();
  updateWateringStateMachine();

  if (millis() - lastBlink > 400) {
    lastBlink = millis();
    blinkState = !blinkState;
    drawCircles();
  }

  if (millis() - lastStatusLog > 5000) {
    lastStatusLog = millis();
    Serial.print("[ch=");
    Serial.print(currentWifiChannel);
    Serial.print(", pump=");
    Serial.print(pumpOn ? "ON" : "OFF");
    Serial.print(", watering=");
    Serial.print(wateringPort + 1);
    Serial.println("]");
    for (int i = 0; i < NUM_PORTS; i++) {
      Serial.print("Port ");
      Serial.print(i + 1);
      Serial.print(": physical=");
      Serial.print(portPhysical[i] ? "Y" : "N");
      Serial.print(", confirmed=");
      Serial.print(portConfirmed[i] ? "Y" : "N");
      Serial.print(", name=");
      Serial.print(portName[i]);
      Serial.print(", valve=");
      Serial.println(valveOn[i] ? "ON" : "OFF");
    }
  }
}

// ============================================================
//  Reset provisioning prin butonul BOOT
// ============================================================

// Daca butonul BOOT e tinut apasat la pornire, sterge credentialele.
void checkResetButton() {
  pinMode(PIN_BOOT_BTN, INPUT_PULLUP);

  // BOOT apasat = LOW. Verificam ca e tinut apasat RESET_HOLD_MS.
  if (digitalRead(PIN_BOOT_BTN) != LOW) return;

  Serial.println("BOOT button held - hold to reset provisioning...");
  unsigned long start = millis();
  while (digitalRead(PIN_BOOT_BTN) == LOW) {
    if (millis() - start >= RESET_HOLD_MS) {
      Serial.println("Reset confirmed - clearing credentials");
      clearCredentials();
      // Feedback vizual: LED-ul clipeste rapid de cateva ori.
      for (int i = 0; i < 6; i++) {
        digitalWrite(PIN_STATUS_LED, HIGH); delay(80);
        digitalWrite(PIN_STATUS_LED, LOW);  delay(80);
      }
      return;
    }
    delay(50);
  }
}

// ============================================================
//  Setup & Loop
// ============================================================

void setup() {

  Serial.begin(115200);
  delay(200);

  // LED-ul intern — folosit ca indicator de mod.
  pinMode(PIN_STATUS_LED, OUTPUT);
  digitalWrite(PIN_STATUS_LED, LOW);

  // Verifica butonul de reset INAINTE de a decide modul.
  checkResetButton();

  // Display — initializat in ambele moduri.
  Wire.begin(21, 22);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);

  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 20);
  display.println("Booting...");
  display.display();
  delay(500);

  // Pompa + valve — initializate in ambele moduri (siguranta).
  pinMode(PIN_PUMP, OUTPUT);
  pinMode(PIN_VALVE1, OUTPUT);
  pinMode(PIN_VALVE2, OUTPUT);
  pinMode(PIN_VALVE3, OUTPUT);
  digitalWrite(PIN_PUMP, LOW);
  digitalWrite(PIN_VALVE1, LOW);
  digitalWrite(PIN_VALVE2, LOW);
  digitalWrite(PIN_VALVE3, LOW);

  // Detectie porturi.
  for (int i = 0; i < NUM_PORTS; i++) {
    pinMode(portDetectOut[i], OUTPUT);
    digitalWrite(portDetectOut[i], HIGH);
    pinMode(portDetectIn[i], INPUT_PULLDOWN);
  }

  // ---- Alegerea modului: exista credentiale salvate? ----
  if (loadCredentials()) {
    deviceMode = MODE_NORMAL;
    Serial.println("Credentials found -> NORMAL mode");
    startNormalMode();
  } else {
    deviceMode = MODE_PROVISIONING;
    Serial.println("No credentials -> PROVISIONING mode");
    drawProvisioningScreen("Astept BLE...");
    startBleProvisioning();
  }
}

void loop() {

  if (deviceMode == MODE_NORMAL) {
    loopNormal();
  } else {
    loopProvisioning();
  }
}

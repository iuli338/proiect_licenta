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

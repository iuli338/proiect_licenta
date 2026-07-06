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
#include <HTTPClient.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Preferences.h>
#include <time.h>

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
#define RECOVERY_SAVE_MS  1000  // ms intre salvarile progresului udarii (recovery)

// ---------- Regulator PI automat (vezi misc/decizie_udare_diagrama.svg) ----------
//
// Tick-ul regulatorului se evalueaza periodic in loopNormal pentru fiecare port
// confirmat+configurat cu auto-udare activata. Pasul Δt e mare (dinamica solului
// e in ore), dar configurabil mai jos pentru testare.
// TESTARE: pentru a verifica declansarea pe placa fara a astepta ore, scurteaza
// temporar REG_TICK_MS (ex 5000 = 5 s) si, in EEPROM/dashboard, tMinMin/safetyMaxMin
// la cateva minute. Lasa valorile reale in productie (dinamica solului e in ore).
#define REG_TICK_MS       (10UL * 60UL * 1000UL)  // 10 min — pas regulator (Δt)
#define ANTI_TWITCH_MIN   360U   // 6 h — nu udam din nou daca am udat foarte recent
#define DOSE_MIN_ML       5      // clamp inferior doza automata [ml]
#define DOSE_MAX_ML       200    // clamp superior doza automata [ml]
// Pas integral in minute (Δt din formula I += Ki·e·Δt). Tinut separat de
// REG_TICK_MS ca, daca scurtam tick-ul pentru testare, integrala sa ramana
// in aceeasi unitate (ore) ca acordarea IMC a lui Ki [ml/(%·h)].
#define REG_DT_H          (10.0f / 60.0f)   // 10 min exprimat in ore

// Debitul pompei — valoarea IMPLICITĂ de fabrică, în ml/s. Calibrat empiric
// pe banc (3 măsurători de 100 ml). La pornire, dacă EEPROM-ul conţine un
// debit salvat valid, acesta îl suprascrie pe cel implicit în variabila
// globală `pumpFlowMlPerSec` (vezi storageLoadSystem / loadFlowRate).
// Conversia ml ↔ durată pompă foloseşte ÎNTOTDEAUNA variabila globală, nu
// acest define (care e doar fallback-ul la prima pornire / EEPROM gol).
#define PUMP_FLOW_DEFAULT       3.21f
// Limite realiste pentru debitul configurabil din dashboard. O micropompă
// de 5 V tipică livrează ~1..20 ml/s; păstrăm o plajă largă dar sigură ca
// să respingem valori absurde (0, negative, sute de ml/s).
#define PUMP_FLOW_MIN           0.5f
#define PUMP_FLOW_MAX           50.0f

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

// ---------- EEPROM extern (AT24C256, I2C) ----------
//
// 32 KB, partajeaza bus-ul I2C cu OLED-ul (SDA=21, SCL=22). Adresare interna
// pe 16 biti (big-endian), pagina de scriere 64 B, ciclu intern de scriere
// ~5 ms. Folosit pentru: config noduri, parametri regulator, statistici si
// log inelar de udari (vezi hub_eeprom.ino pentru layout).
#define EEPROM_ADDR              0x50    // A0/A1/A2 = GND
#define EEPROM_SIZE_BYTES        32768
#define EEPROM_PAGE_SIZE         64      // pagina de scriere AT24C256
#define EEPROM_WRITE_CYCLE_MS    10      // 5 ms tipic, 10 ms max datasheet
#define EEPROM_BOOT_DELAY_MS     200     // aştept t_PU + stabilizare bus
#define EEPROM_PING_RETRIES      5       // încercări de ACK la pornire
#define EEPROM_PING_GAP_MS       50

// ---------- Layout EEPROM ----------
//
// Fix, definit explicit ca să nu depindem de sizeof() (struct padding pe
// arhitecturi diferite ar muta câmpurile). Versionat prin EEPROM_MAGIC —
// dacă header-ul nu se potriveşte, considerăm EEPROM-ul "gol" şi îl
// iniţializăm. La schimbarea layout-ului incrementăm versiunea.

#define EEPROM_MAGIC              "DROPv01"   // 8 B (cu \0)
#define EEPROM_LAYOUT_VERSION     8   // bump => re-init la urmatorul boot
                                      // (v7: slot SystemConfig — debit pompa)
                                      // (v8: slot RecoveryState — udare intrerupta)

#define EEPROM_OFFSET_HEADER      0x0000      // 32 B (resv 64 B pana la slot)
#define EEPROM_OFFSET_CONFIG_P1   0x0040      // 128 B per port
#define EEPROM_OFFSET_CONFIG_P2   0x00C0
#define EEPROM_OFFSET_CONFIG_P3   0x0140
#define EEPROM_OFFSET_PARAMS_P1   0x01C0      // 64 B per port
#define EEPROM_OFFSET_PARAMS_P2   0x0200
#define EEPROM_OFFSET_PARAMS_P3   0x0240
#define EEPROM_OFFSET_STATS_P1    0x0280      // 64 B per port
#define EEPROM_OFFSET_STATS_P2    0x02C0
#define EEPROM_OFFSET_STATS_P3    0x0300
#define EEPROM_OFFSET_SYSCFG      0x0340      // 64 B — config global sistem
#define EEPROM_OFFSET_RECOVERY    0x0380      // 64 B — udare intrerupta (recovery)
// 0x03C0..0x0FFF rezervat pentru extensii
// 0x1000..0x7FFF (~28 KB) rezervat pentru log inelar de udări (etapă viitoare)

#define NODE_CONFIG_SIZE          128
#define REG_PARAMS_SIZE           64
#define NODE_STATS_SIZE           64
#define SYS_CONFIG_SIZE           64
#define RECOVERY_SIZE             64

// ---------- Autentificare (cod de acces) ----------
//
// Codul de acces al hub-ului. Este FIX, definit aici si imprimat pe cutie.
// La conectarea din dashboard, utilizatorul introduce acest cod; hub-ul
// confirma daca e corect, iar serverul il retine in sesiunea utilizatorului.
#define HUB_ACCESS_CODE  "1234"

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

// ---------- Udare cu cantitate fixă ("dose") ----------
//
// Modul "dose" e identic cu udarea normală, dar opreşte automat pompa
// după o durată calculată din ml/debit. Foloseşte aceeaşi state machine
// — singura diferenţă e că `doseDurationMs > 0` declanşează oprirea
// din PHASE_PUMPING fără să aşteptăm un /water/stop manual.
// `doseLastMl` reţine doza ultimă (folosit la finalizare pt. statistici).
unsigned long doseDurationMs = 0;   // 0 = udare manuală (fără auto-stop)
uint16_t      doseLastMl     = 0;

// ---------- Recovery: udare intrerupta de pana de curent ----------
// Cat timp livram apa, salvam periodic in EEPROM cati ml mai raman (throttle la
// ~1 s, ca sa nu uzam AT24C). `recoveryLastSaveMs` retine ultima scriere.
// La boot, checkWateringRecovery() umple `recoveryPending`/`recoveryPendingMl`/
// `recoveryPendingPort`/`recoveryPendingPlant` daca gaseste un slot valid;
// udarea NU se reia automat — asteapta decizia userului din dashboard.
unsigned long recoveryLastSaveMs   = 0;
bool          recoveryPending      = false;
uint8_t       recoveryPendingPort  = 0;
uint16_t      recoveryPendingMl    = 0;
char          recoveryPendingPlant[32] = {0};

// Debitul activ al pompei [ml/s]. Iniţializat cu valoarea de fabrică; la boot,
// dacă EEPROM-ul are un debit salvat valid, e suprascris în loadFlowRate().
// Endpoint-ul POST /flow-rate îl actualizează aici ŞI în EEPROM. TOATE
// conversiile ml ↔ durată pompă folosesc această variabilă.
float pumpFlowMlPerSec = PUMP_FLOW_DEFAULT;

uint8_t currentWifiChannel = 1;

bool blinkState = false;
unsigned long lastBlink = 0;
unsigned long lastStatusLog = 0;

typedef struct {
  char msgType[8];
  char nodeName[NAME_LEN];
  char message[24];
} EspNowMessage;

// Mesaj cu citiri senzori — primit periodic de la noduri (5 s tipic).
// NAN denotă senzor absent; serializat în /status ca `null`.
// Câmpul `reserved` păstrează dimensiunea istorică (40B) după eliminarea
// senzorului DS18B20 de temperatură sol.
typedef struct __attribute__((packed)) {
  char     msgType[8];           // "SENSE"
  char     nodeName[NAME_LEN];   // "P1"/"P2"/"P3"
  float    soilMoisturePct;      // 0..100 sau NAN
  float    reserved;             // ex-soilTempC (DS18B20 eliminat)
  float    airTempC;
  float    airHumidityPct;
  float    lux;
  uint32_t uptimeMs;             // de la pornirea nodului
} SensorMessage;                 // 40 B

// Ultima citire per port — păstrată în RAM. lastUpdateMs = 0 înseamnă
// că nu am primit niciodată un SENSE de la portul respectiv (frontend
// afişează "—" pe toate câmpurile). Câmpurile NAN se serializează null.
typedef struct {
  float         soilMoisturePct;
  float         airTempC;
  float         airHumidityPct;
  float         lux;
  unsigned long lastUpdateMs;    // millis() la ultima recepţie
} NodeSensors;

NodeSensors portSensors[NUM_PORTS] = {};

// Stare regulator PI per port — pastrata in RAM (se pierde la reboot; integrala
// reporneste de la 0, ceea ce e sigur dupa o intrerupere). `integralMl` este
// acumulatorul I [ml] din diagrama (I += Ki·e·Δt cat timp e>0). `lastTickMs`
// marcheaza ultimul tick de regulator pentru a respecta pasul REG_TICK_MS.
typedef struct {
  float         integralMl;     // acumulator integral I [ml]
  unsigned long lastTickMs;     // millis() la ultimul tick evaluat
} RegState;

RegState portReg[NUM_PORTS] = {};

// ---------- Structuri EEPROM ----------
//
// Toate sunt POD (Plain Old Data) cu __attribute__((packed)) ca să fim
// siguri că sizeof e exact ce cerem layout-ul. Dimensiuni totale verificate
// prin static_assert-uri în hub_storage.ino.

typedef struct __attribute__((packed)) {
  char     magic[8];              // "DROPv01"
  uint8_t  version;               // EEPROM_LAYOUT_VERSION
  uint8_t  reserved[23];          // padding pana la 32 B
} EepromHeader;

// Total per câmp:
//   16 + 32 + 1 + 1   (plant)
// + 16 + 32 + 1 + 1   (soil)
// + 12                (color)
// + 1                 (configured)
// = 113  =>  reserved[15] => total 128 B
// Aliniat pe 128 ca să încapă în 2 pagini de scriere (curat pentru AT24C256).
// Nume mărite la 32 B ca să încapă UTF-8 raw: "Substrat pe bază de turbă"
// = 27 octeţi, ar fi trunchiat în 24 B.
typedef struct __attribute__((packed)) {
  // Plantă
  char     plantId[16];
  char     plantName[32];
  uint8_t  waterNeed;             // 0=scazut, 1=mediu, 2=ridicat
  uint8_t  plantCustom;
  // Sol
  char     soilId[16];
  char     soilName[32];
  uint8_t  retention;             // 0=scazut, 1=mediu, 2=ridicat
  uint8_t  soilCustom;
  // Card
  char     color[12];
  // Flag
  uint8_t  configured;
  uint8_t  reserved[15];
} NodeConfig;                     // 128 B

// 5×float + 4×uint16 + 1×uint8 + 3×uint16 (LAYOUT 5) + 1×uint8 (LAYOUT 6) = 36 B
// reserved[28] => 64 B total.
//
// Câmpurile din clasa de udare (vezi node_config._WATERING_CLASSES):
//   wateringClass  — enum 0..4 (foarte_rar/rar/echilibrat/frecvent/zilnic)
//   tMinMin        — interval minim între udări [min] (cadenţa biologică)
//   targetDoseMl   — doza ţintă per udare [ml]
//   safetyMaxMin   — max timp fără udare [min] (1.2× tMinMin)
// NOU în LAYOUT 6:
//   autoWateringEnabled — flag care permite regulatorului să acţioneze
//                         automat pe portul respectiv. Default 0 (off).
typedef struct __attribute__((packed)) {
  float    K;                     // %/ml — câştig proces
  float    tauH;                  // ore — constanta de uscare
  float    lambdaH;               // ore — agresivitate IMC (din clasă)
  float    Kp;                    // ml / %eroare
  float    Ki;                    // ml / (%eroare · h)
  uint16_t setpoint10;            // setpoint × 10 (ex: 500 = 50.0%)
  uint16_t hysteresis10;          // hysteresis × 10
  uint16_t minIntervalMin;        // = tMinMin (păstrat ca alias legacy)
  uint16_t doseEstimatMl;         // = targetDoseMl (păstrat ca alias legacy)
  // LAYOUT_VERSION 5:
  uint8_t  wateringClass;         // 0=foarte_rar 1=rar 2=echilibrat 3=frecvent 4=zilnic
  uint16_t tMinMin;               // interval minim între udări [min]
  uint16_t targetDoseMl;          // doza ţintă per udare [ml]
  uint16_t safetyMaxMin;          // max timp fără udare [min]
  // LAYOUT_VERSION 6:
  uint8_t  autoWateringEnabled;   // 0=off, 1=on (regulator automat activ)
  uint8_t  reserved[28];
} RegParams;                      // 64 B

// 5×uint32 + 1×uint16 + 1×uint8 = 23 B; reserved[41] => 64 B total.
typedef struct __attribute__((packed)) {
  uint32_t createdAt;             // epoch UTC (s) — momentul configurarii
  uint32_t lastWatering;          // epoch UTC (s)
  uint32_t lastSeen;              // epoch UTC (s) — ultima comunicare nod
  uint32_t totalWaterings;        // numar de udari de cand e configurat
  uint32_t totalMl;               // ml totali livrati
  uint16_t lastDoseMl;            // doza ultima udare
  uint8_t  lastMoisturePct;       // umiditatea ultima citire (%)
  uint8_t  reserved[41];
} NodeStats;                      // 64 B

// Config GLOBAL al sistemului (nu per nod). Pentru moment ţine doar debitul
// pompei (ml/s), calibrat o singură dată pe ansamblul hub-pompă-furtun şi
// editabil din dashboard (tab Setări). `valid` = 1 marchează un slot scris
// corect; la slot gol (0x00) sau invalid, firmware-ul foloseşte
// PUMP_FLOW_DEFAULT. flowMlPerSec × 100 e stocat ca întreg ca să evităm
// reprezentarea binară float în EEPROM (ex: 321 = 3.21 ml/s).
// 1×uint8 + 1×uint16 = 3 B; reserved[61] => 64 B total.
typedef struct __attribute__((packed)) {
  uint8_t  valid;                 // 1 = slot scris valid, 0 = gol
  uint16_t flowMlPerSecX100;      // debit × 100 (ex: 321 = 3.21 ml/s)
  uint8_t  reserved[61];
} SystemConfig;                   // 64 B

// ---------- Stare de recovery (udare intrerupta de pana de curent) ----------
// Cat timp pompa livreaza apa (PHASE_PUMPING), hub-ul salveaza periodic in acest
// slot cati ml mai raman de livrat si pentru care planta. Daca se ia curentul in
// mijlocul udarii, la boot slotul ramane `valid = 1` si udarea NU se reia automat:
// e expusa in /status, iar utilizatorul decide din dashboard (Accept = reia cu
// ml-ii ramasi, Refuza = renunta). Slotul se zeroizeaza la finalul unei udari
// normale, la Accept sau la Refuza.
// 1×uint8 + 1×uint8 + 32×char + 1×uint16 + 1×uint32 = 40 B; reserved[24] => 64 B.
typedef struct __attribute__((packed)) {
  uint8_t  valid;                 // 1 = udare intrerupta in asteptare
  uint8_t  port;                  // portul udat (0..NUM_PORTS-1)
  char     plantName[32];         // numele plantei (pentru afisare in modal)
  uint16_t remainingMl;           // ml ramasi de livrat in momentul salvarii
  uint32_t timestamp;             // epoch UTC cand a fost salvat (0 daca RTC absent)
  uint8_t  reserved[24];
} RecoveryState;                  // 64 B

// ---------- Stare provisioning (BLE) ----------

BLEServer*         bleServer       = nullptr;
BLECharacteristic* statusChar      = nullptr;  // caracteristica NOTIFY
volatile bool      bleClientConn   = false;
volatile bool      credsReceived   = false;    // setat de callback-ul BLE
String             pendingSsid     = "";
String             pendingPass     = "";
String             pendingCallback = "";   // URL HTTP unde raportăm IP-ul
unsigned long      lastLedBlink    = 0;

// ---------- Stare EEPROM extern ----------
// Setat în setup() după ping I2C reuşit; dacă rămâne false, EEPROM-ul nu
// răspunde — toate operaţiile pe el devin no-op (logăm o singură dată).
bool               eepromReady     = false;

// Cât timp facem o secvenţă de scrieri EEPROM, blocăm redesenarea OLED-ului
// (acelaşi bus I2C). Incrementat înainte de write, decrementat după —
// permite nested guards fără să se rupă.
volatile int       i2cBusyDepth    = 0;

// ---------- Log diagnostic la boot ----------
// Buffer in RAM (~2 KB) — păstrează tot ce s-a întâmplat în setup() pentru
// a fi servit prin endpoint-ul /diagnostics. Vizibil în UI sub butonul
// "Vezi diagnostica" pe cardul de stare hub.
#define BOOT_LOG_SIZE      2048
char               bootLog[BOOT_LOG_SIZE]  = {0};
size_t             bootLogLen              = 0;

// Status detectat la boot pentru fiecare modul I²C (folosit în diagnostic).
bool               oledOk                  = false;
bool               rtcOk                   = false;
#define RTC_I2C_ADDR       0x68      // adresa standard DS1307/DS3231

// Ora curentă citită de la RTC — actualizată periodic în loopNormal.
// Cache RAM ca să nu apelăm I²C la fiecare drawCircles (40 Hz).
uint8_t            rtcHour                 = 0;
uint8_t            rtcMinute               = 0;
uint8_t            rtcSecond               = 0;
unsigned long      lastRtcRead             = 0;
#define RTC_READ_INTERVAL_MS  1000   // citire la 1 s

// ---------- Reset runtime prin butonul BOOT ----------
// Permite ţinerea BOOT 3 sec şi în mod normal (nu doar la pornire) ca
// să resetăm hub-ul în BLE provisioning fără power-cycle.
unsigned long      bootPressedSince        = 0;   // 0 = nu apăsat acum

// ---------- Reconectare WiFi ----------
// Dacă WiFi-ul cade după ce am intrat în mod normal, încercăm o reconectare
// la fiecare 5 secunde, la infinit. OLED-ul afişează "Reconnecting..." în
// loc de IP cât timp suntem offline.
unsigned long      lastWifiReconnect = 0;

#define WIFI_RECONNECT_GAP_MS    5000   // 5 s între încercări

// ---------- Helper log boot ----------
// Append la buffer-ul de log + mirror pe Serial. Dacă buffer-ul e plin,
// noile mesaje sunt trunchiate (n-au de ce să fie atât de multe în setup).
void bootLogf(const char* fmt, ...) {
  if (bootLogLen >= BOOT_LOG_SIZE - 1) return;
  va_list args;
  va_start(args, fmt);
  int n = vsnprintf(bootLog + bootLogLen,
                    BOOT_LOG_SIZE - bootLogLen, fmt, args);
  va_end(args);
  if (n > 0) {
    bootLogLen += n;
    // Mirror simultan pe Serial — păstrăm vizibilitatea în Arduino IDE.
    Serial.print(bootLog + bootLogLen - n);
  }
}

// ============================================================
//  Setup & Loop
// ============================================================

void setup() {

  Serial.begin(115200);
  delay(200);

  // Începem să umplem log-ul de boot — vizibil prin /diagnostics.
  bootLogLen = 0;
  bootLog[0] = '\0';
  bootLogf("=== Dropwise HUB boot ===\n");

  // LED-ul intern — folosit ca indicator de mod.
  pinMode(PIN_STATUS_LED, OUTPUT);
  digitalWrite(PIN_STATUS_LED, LOW);

  // Verifica butonul de reset INAINTE de a decide modul.
  checkResetButton();

  // Display — initializat in ambele moduri.
  Wire.begin(21, 22);
  // Forţăm 50 kHz pe bus-ul partajat (OLED + EEPROM + RTC). 100/400 kHz
  // dă glitch-uri OLED când cablajul are capacitate mare, fire lungi pe
  // breadboard sau pull-up-uri slabe. 50 kHz e ultra-conservator.
  Wire.setClock(50000);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);

  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 20);
  display.println("Booting...");
  display.display();
  delay(500);

  // EEPROM extern AT24C256 — partajeaza bus-ul cu OLED-ul. Aşteaptă t_PU
  // şi pinguie chip-ul cu retry (uneori AT24C nu răspunde imediat după
  // power-on). Dacă lipseşte, eepromReady rămâne false şi persistenţa
  // configuraţiei devine no-op (hub-ul tot funcţionează în mod degradat).
  // OLED — display.begin nu raporteaza eroare explicit, dar daca adresa
  // 0x3C va fi gasita la scan, marcam oledOk.
  eepromInit();
  // i2cScan după eepromInit — la momentul ăsta toate dispozitivele sunt
  // ready. Înainte de delay-ul de boot, AT24C poate nu apare în scan.
  // Scan-ul seteaza oledOk si rtcOk pe baza adreselor detectate.
  i2cScan();
  // Iniţializăm layout-ul (header + slot-uri zero la prima pornire).
  storageInit();

  // Debitul pompei: dacă EEPROM-ul e OK şi conţine un debit salvat valid,
  // îl încarcă în pumpFlowMlPerSec; altfel rămâne valoarea de fabrică.
  loadFlowRate();

  // Recovery: dacă o udare a fost întreruptă de o pană de curent, slotul de
  // recovery din EEPROM e încă valid. Îl încărcăm în variabilele recoveryPending*
  // (nu reluăm automat — utilizatorul decide din dashboard, prin modalul de pe
  // tab-ul Monitor).
  checkWateringRecovery();

  // Rezumat status module — apare in /diagnostics.
  bootLogf("OLED  - %s\n", oledOk      ? "OK" : "lipsa");
  bootLogf("EEPROM - %s\n", eepromReady ? "OK" : "lipsa");
  bootLogf("RTC   - %s\n", rtcOk       ? "OK" : "lipsa (optional)");

  // RTC: citim ora curenta o data ca sa apara pe OLED de la primul frame.
  rtcInit();

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

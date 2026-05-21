#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

// Schimba aici pentru fiecare nod ("P1", "P2", "P3")
#define NODE_NAME "P2"

#define LED_PIN 2

// SSID-ul hotspot-ului la care e conectat hub-ul -
// nodul nu se conecteaza, doar scaneaza ca sa afle pe ce canal e
const char* hubSsid = "Galaxy S20 0782";

typedef struct {
  char msgType[8];
  char nodeName[8];
  char message[24];
} EspNowMessage;

uint8_t hubMac[] = {
  0x44, 0x1D, 0x64, 0xE4, 0x41, 0xA0
};

volatile bool confirmed = false;
uint8_t wifiChannel = 1;

unsigned long lastHello = 0;
unsigned long lastBlink = 0;
unsigned long lastChannelCheck = 0;
bool ledState = false;

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

void onDataSent(
  const uint8_t *mac_addr,
  esp_now_send_status_t status
) {
  Serial.print("Send status: ");
  Serial.println(
    status == ESP_NOW_SEND_SUCCESS ? "OK" : "FAIL"
  );
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

    if (now - lastHello >= 10000) {
      lastHello = now;
      sendHello();
    }
  }
}

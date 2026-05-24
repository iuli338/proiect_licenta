/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   Arduino concateneaza automat toate fisierele .ino din folder;
   variabilele globale si include-urile sunt in esp32_hub_v6.ino.
   ============================================================ */

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

  // Dacă suntem în mijlocul unei tranzacţii EEPROM (acelaşi bus I²C cu
  // OLED-ul, partajat indirect prin Wire), ignorăm callback-ul. Nodul îşi
  // va retrimite HELLO-ul după câteva secunde — protocolul lor are deja
  // retry. Aşa evităm tranzacţia I²C ruptă la mijloc (rezultat: err 5/2).
  if (i2cBusyDepth > 0) {
    Serial.println("ESP-NOW: ignor mesaj (EEPROM busy)");
    return;
  }

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
      // Marcăm "ultima dată văzut" pentru nodul deja cunoscut.
      statsTouchLastSeen(msg.nodeName);
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
    statsTouchLastSeen(msg.nodeName);
    drawCircles();
  }
}

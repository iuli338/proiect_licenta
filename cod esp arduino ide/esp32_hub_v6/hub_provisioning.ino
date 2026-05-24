/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   Arduino concateneaza automat toate fisierele .ino din folder;
   variabilele globale si include-urile sunt in esp32_hub_v6.ino.
   ============================================================ */

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

    // Format primit: "SSID\nPAROLA" sau "SSID\nPAROLA\nCALLBACK_URL"
    // Callback-ul (optional) e URL-ul HTTP unde raportam IP-ul dupa
    // conectarea la WiFi — workaround pt. radio BLE/WiFi partajat.
    int nl1 = raw.indexOf('\n');
    if (nl1 < 0) {
      Serial.println("BLE creds: format invalid (lipseste \\n)");
      bleSendStatus("FAIL format invalid");
      return;
    }

    pendingSsid = raw.substring(0, nl1);

    int nl2 = raw.indexOf('\n', nl1 + 1);
    if (nl2 < 0) {
      // Doar SSID+parola (format vechi).
      pendingPass = raw.substring(nl1 + 1);
      pendingCallback = "";
    } else {
      pendingPass = raw.substring(nl1 + 1, nl2);
      pendingCallback = raw.substring(nl2 + 1);
      pendingCallback.trim();
    }
    credsReceived = true;   // procesate in loop, nu in callback

    Serial.print("BLE creds received, SSID: ");
    Serial.println(pendingSsid);
    if (pendingCallback.length()) {
      Serial.print("Callback URL: ");
      Serial.println(pendingCallback);
    }
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

    // Confirmare prin HTTP catre PC — fiabila, foloseste WiFi-ul tocmai
    // stabilit. Daca radio-ul BLE a fost perturbat de WiFi.begin, asta e
    // singurul canal sigur prin care PC-ul afla IP-ul.
    if (pendingCallback.length()) {
      HTTPClient http;
      http.begin(pendingCallback);
      http.addHeader("Content-Type", "application/json");
      String body = "{\"ip\":\"" + ip + "\"}";
      int code = http.POST(body);
      Serial.print("HTTP callback -> ");
      Serial.print(pendingCallback);
      Serial.print("  status: ");
      Serial.println(code);
      http.end();
    }

    // Si pe BLE — pentru clientii vechi sau cand HTTP-ul nu ajunge.
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

  // Diagnostic — log de boot + status module (pentru butonul "Vezi diagnostica").
  server.on("/diagnostics", HTTP_GET,     handleDiagnostics);
  server.on("/diagnostics", HTTP_OPTIONS, handleOptions);

  // Setare ora RTC din UI (Setări).
  server.on("/time", HTTP_POST,    handleSetTime);
  server.on("/time", HTTP_OPTIONS, handleOptions);

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

  // /node/Pi/config + /node/Pi/stats + /node/Pi/forget — persistate în EEPROM.
  for (int i = 1; i <= NUM_PORTS; i++) {
    String cfgUri    = "/node/P" + String(i) + "/config";
    String statsUri  = "/node/P" + String(i) + "/stats";
    String forgetUri = "/node/P" + String(i) + "/forget";
    server.on(cfgUri.c_str(),    HTTP_GET,     handleNodeGet);
    server.on(cfgUri.c_str(),    HTTP_POST,    handleNodePost);
    server.on(cfgUri.c_str(),    HTTP_OPTIONS, handleOptions);
    server.on(statsUri.c_str(),  HTTP_GET,     handleNodeStats);
    server.on(statsUri.c_str(),  HTTP_OPTIONS, handleOptions);
    server.on(forgetUri.c_str(), HTTP_POST,    handleNodeForget);
    server.on(forgetUri.c_str(), HTTP_OPTIONS, handleOptions);
  }

  server.begin();

  // LED-ul intern ramane aprins fix in mod normal (semn de "operational").
  digitalWrite(PIN_STATUS_LED, HIGH);

  drawCircles();
}

// Reconectare WiFi simplă — dacă WiFi-ul cade, încercăm WiFi.begin() la
// fiecare 5 secunde, la infinit. OLED-ul (drawCircles) afişează
// "Reconnecting..." în loc de IP cât timp WiFi.localIP() e 0.0.0.0.
void checkWifiReconnect() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiReconnect < WIFI_RECONNECT_GAP_MS) return;
  lastWifiReconnect = millis();
  Serial.println("WiFi offline — reconnecting...");
  WiFi.disconnect();
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
}

// Bucla modului normal — logica originala de functionare.
void loopNormal() {

  // Verifică BOOT runtime — răspunde mereu, indiferent de starea I²C.
  checkRuntimeReset();


  // Sărim peste handle-uirea de alte cereri HTTP cât suntem în mijlocul
  // unei tranzacţii EEPROM. Cererile noi vor fi acceptate la următorul
  // tur de buclă, după ce write-ul curent s-a terminat. Acelaşi guard
  // pentru detecţia portului şi state-machine-ul de udare (toate citesc
  // sau scriu pe bus indirect prin OLED / EEPROM).
  if (i2cBusyDepth == 0) {
    server.handleClient();
    updateConnectorDetection();
    updateWateringStateMachine();
    checkWifiReconnect();
    rtcUpdateCache();
  }

  if (millis() - lastBlink > 400 && i2cBusyDepth == 0) {
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

// Verifica butonul BOOT in MOD NORMAL (runtime). Daca e tinut apasat
// 3 secunde, sterge credentialele si restarteaza in BLE provisioning.
// Apelata pe fiecare iteratie a loopNormal (cost mic — un digitalRead).
void checkRuntimeReset() {
  bool pressed = (digitalRead(PIN_BOOT_BTN) == LOW);

  if (!pressed) {
    bootPressedSince = 0;
    return;
  }

  if (bootPressedSince == 0) {
    // Tocmai a fost apasat — pornim cronometrul.
    bootPressedSince = millis();
    Serial.println("BOOT pressed — tine 3 sec pentru reset provisioning");
    return;
  }

  if (millis() - bootPressedSince >= RESET_HOLD_MS) {
    Serial.println("Reset confirmat runtime — sterg credentiale + reboot");
    drawProvisioningScreen("Reset BLE...");
    clearCredentials();
    // Feedback vizual: LED-ul intern clipeste rapid.
    for (int i = 0; i < 6; i++) {
      digitalWrite(PIN_STATUS_LED, HIGH); delay(80);
      digitalWrite(PIN_STATUS_LED, LOW);  delay(80);
    }
    delay(500);
    ESP.restart();
  }
}

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

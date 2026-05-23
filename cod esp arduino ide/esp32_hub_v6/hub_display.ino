/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   Arduino concateneaza automat toate fisierele .ino din folder;
   variabilele globale si include-urile sunt in esp32_hub_v6.ino.
   ============================================================ */

// ============================================================
//  Display
// ============================================================

void drawCircles() {

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  if (WiFi.status() == WL_CONNECTED) {
    display.println(WiFi.localIP());
  } else {
    display.println("Reconnecting...");
  }

  display.setCursor(0, 12);
  display.print("HUB ch:");
  display.print(currentWifiChannel);
  if (wateringPort >= 0) {
    display.print(" W:");
    display.print(portName[wateringPort]);
  }
  display.println();

  // Stare EEPROM extern — indica daca persistenta locala e activa.
  display.setCursor(0, 22);
  display.print("EEPROM: ");
  display.print(eepromReady ? "ok" : "fail");

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

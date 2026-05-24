/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   ============================================================

   Driver RTC DS3231 — foloseşte biblioteca RTClib de la Adafruit.
   Modulul stă pe bus-ul I²C la adresa 0x68 (acelaşi bus cu OLED 0x3C
   şi EEPROM 0x50).

   Instalare bibliotecă: în Arduino IDE → Library Manager → caută
   "RTClib by Adafruit" → install.

   Setarea orei NU e implementată acum — utilizatorul presupune că
   modulul are deja ora corectă (e cu baterie de backup).
   ============================================================ */

#include <RTClib.h>

static RTC_DS3231 rtc;

// Citeşte ora curentă de pe DS3231. Întoarce true la succes. Pe NACK
// (modulul lipseşte sau bus-ul I²C e ocupat), întoarce false fără să
// modifice buffer-ul.
bool rtcReadTime(uint8_t& h, uint8_t& m, uint8_t& s) {
  if (!rtcOk) return false;
  DateTime now = rtc.now();
  if (!now.isValid()) return false;
  h = now.hour();
  m = now.minute();
  s = now.second();
  return true;
}

// Epoch UTC curent — folosit pentru `lastWatering`, `createdAt`, etc.
// Întoarce 0 dacă RTC-ul nu e disponibil (caller-ul trebuie să trateze).
uint32_t rtcEpoch() {
  if (!rtcOk) return 0;
  DateTime now = rtc.now();
  if (!now.isValid()) return 0;
  return (uint32_t)now.unixtime();
}

// Setează ora (hh/mm, secunde=0). Păstrează data curentă pentru a nu o
// strica accidental. Returnează true la succes.
bool rtcSetHourMinute(uint8_t hh, uint8_t mm) {
  if (!rtcOk) return false;
  if (hh > 23 || mm > 59) return false;
  DateTime cur = rtc.now();
  if (!cur.isValid()) return false;
  DateTime updated(cur.year(), cur.month(), cur.day(), hh, mm, 0);
  rtc.adjust(updated);
  // Reîmprospătăm cache-ul ca să apară pe OLED imediat.
  rtcHour = hh;
  rtcMinute = mm;
  rtcSecond = 0;
  lastRtcRead = millis();
  return true;
}

// Iniţializare la boot — verifică prezenţa chip-ului, citeşte ora o
// dată ca să populeze cache-ul (apare pe OLED de la primul frame).
void rtcInit() {
  if (!rtcOk) {
    bootLogf("RTC: modul absent — fara ora pe OLED\n");
    return;
  }
  if (!rtc.begin()) {
    bootLogf("RTC: rtc.begin() esuat\n");
    rtcOk = false;
    return;
  }
  // rtc.begin() apelează Wire.begin() — poate schimba viteza I²C.
  // Forţăm 50 kHz, conservatoare (suportat de toate cele 3 dispozitive
  // de pe bus: OLED 0x3C, EEPROM 0x50, RTC 0x68). Mai lent decât
  // standardul 100/400 kHz, dar elimină glitch-urile de bus partajat.
  Wire.setClock(50000);
  // DS3231 are bit OSF (Oscillator Stop Flag) — dacă a pierdut alimentarea
  // şi nu are baterie, ora e invalidă. Logăm dar nu blocăm.
  if (rtc.lostPower()) {
    bootLogf("RTC: lost power — ora poate fi invalida\n");
  }
  uint8_t h, m, s;
  if (rtcReadTime(h, m, s)) {
    rtcHour = h; rtcMinute = m; rtcSecond = s;
    bootLogf("RTC: ora curenta %02u:%02u:%02u\n", h, m, s);
    bootLogf("RTC: setare ora — trimite pe Serial 'SETTIME HH:MM:SS'\n");
  } else {
    bootLogf("RTC: prezent dar citirea a esuat\n");
  }
}

// Refresh-uieşte cache-ul ora la fiecare RTC_READ_INTERVAL_MS. Apelat
// din loopNormal pe fiecare iteraţie (cost mic — întoarce imediat dacă
// nu a trecut intervalul).
void rtcUpdateCache() {
  if (!rtcOk) return;
  if (millis() - lastRtcRead < RTC_READ_INTERVAL_MS) return;
  lastRtcRead = millis();

  uint8_t h, m, s;
  if (rtcReadTime(h, m, s)) {
    rtcHour = h; rtcMinute = m; rtcSecond = s;
  }
}

/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   Arduino concateneaza automat toate fisierele .ino din folder;
   variabilele globale si include-urile sunt in esp32_hub_v6.ino.
   ============================================================ */

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

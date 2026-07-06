/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   Arduino concateneaza automat toate fisierele .ino din folder;
   variabilele globale si include-urile sunt in esp32_hub_v6.ino.
   ============================================================ */

// ============================================================
//  Recovery: udare intrerupta de pana de curent
// ============================================================
//
// Cat timp pompa livreaza o doza fixa, hub-ul salveaza periodic in EEPROM cati
// ml mai raman (vezi saveWateringProgress in hub_storage.ino + hook-ul din
// PHASE_PUMPING in hub_watering.ino). La boot, checkWateringRecovery() incarca
// slotul in recoveryPending* si il expune in /status. Udarea NU se reia automat:
// dashboard-ul afiseaza un modal pe tab-ul Monitor, iar utilizatorul decide.
//
//   POST /recovery/accept   -> reia udarea cu ml-ii ramasi, apoi zeroizeaza slotul
//   POST /recovery/dismiss  -> renunta, doar zeroizeaza slotul
//
// Ambele endpoint-uri cer codul de acces (X-Access-Code) ca restul rutelor.

// POST /recovery/accept — reia udarea intrerupta cu ml-ii ramasi.
void handleRecoveryAccept() {

  if (!checkAccessCode()) return;   // cod lipsa/gresit => 404
  sendCorsHeaders();

  if (!recoveryPending) {
    server.send(409, "application/json", "{\"error\":\"no recovery pending\"}");
    return;
  }

  int port = recoveryPendingPort;
  uint16_t ml = recoveryPendingMl;

  // Daca o alta udare e deja in curs, nu suprascriem — cerem sa se reincerce.
  if (wateringPhase != PHASE_IDLE) {
    server.send(409, "application/json", "{\"error\":\"busy\"}");
    return;
  }

  // Reluam udarea cu ml-ii ramasi. saveWateringProgress va rescrie slotul in
  // timpul noii udari, iar la final storageClearRecovery() il zeroizeaza.
  // Marcam pending=false imediat ca sa nu mai apara modalul intre timp.
  recoveryPending = false;
  storageClearRecovery();
  startWatering(port, ml);

  String json = "{\"status\":\"resumed\",\"port\":";
  json += port + 1;
  json += ",\"ml\":";
  json += ml;
  json += "}";
  server.send(200, "application/json", json);
}

// POST /recovery/dismiss — renunta la udarea intrerupta, zeroizeaza slotul.
void handleRecoveryDismiss() {

  if (!checkAccessCode()) return;
  sendCorsHeaders();

  storageClearRecovery();   // seteaza si recoveryPending = false

  server.send(200, "application/json", "{\"status\":\"dismissed\"}");
}

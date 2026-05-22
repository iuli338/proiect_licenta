/* ============================================================
   Dropwise HUB — firmware (parte din sketch-ul esp32_hub_v6)
   Arduino concateneaza automat toate fisierele .ino din folder;
   variabilele globale si include-urile sunt in esp32_hub_v6.ino.
   ============================================================ */

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

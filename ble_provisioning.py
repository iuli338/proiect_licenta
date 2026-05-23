"""
Dropwise — modul de provisioning BLE
====================================

Logica reală de detecţie Bluetooth şi aprovizionare WiFi a hub-ului ESP32.

Cum funcţionează un ESP32 DevKit (rezumat)
------------------------------------------
ESP32 are WiFi şi Bluetooth LE pe acelaşi cip. La prima pornire, dacă nu are
credenţiale WiFi salvate în NVS (flash intern), porneşte un server GATT BLE şi
emite un advertisement cu nume custom — la noi: "Dropwise HUB".

Fluxul de provisioning:
  1. PC-ul scanează BLE şi găseşte placa după nume.
  2. PC-ul se conectează şi scrie SSID + parola într-o caracteristică GATT.
  3. ESP32 primeşte credenţialele, le salvează şi încearcă WiFi.begin().
  4. ESP32 trimite rezultatul (succes + IP, sau eroare) printr-o caracteristică
     de NOTIFICARE GATT — cât timp conexiunea BLE e încă deschisă.
  5. PC-ul citeşte notificarea, salvează IP-ul şi se poate conecta prin HTTP.

Acest modul oferă două implementări interschimbabile:
  - SimulatedHub  — fără hardware, pentru dezvoltarea UI-ului.
  - RealHub       — bleak (BLE client cross-platform pe Python).

Selecţia se face prin variabila de mediu DROPWISE_BLE_MODE = "sim" | "real".

Modelul de job
--------------
Operaţiile BLE durează (scan ~5s, conectare WiFi ~10-20s) şi sunt async, dar
Flask rulează sincron. De aceea provisioning-ul rulează într-un thread de
fundal şi expune un "job" cu stare (pending / running / success / error) pe
care frontend-ul îl interoghează periodic (polling) cât timp UI-ul e blocat.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------- config BLE
#
# UUID-urile serviciului şi caracteristicilor GATT. Acestea TREBUIE să coincidă
# cu cele definite în firmware-ul ESP32. Le definim aici ca sursă unică de
# adevăr — când scrii firmware-ul, copiază exact aceste valori.
#
# Serviciul de provisioning Dropwise:
DROPWISE_SERVICE_UUID = "8e7c0001-9b1a-4f3e-a2d4-0c1b2a3d4e5f"
# Caracteristică WRITE — PC-ul scrie aici "SSID\nPAROLA":
CHAR_CREDENTIALS_UUID = "8e7c0002-9b1a-4f3e-a2d4-0c1b2a3d4e5f"
# Caracteristică NOTIFY — ESP32 trimite aici rezultatul conectării WiFi:
CHAR_STATUS_UUID = "8e7c0003-9b1a-4f3e-a2d4-0c1b2a3d4e5f"

# Numele sub care emite hub-ul în modul provisioning.
HUB_ADVERTISED_NAME = "Dropwise HUB"

def _env_float(name: str, default: float) -> float:
    """Citeşte o variabilă de mediu numerică; cade pe default dacă lipseşte
    sau e invalidă."""
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# Cât aşteptăm maxim o notificare de status de la ESP32 după ce am scris
# credenţialele (conectarea la WiFi + DHCP poate dura).
# Configurabil din .env prin DROPWISE_BLE_CONFIRM_TIMEOUT.
WIFI_CONFIRM_TIMEOUT_S = _env_float("DROPWISE_BLE_CONFIRM_TIMEOUT", 30.0)

# Durata unui scan BLE — configurabilă din .env prin DROPWISE_BLE_SCAN_DURATION.
SCAN_DURATION_S = _env_float("DROPWISE_BLE_SCAN_DURATION", 6.0)


def get_mode() -> str:
    """Returnează modul activ: 'sim' (implicit) sau 'real'.
    Citit din .env prin variabila DROPWISE_BLE_MODE."""
    mode = os.environ.get("DROPWISE_BLE_MODE", "sim").strip().lower()
    return "real" if mode == "real" else "sim"


# ---------------------------------------------------------------- model job

@dataclass
class ProvisioningJob:
    """
    Starea unei operaţii de provisioning în desfăşurare.

    status:
      pending   — creat, încă nu a pornit
      scanning  — scanare BLE în curs
      connecting— conectat la BLE, se transmit credenţialele
      waiting   — credenţiale trimise, se aşteaptă confirmarea WiFi
      success   — ESP32 confirmat conectat; hub_ip este populat
      error     — a eşuat; message conţine motivul
    """
    id: str
    status: str = "pending"
    message: str = ""
    hub_ip: Optional[str] = None
    ssid: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "message": self.message,
            "hub_ip": self.hub_ip,
            "ssid": self.ssid,
            # True doar într-o stare finală de eşec/succes — UI-ul ştie când
            # poate debloca interfaţa.
            "done": self.status in ("success", "error"),
        }

    def update(self, **kwargs) -> None:
        for k, v in kwargs.items():
            setattr(self, k, v)
        self.updated_at = time.time()


# Registru in-memory al job-urilor active. Pentru o aplicaţie cu un singur
# utilizator (dashboard local) e suficient; nu persistăm job-urile.
_jobs: dict[str, ProvisioningJob] = {}
_jobs_lock = threading.Lock()


def get_job(job_id: str) -> Optional[ProvisioningJob]:
    with _jobs_lock:
        return _jobs.get(job_id)


def _register_job() -> ProvisioningJob:
    job = ProvisioningJob(id=uuid.uuid4().hex[:12])
    with _jobs_lock:
        _jobs[job.id] = job
    return job


# ---------------------------------------------------------------- backend: simulat

class SimulatedHub:
    """
    Hub fals — reproduce temporizarea şi stările reale, fără hardware.
    Util pentru a dezvolta şi testa întregul flux UI.
    """

    # IP-ul pe care îl "primeşte" hub-ul simulat după conectare.
    FAKE_IP = "192.168.1.50"

    def scan(self) -> list[dict]:
        """Simulează un scan BLE de ~2s şi returnează un hub găsit."""
        time.sleep(2.0)
        return [
            {
                "name": HUB_ADVERTISED_NAME,
                "address": "AA:BB:CC:DD:EE:FF",
                "rssi": -47,
            }
        ]

    def provision(self, job: ProvisioningJob, address: str,
                  ssid: str, password: str) -> None:
        """
        Simulează transmiterea credenţialelor şi conectarea WiFi.
        Rulează în thread de fundal — actualizează job-ul pas cu pas.
        """
        job.update(status="connecting", ssid=ssid,
                   message=f"Conectare BLE la {address}…")
        time.sleep(1.5)

        job.update(status="waiting",
                   message="Credenţiale trimise. Hub-ul încearcă să se conecteze la WiFi…")
        time.sleep(4.0)   # simulează WiFi.begin() + DHCP

        # Regulă de simulare: o parolă goală => eşec de autentificare,
        # ca să poţi testa şi ramura de eroare în UI.
        if not password:
            job.update(status="error",
                       message="Hub-ul nu s-a putut conecta: parolă WiFi greşită.")
            return

        job.update(status="success", hub_ip=self.FAKE_IP,
                   message=f"Hub conectat la reţea. IP: {self.FAKE_IP}")


# ---------------------------------------------------------------- HTTP callback server
#
# Ideea: după ce hub-ul a primit credenţialele şi s-a conectat la WiFi, în loc
# să încercăm să citim confirmarea prin BLE (care moare în timpul `WiFi.begin`),
# îi spunem hub-ului unde să trimită confirmarea — un mic HTTP server pe PC.
# Asta e fiabil: callback-ul circulă pe WiFi-ul tocmai stabilit.

from http.server import BaseHTTPRequestHandler, HTTPServer


class _ProvisioningCallback:
    """Server HTTP scurt — primeşte POST /provisioned cu IP-ul hub-ului.

    Foloseşte ca:
        cb = _ProvisioningCallback()
        cb.start()                                  # alocă port liber
        url = cb.callback_url(_local_ipv4())        # http://ip:port/provisioned
        # ... trimite URL-ul la hub prin BLE ...
        ip = cb.wait(timeout_s=30)                  # IP-ul raportat sau None
        cb.stop()
    """

    def __init__(self):
        self._server: Optional[HTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._event = threading.Event()
        self._reported_ip: Optional[str] = None
        self._port: Optional[int] = None

    def start(self) -> int:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                if not self.path.startswith("/provisioned"):
                    self.send_response(404); self.end_headers(); return
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode("utf-8", errors="replace")
                # Acceptăm două formate: corp = IP brut, sau JSON {"ip": "..."}
                ip = body.strip().strip('"')
                if ip.startswith("{"):
                    import json
                    try:
                        ip = (json.loads(body) or {}).get("ip", "")
                    except json.JSONDecodeError:
                        ip = ""
                # Dacă nu e furnizat, folosim adresa clientului HTTP.
                if not ip:
                    ip = self.client_address[0]
                outer._reported_ip = ip
                outer._event.set()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *args, **kwargs):
                pass   # silenţiem log-ul stdlib

        # Port 0 → OS alocă unul liber.
        self._server = HTTPServer(("0.0.0.0", 0), Handler)
        self._port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        daemon=True,
                                        name="dropwise-prov-callback")
        self._thread.start()
        return self._port

    def callback_url(self, host: str) -> str:
        return f"http://{host}:{self._port}/provisioned"

    def wait(self, timeout_s: float) -> Optional[str]:
        if self._event.wait(timeout=timeout_s):
            return self._reported_ip
        return None

    def stop(self) -> None:
        try:
            if self._server:
                self._server.shutdown()
                self._server.server_close()
        except Exception:   # noqa: BLE001
            pass


# ---------------------------------------------------------------- discovery HTTP fallback
#
# Pe ESP32, radio-ul WiFi şi BLE împart aceeaşi antenă, iar la comutarea pe
# WiFi (`WiFi.begin`) stiva BLE poate fi resetată — clientul Python primeşte
# "Device not found" înainte de a apuca să citească notificarea "OK <ip>".
#
# Workaround: după ce s-au scris credenţialele şi BLE a căzut, scanăm subnet-ul
# local pentru un hub Dropwise care răspunde la GET /status cu codul de acces.
# Acela e hub-ul nostru, abia venit pe WiFi.

def _local_ipv4() -> Optional[str]:
    """Returnează IP-ul propriu pe reţeaua locală (best effort)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))   # nu trimite nimic, doar alege interfaţa
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:   # noqa: BLE001
        return None


def discover_hub_on_lan(access_code: Optional[str] = None,
                        timeout_total_s: float = 12.0) -> Optional[str]:
    """Scanează /24-ul local pentru un hub Dropwise care răspunde la /status.

    `access_code` se trimite în header `X-Access-Code` — fără el, hub-ul
    întoarce 404. Dacă nu îl avem (în mod normal nu îl avem la provisioning),
    încercăm cu codul implicit din firmware ("284095") şi cu absenţa lui.

    Returnează IP-ul hub-ului sau None.
    """
    try:
        import requests
    except ImportError:
        return None

    own_ip = _local_ipv4()
    if not own_ip:
        return None

    # /24 (255.255.255.0) — acoperă tipic LAN-ul de acasă.
    net = ipaddress.IPv4Network(own_ip + "/24", strict=False)
    candidates = [str(h) for h in net.hosts() if str(h) != own_ip]

    code = access_code or "284095"
    headers = {"X-Access-Code": code}

    def probe(ip: str) -> Optional[str]:
        try:
            r = requests.get(f"http://{ip}/status",
                             headers=headers, timeout=0.8)
            # Hub-ul răspunde 200 OK cu un JSON care conţine cheile
            # specifice firmware-ului ("ports" + "channel"). Filtrăm strict
            # pe acestea ca să nu confundăm cu alte servicii HTTP din LAN.
            if r.status_code == 200 \
                    and "ports" in r.text and "channel" in r.text:
                return ip
        except requests.RequestException:
            pass
        return None

    deadline = time.monotonic() + timeout_total_s
    with ThreadPoolExecutor(max_workers=64) as pool:
        futures = {pool.submit(probe, ip): ip for ip in candidates}
        for fut in as_completed(futures, timeout=timeout_total_s):
            if time.monotonic() > deadline:
                break
            try:
                ip = fut.result()
            except Exception:   # noqa: BLE001
                ip = None
            if ip:
                # Anulăm restul probelor; le lăsăm să curgă în fundal.
                return ip
    return None


# ---------------------------------------------------------------- backend: real (bleak)

class RealHub:
    """
    Implementare reală cu bleak. Vorbeşte cu un ESP32 care rulează un server
    GATT cu serviciul/caracteristicile definite mai sus.

    Necesită:  pip install bleak
    """

    def __init__(self):
        try:
            import bleak  # noqa: F401
        except ImportError as e:
            raise RuntimeError(
                "Biblioteca 'bleak' nu este instalată. "
                "Rulează: pip install bleak"
            ) from e

    # -- scanare ---------------------------------------------------

    def scan(self) -> list[dict]:
        """Scanează BLE şi returnează doar dispozitivele numite 'Dropwise HUB'."""
        return _run_async(self._scan_async())

    async def _scan_async(self) -> list[dict]:
        from bleak import BleakScanner

        found: list[dict] = []
        # discover() cu return_adv ne dă şi datele de advertisement (RSSI).
        devices = await BleakScanner.discover(
            timeout=SCAN_DURATION_S, return_adv=True
        )
        for device, adv in devices.values():
            name = adv.local_name or device.name or ""
            if name.strip() == HUB_ADVERTISED_NAME:
                found.append({
                    "name": name.strip(),
                    "address": device.address,
                    "rssi": adv.rssi,
                })
        return found

    # -- provisioning ---------------------------------------------

    def provision(self, job: ProvisioningJob, address: str,
                  ssid: str, password: str) -> None:
        """Rulează provisioning-ul real (blocant — apelat din thread de fundal)."""
        try:
            _run_async(self._provision_async(job, address, ssid, password))
        except Exception as e:   # noqa: BLE001 — orice eroare BLE
            # 1. Dacă hub-ul a confirmat deja prin BLE, ignorăm excepţia
            #    (vine din închiderea BLE post-restart ESP).
            if job.status == "success":
                return
            # 2. Dacă am ajuns măcar să scriem credenţialele înainte să cadă
            #    BLE-ul, e foarte probabil că hub-ul A REUŞIT să se conecteze
            #    la WiFi, dar notificarea s-a pierdut (radio-ul ESP partajat
            #    între WiFi şi BLE — vezi nota din `discover_hub_on_lan`).
            #    Încercăm fallback: căutăm hub-ul pe LAN după IP.
            if job.status == "waiting":
                job.update(status="waiting",
                           message="BLE deconectat. Caut hub-ul pe reţea…")
                ip = discover_hub_on_lan()
                if ip:
                    job.update(status="success", hub_ip=ip,
                               message=f"Hub conectat la reţea. IP: {ip}")
                    return
            job.update(status="error",
                       message=f"Eroare BLE: {e}")

    async def _provision_async(self, job: ProvisioningJob, address: str,
                               ssid: str, password: str) -> None:
        from bleak import BleakClient

        job.update(status="connecting", ssid=ssid,
                   message=f"Conectare BLE la {address}…")

        # Eveniment setat când soseşte notificarea de status de la ESP32.
        result_ready = asyncio.Event()
        result_payload: dict = {}

        def on_status_notify(_char, data: bytearray) -> None:
            """
            Callback pentru caracteristica NOTIFY.
            Firmware-ul ESP32 trimite text UTF-8 în formatul:
                "OK <ip>"        — conectat, urmează IP-ul
                "FAIL <motiv>"   — conectarea a eşuat
            Mesajele intermediare ("Se incearca conectarea la WiFi…") trebuie
            IGNORATE — nu sunt verdict final, doar progres informativ.
            """
            text = bytes(data).decode("utf-8", errors="replace").strip()
            upper = text.upper()
            if upper.startswith("OK"):
                parts = text.split(maxsplit=1)
                result_payload["ok"] = True
                result_payload["ip"] = parts[1].strip() if len(parts) > 1 else None
                result_ready.set()
            elif upper.startswith("FAIL"):
                parts = text.split(maxsplit=1)
                result_payload["ok"] = False
                result_payload["reason"] = (
                    parts[1].strip() if len(parts) > 1 else "motiv necunoscut"
                )
                result_ready.set()
            else:
                # Mesaj intermediar — îl propagăm doar ca update de progres
                # (nu schimbă starea jobului ca să nu-l "termine" prematur).
                if text:
                    job.update(message=text)

        # Pornim un mic HTTP server local — hub-ul va POST la el imediat după
        # ce se conectează la WiFi, prin reţea (nu mai depindem de BLE care
        # moare în timpul `WiFi.begin`). Trimitem URL-ul prin BLE ca al 3-lea
        # câmp din payload: "SSID\nPAROLA\nCALLBACK_URL".
        callback = _ProvisioningCallback()
        callback.start()
        own_ip = _local_ipv4() or "127.0.0.1"
        callback_url = callback.callback_url(own_ip)

        try:
            async with BleakClient(address) as client:
                # 1. Abonare la notificările de status ÎNAINTE de a scrie
                #    credenţialele — ca să nu pierdem o notificare rapidă.
                await client.start_notify(CHAR_STATUS_UUID, on_status_notify)

                # 2. Scriem credenţialele în caracteristica WRITE.
                #    Format: "SSID\nPAROLA\nCALLBACK_URL" codat UTF-8.
                job.update(status="connecting",
                           message="Transmitere credenţiale WiFi către hub…")
                payload = f"{ssid}\n{password}\n{callback_url}".encode("utf-8")
                await client.write_gatt_char(CHAR_CREDENTIALS_UUID, payload,
                                             response=True)

                # 3. Aşteptăm pe AMBELE canale, care e mai rapid câştigă:
                #    a) notify BLE (firmware vechi, sau ESP suficient de rapid)
                #    b) callback HTTP (firmware nou, sau BLE murit deja)
                job.update(status="waiting",
                           message="Credenţiale trimise. Aştept confirmarea de la hub…")

                http_done = asyncio.Event()
                http_ip: dict = {}

                def _wait_http():
                    ip = callback.wait(timeout_s=WIFI_CONFIRM_TIMEOUT_S)
                    if ip:
                        http_ip["ip"] = ip
                    asyncio.get_event_loop().call_soon_threadsafe(http_done.set)

                loop = asyncio.get_event_loop()
                http_thread = threading.Thread(target=_wait_http, daemon=True)
                http_thread.start()

                done, _ = await asyncio.wait(
                    [asyncio.create_task(result_ready.wait()),
                     asyncio.create_task(http_done.wait())],
                    timeout=WIFI_CONFIRM_TIMEOUT_S,
                    return_when=asyncio.FIRST_COMPLETED,
                )

                # 4. Decidem rezultatul.
                if http_ip.get("ip"):
                    job.update(status="success", hub_ip=http_ip["ip"],
                               message=f"Hub conectat la reţea. IP: {http_ip['ip']}")
                elif result_payload.get("ok"):
                    ip = result_payload.get("ip")
                    if not ip:
                        job.update(status="error",
                                   message="Hub conectat, dar nu a raportat un IP valid.")
                    else:
                        job.update(status="success", hub_ip=ip,
                                   message=f"Hub conectat la reţea. IP: {ip}")
                elif result_payload.get("ok") is False:
                    reason = result_payload.get("reason", "motiv necunoscut")
                    job.update(status="error",
                               message=f"Hub-ul nu s-a putut conecta: {reason}")
                else:
                    # Nici BLE nici HTTP — timeout total.
                    job.update(status="error",
                               message="Hub-ul nu a confirmat conectarea în timpul alocat.")

                # Oprim notificările — best effort.
                try:
                    await client.stop_notify(CHAR_STATUS_UUID)
                except Exception:   # noqa: BLE001
                    pass
        finally:
            callback.stop()


# ---------------------------------------------------------------- helper async

def _run_async(coro):
    """
    Rulează o corutină într-un event loop nou.
    Apelat din thread-uri de fundal care nu au un loop asyncio propriu.
    """
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ---------------------------------------------------------------- fabrică backend

def _get_backend():
    """Returnează instanţa de backend potrivită modului curent."""
    if get_mode() == "real":
        return RealHub()
    return SimulatedHub()


# ---------------------------------------------------------------- API public

def scan_for_hubs() -> list[dict]:
    """
    Scanează BLE pentru hub-uri Dropwise. Blocant (~2-6s).
    Returnează listă de dict-uri: {name, address, rssi}.
    """
    return _get_backend().scan()


def start_provisioning(address: str, ssid: str, password: str) -> ProvisioningJob:
    """
    Porneşte provisioning-ul într-un thread de fundal şi returnează imediat
    job-ul de urmărit. Frontend-ul interoghează apoi get_job(job.id).
    """
    job = _register_job()
    backend = _get_backend()

    def _worker():
        try:
            backend.provision(job, address, ssid, password)
        except Exception as e:   # noqa: BLE001 — siguranţă suplimentară
            job.update(status="error", message=f"Eroare neaşteptată: {e}")

    threading.Thread(target=_worker, name=f"provision-{job.id}",
                     daemon=True).start()
    return job

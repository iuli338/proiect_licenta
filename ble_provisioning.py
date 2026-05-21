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
import os
import threading
import time
import uuid
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
        except Exception as e:   # noqa: BLE001 — orice eroare BLE => job error
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
            """
            text = bytes(data).decode("utf-8", errors="replace").strip()
            if text.upper().startswith("OK"):
                parts = text.split(maxsplit=1)
                result_payload["ok"] = True
                result_payload["ip"] = parts[1].strip() if len(parts) > 1 else None
            else:
                parts = text.split(maxsplit=1)
                result_payload["ok"] = False
                result_payload["reason"] = (
                    parts[1].strip() if len(parts) > 1 else "motiv necunoscut"
                )
            result_ready.set()

        async with BleakClient(address) as client:
            # 1. Abonare la notificările de status ÎNAINTE de a scrie
            #    credenţialele — ca să nu pierdem o notificare rapidă.
            await client.start_notify(CHAR_STATUS_UUID, on_status_notify)

            # 2. Scriem credenţialele în caracteristica WRITE.
            #    Format: "SSID\nPAROLA" codat UTF-8.
            job.update(status="connecting",
                       message="Transmitere credenţiale WiFi către hub…")
            payload = f"{ssid}\n{password}".encode("utf-8")
            await client.write_gatt_char(CHAR_CREDENTIALS_UUID, payload,
                                         response=True)

            # 3. Aşteptăm notificarea de la ESP32 (conectare WiFi + DHCP).
            job.update(status="waiting",
                       message="Credenţiale trimise. Hub-ul încearcă să se conecteze la WiFi…")
            try:
                await asyncio.wait_for(result_ready.wait(),
                                       timeout=WIFI_CONFIRM_TIMEOUT_S)
            except asyncio.TimeoutError:
                job.update(status="error",
                           message="Hub-ul nu a confirmat conectarea în timpul alocat.")
                return
            finally:
                # Oprim notificările indiferent de rezultat.
                try:
                    await client.stop_notify(CHAR_STATUS_UUID)
                except Exception:   # noqa: BLE001
                    pass

        # 4. Interpretăm rezultatul.
        if result_payload.get("ok"):
            ip = result_payload.get("ip")
            if not ip:
                job.update(status="error",
                           message="Hub conectat, dar nu a raportat un IP valid.")
                return
            job.update(status="success", hub_ip=ip,
                       message=f"Hub conectat la reţea. IP: {ip}")
        else:
            reason = result_payload.get("reason", "motiv necunoscut")
            job.update(status="error",
                       message=f"Hub-ul nu s-a putut conecta: {reason}")


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

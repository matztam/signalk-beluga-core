"""
BLE peripheral for signalk-beluga-core.
Implements the BLE GATT peripheral for initial app pairing.

Configuration via environment variables (all optional):
  ORCA_DEVICE_NAME      e.g. "orca-demo01"  (default: orca-orca01)
  ORCA_WIFI_SSID        e.g. "myhomewifi"   (default: "")
  ORCA_FIRMWARE_VERSION e.g. "2026.3.1"     (default: 2026.3.1)
  ORCA_MODEL            e.g. "ORCA Core"    (default: ORCA Core)

BLE service and characteristic UUIDs:
  00001901    primary service
  00006a01    device name
  00006a02    serial number
  00006a03    model
  00006a04    software version
  00006a05    wifi SSID
  00002a26    firmware revision (standard GATT UUID)

The standard DIS service (0x180A) is intentionally NOT registered —
BlueZ owns it internally; registering it via bless causes the GATT
server to fail before reading any characteristics.

Apple Watch pairing (three pieces, all required — see FINDINGS in the
debug package):
  1. A NoInputNoOutput "just works" org.bluez.Agent1 is registered so the
     watch can bond without user interaction and the IRK is exchanged.
  2. Characteristics require an encrypted link to read. An unpaired watch
     reads only the device-name characteristic (6a01) and then stalls — it
     never initiates pairing on its own, so the agent is never invoked.
     Demanding encryption makes that first read return ATT "Insufficient
     Authentication/Encryption", which forces the watch to start SMP pairing.
  3. Each device is marked Trusted as soon as it pairs. A paired-but-untrusted
     device is rejected by BlueZ when it reconnects under a new Resolvable
     Private Address (RPA), so without this the watch falls back to reading
     only 6a01 again on the next address rotation.
The iPhone talks to the core over WiFi and is unaffected by any of this.

Note: requires bless and dbus-next in the plugin's .venv.
If GATT connections time out, restart BlueZ: sudo systemctl restart bluetooth
"""

import asyncio
import logging
import os

from bless import (
    BlessServer,
    BlessGATTCharacteristic,
    GATTCharacteristicProperties,
    GATTAttributePermissions,
)
from dbus_next.aio import MessageBus
from dbus_next.constants import BusType
from dbus_next.service import ServiceInterface, method
from dbus_next.signature import Variant

log = logging.getLogger("orca-ble")

# ── Configuration ─────────────────────────────────────────────────────────────

DEVICE_NAME      = os.environ.get("ORCA_DEVICE_NAME",      "orca-orca01")
WIFI_SSID        = os.environ.get("ORCA_WIFI_SSID",         "")
FIRMWARE_VERSION = os.environ.get("ORCA_FIRMWARE_VERSION",  "2026.3.1")
MODEL            = os.environ.get("ORCA_MODEL",             "ORCA Core")
SERIAL_NUMBER    = DEVICE_NAME[5:]

# ── BLE service + characteristics ─────────────────────────────────────────────

BLE_SERVICE_UUID = "00001901-0000-1000-8000-00805F9B34FB"

_characteristics = {
    "00006A01-0000-1000-8000-00805F9B34FB": DEVICE_NAME.encode(),
    "00006A02-0000-1000-8000-00805F9B34FB": SERIAL_NUMBER.encode(),
    "00006A03-0000-1000-8000-00805F9B34FB": MODEL.encode(),
    "00006A04-0000-1000-8000-00805F9B34FB": FIRMWARE_VERSION.encode(),
    "00006A05-0000-1000-8000-00805F9B34FB": WIFI_SSID.encode(),
    "00002A26-0000-1000-8000-00805F9B34FB": FIRMWARE_VERSION.encode(),
}

# ── Pairing agent ─────────────────────────────────────────────────────────────

AGENT_PATH       = "/org/bluez/orca_agent"
AGENT_CAPABILITY = "NoInputNoOutput"


class PairingAgent(ServiceInterface):
    """org.bluez.Agent1 "just works" agent — auto-accepts pairing/authorization.

    NoInputNoOutput capability means BlueZ never asks for a passkey/confirmation;
    returning normally from each callback accepts. This lets the Apple Watch bond
    without any user interaction, so the IRK is exchanged and the bond survives the
    watch's RPA rotation.
    """

    def __init__(self):
        super().__init__("org.bluez.Agent1")

    @method()
    def Release(self):
        log.info("Agent: Release")

    @method()
    def RequestPinCode(self, device: "o") -> "s":
        log.info("Agent: RequestPinCode %s", device)
        return "0000"

    @method()
    def DisplayPinCode(self, device: "o", pincode: "s"):
        log.info("Agent: DisplayPinCode %s %s", device, pincode)

    @method()
    def RequestPasskey(self, device: "o") -> "u":
        log.info("Agent: RequestPasskey %s", device)
        return 0

    @method()
    def DisplayPasskey(self, device: "o", passkey: "u", entered: "q"):
        log.info("Agent: DisplayPasskey %s %06u entered=%u", device, passkey, entered)

    @method()
    def RequestConfirmation(self, device: "o", passkey: "u"):
        log.info("Agent: RequestConfirmation %s %06u → accept", device, passkey)

    @method()
    def RequestAuthorization(self, device: "o"):
        log.info("Agent: RequestAuthorization %s → accept", device)

    @method()
    def AuthorizeService(self, device: "o", uuid: "s"):
        log.info("Agent: AuthorizeService %s %s → accept", device, uuid)

    @method()
    def Cancel(self):
        log.info("Agent: Cancel")


async def _register_agent(bus):
    """Export the agent and make it the default. Best-effort: failures are logged
    but never abort BLE startup. The bus must stay connected for the agent to work."""
    try:
        agent = PairingAgent()
        bus.export(AGENT_PATH, agent)
        intro = await bus.introspect("org.bluez", "/org/bluez")
        obj   = bus.get_proxy_object("org.bluez", "/org/bluez", intro)
        mgr   = obj.get_interface("org.bluez.AgentManager1")
        await mgr.call_register_agent(AGENT_PATH, AGENT_CAPABILITY)
        try:
            await mgr.call_request_default_agent(AGENT_PATH)
        except Exception as e:
            log.warning("RequestDefaultAgent failed (continuing): %s", e)
        log.info("Pairing agent registered (%s) at %s", AGENT_CAPABILITY, AGENT_PATH)
        return agent
    except Exception as e:
        log.warning("Pairing agent registration skipped: %s", e)
        return None


async def _unregister_agent(bus):
    try:
        intro = await bus.introspect("org.bluez", "/org/bluez")
        obj   = bus.get_proxy_object("org.bluez", "/org/bluez", intro)
        mgr   = obj.get_interface("org.bluez.AgentManager1")
        await mgr.call_unregister_agent(AGENT_PATH)
        log.info("Pairing agent unregistered")
    except Exception as e:
        log.warning("Pairing agent unregister skipped: %s", e)


# ── Auto-trust ────────────────────────────────────────────────────────────────


def _unwrap(value):
    """dbus-next hands property values back as Variants in some paths and bare
    values in others; normalise to the underlying value."""
    return value.value if hasattr(value, "value") else value


async def _trust_device(bus, path):
    """Set Device1.Trusted=true so the bond survives the watch's RPA rotation.
    BlueZ refuses the reconnect of a paired-but-untrusted device, leaving the
    watch able to read only 6a01 again. Best-effort."""
    try:
        intro = await bus.introspect("org.bluez", path)
        obj   = bus.get_proxy_object("org.bluez", path, intro)
        props = obj.get_interface("org.freedesktop.DBus.Properties")
        await props.call_set("org.bluez.Device1", "Trusted", Variant("b", True))
        log.info("Device trusted: %s", path)
    except Exception as e:
        log.warning("Trusting %s skipped: %s", path, e)


async def _watch_and_trust(bus):
    """Watch BlueZ for devices that finish pairing and mark them Trusted.

    The NoInputNoOutput agent makes the watch bond, but a paired-yet-untrusted
    device is rejected by BlueZ when it reconnects under a new RPA — so the watch
    falls back to reading only the device name. Marking the device Trusted as soon
    as it pairs makes the bond durable across address rotation. Best-effort: any
    failure is logged and never aborts BLE startup."""

    attached = set()

    async def _maybe_trust(path, dev_props):
        if _unwrap(dev_props.get("Paired")) and not _unwrap(dev_props.get("Trusted")):
            await _trust_device(bus, path)

    async def _attach(path):
        """Listen for this device's Paired flag flipping true after the fact.
        Idempotent: the watch's RPA rotation re-adds the same path repeatedly, so
        attach the PropertiesChanged handler at most once per path to avoid leaking
        handlers (and duplicate trust tasks) over a long session."""
        if path in attached:
            return
        attached.add(path)
        try:
            intro = await bus.introspect("org.bluez", path)
            obj   = bus.get_proxy_object("org.bluez", path, intro)
            props = obj.get_interface("org.freedesktop.DBus.Properties")

            def _on_changed(iface, changed, invalidated):
                if iface == "org.bluez.Device1" and "Paired" in changed:
                    asyncio.create_task(_maybe_trust(path, changed))

            props.on_properties_changed(_on_changed)
        except Exception as e:
            log.warning("Trust watch attach %s skipped: %s", path, e)

    try:
        intro = await bus.introspect("org.bluez", "/")
        obj   = bus.get_proxy_object("org.bluez", "/", intro)
        mgr   = obj.get_interface("org.freedesktop.DBus.ObjectManager")

        def _on_added(path, interfaces):
            dev = interfaces.get("org.bluez.Device1")
            if dev is not None:
                asyncio.create_task(_attach(path))
                asyncio.create_task(_maybe_trust(path, dev))

        mgr.on_interfaces_added(_on_added)

        # Devices already present (e.g. bonded in a previous session).
        objects = await mgr.call_get_managed_objects()
        for path, interfaces in objects.items():
            dev = interfaces.get("org.bluez.Device1")
            if dev is not None:
                await _attach(path)
                await _maybe_trust(path, dev)
        log.info("Device trust watcher active")
    except Exception as e:
        log.warning("Device trust watcher skipped: %s", e)


def _read_request(characteristic: BlessGATTCharacteristic, **kwargs) -> bytearray:
    val = _characteristics.get(characteristic.uuid.upper(), b"")
    log.info("BLE read ← %s → %r", characteristic.uuid, val)
    return bytearray(val)


def _write_request(characteristic: BlessGATTCharacteristic, value: bytearray, **kwargs):
    log.info("BLE write → %s value=%s", characteristic.uuid, bytes(value).hex())


async def _configure_adapter():
    try:
        bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        intro = await bus.introspect("org.bluez", "/org/bluez/hci0")
        obj   = bus.get_proxy_object("org.bluez", "/org/bluez/hci0", intro)
        props = obj.get_interface("org.freedesktop.DBus.Properties")
        await props.call_set("org.bluez.Adapter1", "Powered",             Variant("b", True))
        await props.call_set("org.bluez.Adapter1", "Discoverable",        Variant("b", True))
        await props.call_set("org.bluez.Adapter1", "DiscoverableTimeout", Variant("u", 0))
        await props.call_set("org.bluez.Adapter1", "Pairable",            Variant("b", True))
        await props.call_set("org.bluez.Adapter1", "PairableTimeout",     Variant("u", 0))
        try:
            await props.call_set("org.bluez.Adapter1", "Connectable", Variant("b", True))
        except Exception:
            pass
        bus.disconnect()
        log.info("Adapter configured: Discoverable=on Pairable=on")
    except Exception as e:
        log.warning("Adapter config skipped: %s", e)


async def run():
    await _configure_adapter()

    # Persistent system-bus connection for the pairing agent and trust watcher —
    # must outlive registration so BlueZ can call back for the whole session.
    agent_bus = None
    agent = None
    try:
        agent_bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        # Keep a strong reference to the exported agent for the whole session.
        agent = await _register_agent(agent_bus)
        await _watch_and_trust(agent_bus)
    except Exception as e:
        log.warning("Agent bus setup skipped: %s", e)

    server = BlessServer(name="ORCA")
    server.read_request_func  = _read_request
    server.write_request_func = _write_request

    # Require encryption to read so the first read forces SMP pairing (see the
    # module docstring). The iPhone uses WiFi and is unaffected.
    read_perm = (
        GATTAttributePermissions.readable
        | GATTAttributePermissions.read_encryption_required
    )
    await server.add_new_service(BLE_SERVICE_UUID)
    for uuid, val in _characteristics.items():
        await server.add_new_characteristic(
            BLE_SERVICE_UUID, uuid,
            GATTCharacteristicProperties.read,
            bytearray(val),
            read_perm,
        )

    await server.start()
    log.info("BLE advertising as 'ORCA' — deviceName=%s  wifiSsid=%s", DEVICE_NAME, WIFI_SSID)

    try:
        await asyncio.Event().wait()
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    finally:
        # Tear the agent down in its own guard so a disconnect error can never
        # skip server.stop() — stopping the GATT server / advertising matters most.
        try:
            if agent_bus is not None:
                await _unregister_agent(agent_bus)
                agent_bus.disconnect()
        except Exception as e:
            log.warning("Agent bus teardown failed: %s", e)
        await server.stop()
        log.info("BLE stopped")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(run())

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
        try:
            await props.call_set("org.bluez.Adapter1", "Connectable", Variant("b", True))
        except Exception:
            pass
        bus.disconnect()
        log.info("Adapter configured: Discoverable=on")
    except Exception as e:
        log.warning("Adapter config skipped: %s", e)


async def run():
    await _configure_adapter()

    server = BlessServer(name="ORCA")
    server.read_request_func  = _read_request
    server.write_request_func = _write_request

    await server.add_new_service(BLE_SERVICE_UUID)
    for uuid, val in _characteristics.items():
        await server.add_new_characteristic(
            BLE_SERVICE_UUID, uuid,
            GATTCharacteristicProperties.read,
            bytearray(val),
            GATTAttributePermissions.readable,
        )

    await server.start()
    log.info("BLE advertising as 'ORCA' — deviceName=%s  wifiSsid=%s", DEVICE_NAME, WIFI_SSID)

    try:
        await asyncio.Event().wait()
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
    finally:
        await server.stop()
        log.info("BLE stopped")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(run())

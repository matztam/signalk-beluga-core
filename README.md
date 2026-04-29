# signalk-beluga-core

A [SignalK](https://signalk.org/) plugin that emulates an [ORCA Core](https://www.theorca.com/) marine sensor hub.
It makes the ORCA app (`com.theorca.slate`) connect to your SignalK server.

## What it does

| Component | Port | Description |
|-----------|------|-------------|
| BLE advertisement | — | Announces the device so the ORCA app can find it for initial pairing |
| mDNS | — | Publishes `_extractor-http._tcp` and `_extractor-ws._tcp` services for app discovery |
| REST API | 8088 | Handles all ORCA app HTTP endpoints (`/v1/devices`, `/v1/sources`, `/v1/nmea2000/status`, …) |
| UI stub | 8080 | Responds to `/info` so the app skips its boot delay |
| WebSocket | 8089 | Streams sensor deltas (`/v1/sensors/delta`) and AIS deltas (`?ns=ais`) to the app |

SignalK paths are read from the running server via `app.getSelfPath()` and translated into the flat key format the ORCA app expects.

## Requirements

- **Linux with BlueZ** — required for BLE pairing (standard path); not needed when using Direct-AP mode
- **Python 3** (`python3` on `PATH`) — BLE is implemented via the `bless` library (Python), which talks to BlueZ over D-Bus; there is no viable Node.js alternative (bleno conflicts with bluetoothd at the HCI level)
- Node.js ≥ 18
- SignalK server

## Installation

```bash
cd ~/.signalk
npm install /path/to/signalk-beluga-core
```

After any `npm install` in `~/.signalk/`, reinstall the plugin if it disappears from the plugin list:

```bash
cd ~/.signalk && npm install /path/to/signalk-beluga-core
```

Python dependencies (`bless`, `dbus-next`) are installed automatically into a plugin-local `.venv` on first start. No manual pip install needed.

## Configuration

Open the SignalK plugin settings page and configure:

| Option | Default | Description |
|--------|---------|-------------|
| `deviceId` | `orca01` | 6 alphanumeric characters — becomes `orca-<deviceId>` |
| `wifiSsid` | `""` | Must match the phone's current WiFi SSID for BLE pairing |
| `firmwareVersion` | `2026.3.1` | Firmware version reported to the ORCA app |
| `model` | `ORCA Core` | Model name shown in the app |
| `enableBle` | `true` | Disable on systems without BlueZ |
| `deltaIntervalMs` | `1000` | WebSocket update interval in milliseconds |

## Pairing the ORCA app

### Standard path (BLE + mDNS)

1. Make sure the phone and the SignalK host are on the **same WiFi network**.
2. Set `wifiSsid` in the plugin config to that network's SSID.
3. Close the GNOME Bluetooth settings panel (or similar application) if it is open — it creates a persistent scan session in BlueZ that causes GATT connection timeouts (see [BLE troubleshooting](#ble-troubleshooting)).
4. Start the plugin. The device appears in the ORCA app's pairing screen ".
5. After BLE pairing the app switches to mDNS → REST → WebSocket automatically.

### Alternative path: Direct-AP mode (no BLE, no mDNS required)

If the phone's current WiFi SSID matches the pattern **`orca-[a-zA-Z0-9]+`** (e.g. `orca-demo01`), the app skips BLE pairing and mDNS discovery entirely and connects directly to **`10.11.12.1`** on port 8088/8089.



To use this mode:

1. Create a WiFi access point with an SSID matching `orca-XXXXXX` (e.g. `orca-demo01`).
2. Assign the SignalK host the IP address **`10.11.12.1`** on that network.
3. Connect the phone to that WiFi network.
4. Open the ORCA app — it connects immediately without BLE or mDNS.

This is the most reliable setup for a dedicated boat network (e.g. Raspberry Pi as access point) and completely eliminates the BLE requirement.

## BLE troubleshooting

**Symptom:** The device appears in the BLE scanner but the ORCA app shows "BleError: Device disconnected" after ~5 seconds.

**Cause:** BlueZ has a lingering scan session (most commonly left by the GNOME Bluetooth configuration panel). About 17 ms after the GATT connection is established, BlueZ sends an `LE Set Extended Scan Enable` command that triggers a supervision timeout (HCI error `0x08`) and drops the connection.

**Diagnosis:**
```bash
sudo btmon 2>&1 | grep -E "Connect|Disconn|Scan Enable|Error"
# Look for "LE Set Extended Scan Enable" shortly after "LE Connection Complete"
```

Confirm a foreign scan session:
```bash
bluetoothctl scan off
# If it prints "org.bluez.Error.Failed" instead of "Discovery stopped", another process owns the scan
```

**Fix:**
```bash
sudo systemctl restart bluetooth
```

This clears all stale BlueZ state. The ORCA app can then complete GATT pairing successfully.

**Note:** `@abandonware/bleno` (Node.js) conflicts with `bluetoothd` at the HCI level and does **not** work alongside BlueZ. Use the included Python/bless approach instead.

## SignalK → ORCA key mapping

The WebSocket mapper (`lib/mapper.js`) covers navigation, GNSS, COG/SOG, heading, attitude, depth, water speed, temperature, pressure, wind, propulsion, battery banks, fluid tanks, rudder, and autopilot. Data is sent event-driven — each incoming SignalK delta triggers an immediate forward to connected ORCA app clients, rate-limited to the interval the app requests via `?interval=`.

## License

GNU Affero General Public License v3.0 (AGPL-3.0-only).

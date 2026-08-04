# signalk-beluga-core

A [SignalK](https://signalk.org/) plugin that emulates an ORCA Core marine sensor hub.
It makes the ORCA app (`com.theorca.slate`) connect to your SignalK server.

## What it does

| Component | Port | Description |
|-----------|------|-------------|
| BLE advertisement | — | Announces the device so the ORCA app can find it for initial pairing |
| mDNS | — | Publishes `_extractor-http._tcp` and `_extractor-ws._tcp` services for app discovery |
| REST API | 8088 | Handles all ORCA app HTTP endpoints (`/v1/devices`, `/v1/sources`, `/v1/nmea2000/status`, …) |
| UI stub | 8080 | Responds to `/info` so the app skips its boot delay |
| WebSocket | 8089 | Streams sensor deltas (`/v1/sensors/delta`) and AIS deltas (`?ns=ais`) to the app |
| Radar REST | 9081 | Handles `/v1/radars` and radar command/status endpoints _(only when mayara host is configured)_ |
| Radar WebSocket | 9089 | Streams radar spoke frames (`/v1/spokes/:id/delta`) to the app _(only when mayara host is configured)_ |

SignalK paths are read from the running server via `app.getSelfPath()` and translated into the flat key format the ORCA app expects.

## Routes

The ORCA app sends the route it is navigating to the Core on `PUT /v1/navigation/route`, as a GeoJSON `FeatureCollection` containing one `LineString`.

The app sends it when navigation starts or changes, not on a timer, so after a SignalK restart there is no route to show until the app next changes one.

Enable `publishRoutes` to store those routes in the SignalK resources API, which makes them visible to the rest of the server — chart plotters such as Freeboard, for instance — and editable there. Off by default, since writing to the server's resources is opt-in, and it needs a routes resource provider; without one the push is still answered normally and the plugin reports the error on its config page.

Each distinct route is stored **once, and then never touched again**. Renaming is the reason it is not rewritten: the app re-sends its route on every change, so a plugin that kept the entry in sync would overwrite your name the next time you nudged a waypoint.

The starting name comes from the app's own timestamp for the route, in server-local time, e.g. `ORCA 2026-08-03 20:19`, falling back to the time it arrived if the app sends none. Note that this is when the route was last *edited*, not when you started navigating it — one drawn yesterday and sailed today carries yesterday's name. It is also not unique: the resolution is minutes. It is a starting point, and you are meant to rename it to something you recognise.

A route is recognised by the `hash` the app sends with it and by a digest of its geometry, matching on either. So:

- Sending the same route again does nothing.
- Changing the route in the app stores a **new** route alongside the old one. Both stay.
- Cancelling navigation in the app removes nothing.

**Routes accumulate, and there is no limit.** The app re-sends on every change, so an evening of planning with a few waypoints nudged leaves a handful of near-identical routes with names a minute apart. Deleting is left to you, in Freeboard or through the resources API. That is a deliberate trade: the alternative loses routes you renamed and meant to keep.

Note that this stores routes, it does not navigate them. Which route is *active* is decided by whatever is actually navigating — the app itself, or a chart plotter — and reaches SignalK through the Course API, not through here.

## Radar support

Radar data is forwarded from a [mayara-server](https://github.com/MarineYachtRadar/mayara-server) instance. Configure the mayara-server host and port in the plugin settings to enable radar. beluga-core connects directly to mayara's REST and WebSocket API — no mayara SignalK plugin required. Spokes are re-encoded and sent to the ORCA app once per antenna revolution. If no mayara host is configured, the radar ports are not opened. Discovery is retried every 15 seconds if the radar is not yet transmitting.

## Requirements

- **Linux with BlueZ** — required for BLE pairing (standard path); not needed when using Direct-AP mode
- **mayara-server** — required only for radar support; must be reachable from the SignalK host over HTTP/WebSocket
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
| `deviceId` | generated | 6 alphanumeric characters — becomes `orca-<deviceId>`. Generated on first start and kept |
| `wifiSsid` | `""` | **Required.** Must match the phone's current WiFi SSID for BLE pairing |
| `firmwareVersion` | `2026.25.1` | Firmware version reported to the ORCA app |
| `model` | `ORCA Core` | Model name shown in the app |
| `enableBle` | `true` | Disable on systems without BlueZ |
| `deltaIntervalMs` | `1000` | WebSocket update interval in milliseconds |
| `ignoreAppInterval` | `false` | Ignore the update interval the app asks for and keep the one above |
| `publishRoutes` | `false` | Store routes the app sends into SignalK resources |
| `mayaraHost` | `""` | Hostname or IP of the mayara-server instance. Leave empty to disable radar. |
| `mayaraPort` | `6502` | mayara-server REST/WebSocket port |

## Pairing the ORCA app

### Standard path (BLE + mDNS)

1. Make sure the phone and the SignalK host are on the **same WiFi network**.
2. Set `wifiSsid` in the plugin config to that network's SSID.
3. Close the GNOME Bluetooth settings panel (or similar application) if it is open — it creates a persistent scan session in BlueZ that causes GATT connection timeouts (see [BLE troubleshooting](#ble-troubleshooting)).
4. Start the plugin. The device appears in the ORCA app's pairing screen.
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

This clears all stale BlueZ state. The ORCA app can then read the advertisement characteristics without the connection dropping.

**Note:** `@abandonware/bleno` (Node.js) conflicts with `bluetoothd` at the HCI level and does **not** work alongside BlueZ. Use the included Python/bless approach instead.

**Symptom:** The phone shows a Bluetooth pairing request (on both Android and iOS) shortly after connecting, which never completes.

**Cause (partial):** None of the advertised characteristics require encryption and the plugin never registers a pairing agent, but BlueZ's `Adapter1.Pairable` property defaults to `true`. The plugin sets `Pairable = false` on the adapter at startup, which stops the phone's own OS from starting a bonding attempt — but a pairing prompt can still appear from a second, unrelated cause below.

**Cause (main one, confirmed via `btmon`):** right after the advertisement characteristics are read, BlueZ tries to upgrade the connection to [EATT](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Assigned_Numbers/out/en/Assigned_Numbers.pdf) (Enhanced ATT, an L2CAP channel on PSM 39/0x27 that lets multiple GATT requests run concurrently — standard BlueZ behavior since Bluetooth 5.2, not something this plugin asks for). The phone's OS refuses that channel with "insufficient authentication", and BlueZ reacts to *that* refusal by sending a Security Request — which is the pairing prompt, and which can never complete since nothing here handles pairing.

**Fix:** disable EATT system-wide in `/etc/bluetooth/main.conf`:
```ini
[GATT]
Channels = 1
```
Then `sudo systemctl restart bluetooth`. This is a BlueZ daemon setting, not something the plugin can turn off per-connection over D-Bus — it has to be set on the host before the plugin starts, and it affects every Bluetooth application on the machine, not just this one.

## SignalK → ORCA key mapping

The WebSocket mapper (`lib/mapper.js`) covers navigation, GNSS, COG/SOG, heading, attitude, depth, water speed, temperature, pressure, wind, propulsion, battery banks, fluid tanks, rudder, and autopilot. Data is sent event-driven — each incoming SignalK delta triggers an immediate forward to connected ORCA app clients, rate-limited to the interval the app requests via `?interval=`.

## License

GNU Affero General Public License v3.0 (AGPL-3.0-only).

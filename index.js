'use strict'

const { spawnSync } = require('child_process')
const fs    = require('fs')
const Ble   = require('./lib/ble')
const Api   = require('./lib/api')
const Ws    = require('./lib/websocket')
const Mdns  = require('./lib/mdns')
const Radar = require('./lib/radar')

const MAIN_CONF = '/etc/bluetooth/main.conf'

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const ID_RE    = /^[a-zA-Z0-9]{6}$/

function randomDeviceId () {
  return Array.from({ length: 6 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join('')
}

function busyPorts (ports) {
  const result = spawnSync('ss', ['-tln'], { encoding: 'utf8' })
  if (result.error) return []
  return ports.filter(p => result.stdout.includes(`:${p} `) || result.stdout.includes(`:${p}\n`))
}

function checkBleRequirements () {
  const missing = []
  const py = spawnSync('python3', ['--version'], { stdio: 'pipe' })
  if (py.error || py.status !== 0) { missing.push('python3 not found'); return missing }
  const venv = spawnSync('python3', ['-c', 'import venv'], { stdio: 'pipe' })
  if (venv.error || venv.status !== 0) missing.push('python3-venv not installed')
  const bt = spawnSync('bluetoothctl', ['--version'], { stdio: 'pipe' })
  if (bt.error || bt.status !== 0) missing.push('BlueZ not found')
  return missing
}

// BlueZ's EATT (a parallel ATT channel most phones refuse without an
// established bond) is on by default. The refusal makes BlueZ send a
// Security Request, which surfaces as a BLE pairing prompt on the phone —
// harmless (nothing here needs bonding, the app connects fine either way)
// but confusing to see. Only /etc/bluetooth/main.conf can turn EATT off
// (there's no per-connection or per-adapter D-Bus knob for it), so this
// just reads the file to warn instead of silently living with the prompt.
function eattLikelyOn () {
  let conf
  try { conf = fs.readFileSync(MAIN_CONF, 'utf8') } catch { return false }
  const gatt = conf.match(/\[GATT\]([\s\S]*?)(\n\[|$)/)
  if (!gatt) return true // section absent → BlueZ default (EATT on) applies
  const channels = gatt[1].match(/^\s*Channels\s*=\s*(\d+)/m)
  if (!channels) return true // commented out / unset → default of 3 applies
  return parseInt(channels[1], 10) !== 1
}

module.exports = function (app) {
  const plugin = {
    id:          'signalk-beluga-core',
    name:        'Beluga Core — ORCA Core Emulator',
    description: 'Emulates an ORCA Core device: BLE advertisement, mDNS, REST API (port 8088), WebSocket sensor stream (port 8089).'
  }

  let ble, api, wsServer, mdns, radar
  let statusText = ''

  const SCHEMA_PROPS = {
    deviceId: {
      type:        'string',
      title:       'Device ID (6 alphanumeric characters)',
      description: 'The device appears in the ORCA app as orca-<deviceId>. Auto-generated on first start. Changing the ID requires re-pairing the app.',
      pattern:     '^[a-zA-Z0-9]{6}$'
    },
    wifiSsid: {
      type:        'string',
      title:       'WiFi SSID',
      description: 'Must match the WiFi network the phone is connected to. Included in the BLE advertisement so the app knows which network to use after pairing. Not needed in Direct-AP mode.',
      default:     ''
    },
    firmwareVersion: {
      type:    'string',
      title:   'Firmware version reported to the ORCA app',
      default: '2026.25.1'
    },
    model: {
      type:    'string',
      title:   'Model name',
      default: 'ORCA Core'
    },
    _bleHeader: {
      type:  'null',
      title: 'Bluetooth'
    },
    enableBle: {
      type:        'boolean',
      title:       'Enable BLE advertisement',
      description: 'BLE is required for initial pairing — once the app recognises the device it connects via mDNS/REST/WebSocket and Bluetooth is no longer needed. Requires BlueZ and Python 3. Alternative without BLE: Direct-AP mode — connect the phone to a WiFi network with SSID matching orca-XXXXXX and assign the SignalK host the IP 10.11.12.1.',
      default:     true
    },
    deltaIntervalMs: {
      type:        'number',
      title:       'Default WebSocket send interval (ms)',
      description: 'How often sensor data is pushed to the app. The app may request a different rate via ?interval= — see "Ignore app interval" below.',
      default:     1000
    },
    ignoreAppInterval: {
      type:        'boolean',
      title:       'Ignore the interval requested by the app',
      description: 'When enabled, every incoming SignalK delta is forwarded immediately, ignoring the ?interval= parameter. Useful for testing; may increase CPU usage.',
      default:     false
    },
    _routeHeader: {
      type:  'null',
      title: 'Routes'
    },
    publishRoutes: {
      type:        'boolean',
      title:       'Publish routes from the app to SignalK',
      description: 'The ORCA app sends the route it is navigating to the Core. Store it in SignalK resources so the rest of the server — Freeboard, for instance — can display and edit it. Each distinct route is stored once, under a name you are meant to change in Freeboard; re-sending a route already stored leaves it untouched, so the name you gave it survives. Cancelling navigation in the app does not remove anything. Requires a routes resource provider.',
      default:     false
    },
    _radarHeader: {
      type:  'null',
      title: 'Radar (mayara)'
    },
    mayaraHost: {
      type:        'string',
      title:       'mayara-server host',
      description: 'Hostname or IP of the mayara-server instance. Leave empty to disable radar support.',
      default:     ''
    },
    mayaraPort: {
      type:        'number',
      title:       'mayara-server port',
      description: 'Port of the mayara-server REST/WebSocket API.',
      default:     6502
    }
  }

  // SignalK calls plugin.schema() / plugin.uiSchema() on every /plugins API
  // request when they are functions — enables live status on the config page.
  plugin.schema = function () {
    const props = statusText
      ? { _status: { type: 'null', title: statusText }, ...SCHEMA_PROPS }
      : SCHEMA_PROPS
    return {
      type:        'object',
      description: 'Documentation and source: https://github.com/matztam/signalk-beluga-core',
      required:    ['wifiSsid'],
      properties:  props
    }
  }

  plugin.uiSchema = function () {
    const ui = {
      _bleHeader:   { 'ui:classNames': 'mt-4' },
      _radarHeader: { 'ui:classNames': 'mt-4' },
      _routeHeader: { 'ui:classNames': 'mt-4' },
    }
    if (statusText) {
      const alertClass = statusText.startsWith('⛔') ? 'alert alert-danger'
        : statusText.includes('⚠')                  ? 'alert alert-warning'
        :                                              'alert alert-success'
      ui._status = { 'ui:classNames': alertClass + ' p-2 mb-2' }
    }
    return ui
  }

  plugin.start = function (options) {
    const mayaraHost = options.mayaraHost || ''
    const mayaraPort = options.mayaraPort || 6502
    const wantRadar  = !!mayaraHost

    const busy = busyPorts([8080, 8088, 8089, ...(wantRadar ? [9081, 9089] : [])])
    if (busy.length > 0) {
      const msg = `Port${busy.length > 1 ? 's' : ''} already in use: ${busy.join(', ')} — stop the conflicting service and restart the plugin`
      statusText = `⛔ ${msg}`
      app.setPluginError(msg)
      return
    }

    // Auto-generate a unique device ID on first start and persist it so it
    // stays stable across restarts. Duplicates across installations would
    // cause the ORCA app to confuse devices.
    let deviceId = options.deviceId
    if (!deviceId || !ID_RE.test(deviceId)) {
      deviceId = randomDeviceId()
      // The callback is not optional: the server calls it unconditionally after writing.
      app.savePluginOptions({ ...options, deviceId }, () => {})
      app.debug(`Generated device ID: ${deviceId}`)
    }

    const deviceName      = `orca-${deviceId}`
    const firmwareVersion = options.firmwareVersion || '2026.25.1'
    const model           = options.model || 'ORCA Core'
    const wifiSsid        = options.wifiSsid || ''
    const deltaIntervalMs = options.deltaIntervalMs || 1000

    const ignoreAppInterval = options.ignoreAppInterval === true

    const publishRoutes = options.publishRoutes === true
    const ctx = { app, deviceId, deviceName, firmwareVersion, model, wifiSsid, deltaIntervalMs, ignoreAppInterval, mayaraHost, mayaraPort, publishRoutes }

    let wantBle   = options.enableBle !== false
    let bleWarning = ''
    if (wantBle) {
      const missing = checkBleRequirements()
      if (missing.length > 0) {
        bleWarning = ` ⚠ BLE disabled (${missing.join(', ')}) — app discovery via mDNS only`
        wantBle = false
      } else if (eattLikelyOn()) {
        bleWarning = ' ⚠ phone may show a Bluetooth pairing request during BLE discovery — ' +
          'safe to ignore, pairing is not required and the app connects normally either way ' +
          '(set Channels=1 under [GATT] in /etc/bluetooth/main.conf to stop it appearing)'
      }
    }

    mdns     = new Mdns(ctx)
    api      = new Api(ctx)
    wsServer = new Ws(ctx)
    radar    = wantRadar ? new Radar(ctx) : null
    ble      = wantBle ? new Ble(ctx) : null

    mdns.start()
    api.start()
    wsServer.start()
    if (radar) radar.start()

    let bleStatus = ''
    if (ble) {
      ble.start()
      bleStatus = ' + BLE'
    }

    const restPorts    = wantRadar ? ':8088/:9081' : ':8088'
    const wsPorts      = wantRadar ? ':8089/:9089' : ':8089'
    const radarWarning = wantRadar ? '' : ' ⚠ no radar (mayara host not configured)'
    const runMsg = `Running — ${deviceName} | UI :8080 | REST ${restPorts} | WS ${wsPorts} | mDNS${bleStatus}`
    statusText = `✅ ${runMsg}${bleWarning}${radarWarning}`
    app.setPluginStatus(runMsg)
  }

  plugin.stop = function () {
    if (ble)      { ble.stop();      ble      = null }
    if (radar)    { radar.stop();    radar    = null }
    if (wsServer) { wsServer.stop(); wsServer = null }
    if (api)      { api.stop();      api      = null }
    if (mdns)     { mdns.stop();     mdns     = null }
    statusText = ''
    app.setPluginStatus('Stopped')
  }

  return plugin
}

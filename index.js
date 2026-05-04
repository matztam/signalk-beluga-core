'use strict'

const { spawnSync } = require('child_process')
const Ble  = require('./lib/ble')
const Api  = require('./lib/api')
const Ws   = require('./lib/websocket')
const Mdns = require('./lib/mdns')

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

module.exports = function (app) {
  const plugin = {
    id:          'signalk-beluga-core',
    name:        'Beluga Core — ORCA Core Emulator',
    description: 'Emulates an ORCA Core device: BLE advertisement, mDNS, REST API (port 8088), WebSocket sensor stream (port 8089).'
  }

  let ble, api, wsServer, mdns
  let statusText = ''

  const SCHEMA_PROPS = {
    deviceId: {
      type:    'string',
      title:   'Device ID (6 alphanumeric characters) — leave empty to auto-generate a unique ID on first start',
      pattern: '^[a-zA-Z0-9]{6}$'
    },
    wifiSsid: {
      type:    'string',
      title:   "WiFi SSID (must match the phone's current WiFi network)",
      default: ''
    },
    firmwareVersion: {
      type:    'string',
      title:   'Firmware version reported to the ORCA app',
      default: '2026.3.1'
    },
    model: {
      type:    'string',
      title:   'Model name',
      default: 'ORCA Core'
    },
    enableBle: {
      type:    'boolean',
      title:   'Enable BLE advertisement (requires BlueZ on Linux)',
      default: true
    },
    deltaIntervalMs: {
      type:    'number',
      title:   'Default send interval (ms) — used when the ORCA app does not request a specific rate via ?interval=',
      default: 1000
    },
    ignoreAppInterval: {
      type:    'boolean',
      title:   'Ignore the interval requested by the app — send every SignalK update immediately',
      default: false
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
    if (!statusText) return {}
    const alertClass = statusText.startsWith('⛔') ? 'alert alert-danger'
      : statusText.includes('⚠')                  ? 'alert alert-warning'
      :                                              'alert alert-success'
    return { _status: { 'ui:classNames': alertClass + ' p-2 mb-2' } }
  }

  plugin.start = function (options) {
    const busy = busyPorts([8080, 8088, 8089])
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
      app.savePluginOptions({ ...options, deviceId })
      app.debug(`Generated device ID: ${deviceId}`)
    }

    const deviceName      = `orca-${deviceId}`
    const firmwareVersion = options.firmwareVersion || '2026.3.1'
    const model           = options.model || 'ORCA Core'
    const wifiSsid        = options.wifiSsid || ''
    const deltaIntervalMs = options.deltaIntervalMs || 1000

    const ignoreAppInterval = options.ignoreAppInterval === true
    const ctx = { app, deviceId, deviceName, firmwareVersion, model, wifiSsid, deltaIntervalMs, ignoreAppInterval }

    let wantBle   = options.enableBle !== false
    let bleWarning = ''
    if (wantBle) {
      const missing = checkBleRequirements()
      if (missing.length > 0) {
        bleWarning = ` ⚠ BLE disabled (${missing.join(', ')}) — app discovery via mDNS only`
        wantBle = false
      }
    }

    mdns     = new Mdns(ctx)
    api      = new Api(ctx)
    wsServer = new Ws(ctx)
    ble      = wantBle ? new Ble(ctx) : null

    app.debug('autopilotApi defaultProviderId=%s defaultDeviceId=%s devices=%s',
      app.autopilotApi?.defaultProviderId,
      app.autopilotApi?.defaultDeviceId,
      JSON.stringify([...( app.autopilotApi?.deviceToProvider?.keys() ?? [])])
    )

    mdns.start()
    api.start()
    wsServer.start()

    let bleStatus = ''
    if (ble) {
      ble.start()
      bleStatus = ' + BLE'
    }

    const runMsg = `Running — ${deviceName} | UI :8080 | REST :8088 | WS :8089 | mDNS${bleStatus}`
    statusText = `✅ ${runMsg}${bleWarning}`
    app.setPluginStatus(runMsg)
  }

  plugin.stop = function () {
    if (ble)      { ble.stop();      ble      = null }
    if (wsServer) { wsServer.stop(); wsServer = null }
    if (api)      { api.stop();      api      = null }
    if (mdns)     { mdns.stop();     mdns     = null }
    statusText = ''
    app.setPluginStatus('Stopped')
  }

  return plugin
}

'use strict'

const Ble    = require('./lib/ble')
const Api    = require('./lib/api')
const Ws     = require('./lib/websocket')
const Mdns   = require('./lib/mdns')

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const ID_RE    = /^[a-zA-Z0-9]{6}$/

function randomDeviceId () {
  return Array.from({ length: 6 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join('')
}

module.exports = function (app) {
  const plugin = {
    id:          'signalk-beluga-core',
    name:        'Beluga Core — ORCA Core Emulator',
    description: 'Emulates an ORCA Core device: BLE advertisement, mDNS, REST API (port 8088), WebSocket sensor stream (port 8089).'
  }

  let ble, api, wsServer, mdns

  plugin.schema = {
    type:     'object',
    required: ['wifiSsid'],
    properties: {
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
  }

  plugin.start = function (options) {
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

    mdns     = new Mdns(ctx)
    api      = new Api(ctx)
    wsServer = new Ws(ctx)
    ble      = options.enableBle !== false ? new Ble(ctx) : null

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
      const bleOk = ble.start()
      if (bleOk === false) return  // setPluginError already called
      bleStatus = ' + BLE'
    }

    app.setPluginStatus(`Running — ${deviceName} | REST :8088 | WS :8089 | mDNS${bleStatus}`)
  }

  plugin.stop = function () {
    if (ble)      { ble.stop();      ble      = null }
    if (wsServer) { wsServer.stop(); wsServer = null }
    if (api)      { api.stop();      api      = null }
    if (mdns)     { mdns.stop();     mdns     = null }
    app.setPluginStatus('Stopped')
  }

  return plugin
}

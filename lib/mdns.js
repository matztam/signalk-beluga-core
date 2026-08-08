'use strict'

const { Bonjour } = require('bonjour-service')
const os          = require('os')

const HTTP_PORT = 8088
const WS_PORT   = 8089
const UI_PORT   = 8080

function localIp () {
  const ifaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/^wl/.test(name)) {
      const a = addrs.find(a => a.family === 'IPv4' && !a.internal)
      if (a) return a.address
    }
  }
  for (const addrs of Object.values(ifaces)) {
    const a = addrs.find(a => a.family === 'IPv4' && !a.internal)
    if (a) return a.address
  }
  return '127.0.0.1'
}

class Mdns {
  constructor (ctx) {
    this.ctx      = ctx
    this._bonjour = null
  }

  start () {
    const { app, deviceId, deviceName, firmwareVersion } = this.ctx
    const ip   = localIp()
    const txt  = { deviceName, deviceId, version: firmwareVersion }
    // mDNS service name must be "<deviceName> ORCA" for the app to recognise it
    const name = `${deviceName} ORCA`
    const host = `${deviceName}.local`

    // On a fresh boot this plugin can start before the network interface is
    // fully up (observed: ENETUNREACH sending to the mDNS multicast group
    // right after systemd brings the service up). bonjour-service's default
    // error handler is `(err) => { throw err }`, and most of its internal
    // send() callbacks are silently no-ops otherwise, so an unreachable
    // network here would otherwise crash the whole plugin process rather
    // than just skip an announcement. Route both to app.debug instead.
    const onMdnsError = (err) => app.debug(`mDNS error (non-fatal): ${err.message}`)
    this._bonjour = new Bonjour({}, onMdnsError)
    this._bonjour.server.mdns.on('warning', onMdnsError)

    const services = [
      { type: 'http',           port: UI_PORT,   label: 'UI stub'   },
      { type: 'extractor-http', port: HTTP_PORT,  label: 'REST API'  },
      { type: 'extractor-ws',   port: WS_PORT,    label: 'WebSocket' },
    ]

    for (const { type, port, label } of services) {
      this._bonjour.publish({ name, type, port, txt, host })
      app.debug(`mDNS: _${type}._tcp.local → ${ip}:${port}  (${label})`)
    }
  }

  stop () {
    if (this._bonjour) {
      this._bonjour.unpublishAll()
      this._bonjour.destroy()
      this._bonjour = null
    }
  }
}

module.exports = Mdns

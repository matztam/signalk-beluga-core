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

// The ENETUNREACH multicast-dns can throw while a network interface isn't up
// yet (observed on boot) does NOT go through bonjour-service's errorCallback
// or the underlying socket's 'error'/'warning' events — it comes from inside
// Node's own dgram internals (doSend/afterDns), a known Node limitation (see
// nodejs/node#28664, nodejs/node#12841: errors from the async DNS-resolution
// phase of a send() bypass both try/catch and the socket's error listener).
// The only place left to catch it is a process-wide uncaughtException
// handler, scoped tightly to this exact error so it doesn't swallow anything
// unrelated — signalk-server's own top-level handler already keeps the
// process alive either way, this just avoids logging it as a bare,
// plugin-less "Uncaught exception".
function isUnreachableMdnsSend (err) {
  return err && err.code === 'ENETUNREACH' && err.syscall === 'send' && err.port === 5353
}

class Mdns {
  constructor (ctx) {
    this.ctx      = ctx
    this._bonjour = null
    this._onUncaught = null
  }

  start () {
    const { app, deviceId, deviceName, firmwareVersion } = this.ctx
    const ip   = localIp()
    const txt  = { deviceName, deviceId, version: firmwareVersion }
    // mDNS service name must be "<deviceName> ORCA" for the app to recognise it
    const name = `${deviceName} ORCA`
    const host = `${deviceName}.local`

    // Covers respondToQuery()'s own error path and any other warning the
    // library emits normally — real, but doesn't catch the boot-time
    // ENETUNREACH case above, hence the separate uncaughtException handler.
    const onMdnsError = (err) => app.debug(`mDNS error (non-fatal): ${err.message}`)
    this._bonjour = new Bonjour({}, onMdnsError)
    this._bonjour.server.mdns.on('warning', onMdnsError)

    this._onUncaught = (err) => {
      // Must never re-throw: throwing from inside an uncaughtException
      // handler crashes the process outright, even if another handler
      // (signalk-server's own) would otherwise have kept it alive. For
      // anything that isn't our known case, just do nothing here — the
      // other registered listeners still run either way.
      if (isUnreachableMdnsSend(err)) app.debug(`mDNS: network unreachable, will retry (${err.message})`)
    }
    process.on('uncaughtException', this._onUncaught)

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
    if (this._onUncaught) {
      process.removeListener('uncaughtException', this._onUncaught)
      this._onUncaught = null
    }
    if (this._bonjour) {
      this._bonjour.unpublishAll()
      this._bonjour.destroy()
      this._bonjour = null
    }
  }
}

module.exports = Mdns

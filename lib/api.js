'use strict'

const express = require('express')
const os      = require('os')

const { randomUUID } = require('crypto')

const {
  extractRoute, toSignalKRoute, routeLength, routeIdentities, defaultRouteName, storedIdentities
} = require('./route')

const HTTP_PORT = 8088
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

function wlanStatus () {
  const ifaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/^wl/.test(name)) {
      const a = addrs.find(a => a.family === 'IPv4' && !a.internal)
      if (a) return { connected: true, ip: a.address }
    }
  }
  return { connected: false }
}

class Api {
  constructor (ctx) {
    this.ctx      = ctx
    this._servers = []
    // Route publishing runs one at a time. Two pushes arriving together would otherwise both read
    // the stored routes before either had written, both conclude the route is new, and both store
    // it — the duplicate this whole path exists to avoid.
    this._routeWork = Promise.resolve()
    // Identities stored during this run. The resources API is not a reliable enough mirror to be
    // asked twice: listResources resolves through Promise.allSettled and silently drops a provider
    // that rejects, so a failing provider reads as "no routes stored", and setResource resolves
    // before the provider has written, so a list taken straight afterwards can still miss the
    // route. Either one turns every push into a fresh copy. Remembering what we wrote closes both,
    // for as long as the process lives.
    this._storedIdentities = new Set()
    this._stopped = false
  }

  // Archive the route the app is navigating into the SignalK resources API. Runs detached from the
  // request: the app is waiting on the PUT, and a slow or missing resource provider must not hold
  // it up.
  //
  // A route the app has sent before is left exactly as it is, which is the whole point: the user
  // renames it in Freeboard, and re-sending the same route must not overwrite that name. So a
  // route is written once, under an id of its own, and never updated. The app re-sends on every
  // change of its own route, so writing on each push would otherwise mean the name survived until
  // the next re-route and no longer.
  async _publishRoute (route) {
    const { app, publishRoutes } = this.ctx
    if (!publishRoutes || this._stopped) { return }

    const identities = routeIdentities(route)
    if (identities.some(i => this._storedIdentities.has(i))) {
      app.debug('navigation/route: already stored in this run')
      return
    }

    let existing
    try {
      existing = await app.resourcesApi.listResources('routes', {})
    } catch (e) {
      // Only thrown when no routes provider is registered at all — a provider that fails to list
      // is dropped silently and reads as an empty result instead. So this is the "nothing can be
      // stored" case, not a general read failure, and the run-local set above is what covers the
      // silent one.
      app.setPluginError(`Could not read routes to publish the ORCA route: ${e.message}`)
      return
    }

    for (const [id, res] of Object.entries(existing || {})) {
      const stored = storedIdentities(res)
      if (identities.some(i => stored.includes(i))) {
        app.debug(`navigation/route: already stored as routes/${id}`)
        identities.forEach(i => this._storedIdentities.add(i))
        return
      }
    }

    if (this._stopped) { return }

    const id = randomUUID()
    // Claimed before the write, not after: setResource resolves early, so a second push can arrive
    // while this one is still on its way to disk.
    identities.forEach(i => this._storedIdentities.add(i))
    try {
      const arrivedAt = Number.isFinite(route.updatedAt) ? route.updatedAt : Date.now()
      await app.resourcesApi.setResource('routes', id,
        toSignalKRoute(route, defaultRouteName(arrivedAt)))
      app.debug(`navigation/route: published as routes/${id}`)
    } catch (e) {
      // Only the failures the resources API actually reports: a bad id, schema validation, or no
      // provider for writing. A provider that fails to write does not reject, so a silent write
      // failure leaves the identity claimed and the route unstored until the plugin restarts.
      identities.forEach(i => this._storedIdentities.delete(i))
      app.setPluginError(`Could not publish the ORCA route: ${e.message}`)
    }
  }

  // Navigation stopped. Nothing to do: the stored routes are a library, not a mirror of what the
  // app is doing right now, and deleting one here would throw away a route the user may have
  // renamed and kept on purpose.
  async _clearRoute () {
    this.ctx.app.debug('navigation/route: navigation cancelled, stored routes left alone')
  }

  start () {
    const { app, deviceId, deviceName, firmwareVersion } = this.ctx

    // ── REST API :8088 ───────────────────────────────────────────────────────
    const rest = express()
    rest.use(express.json())

    rest.get('/v1/sensors/full', (req, res) => {
      res.json({ data: { timestamp: new Date().toISOString(), deviceName, sensors: {} } })
    })

    rest.get('/v1/devices', (req, res) => {
      const mmsi = app.getSelfPath('mmsi')?.value ?? ''
      res.json({ data: { deviceId, deviceName, version: firmwareVersion, mmsi } })
    })

    rest.get('/v1/settings', (req, res) => res.json({ data: {} }))
    rest.get('/v1/settings/*', (req, res) => res.json({ data: {} }))

    // /v1/sources must use response.value wrapper, not response.data
    rest.get('/v1/sources', (req, res) => {
      res.json({ value: { sources: [{ id: 'nmea0183', type: 'NMEA0183', active: true }] } })
    })
    // empty value → update skipped
    rest.put('/v1/sources', (req, res) => res.json({ value: {} }))
    rest.post('/v1/sources', (req, res) => res.json({ value: {} }))

    // state must NOT be wrapped in "data" — read directly by the app
    rest.get('/v1/nmea2000/status', (req, res) => {
      res.json({ value: { state: 0, active: true, interface: 'can0' } })
    })

    rest.get('/v1/autopilots/modes', async (req, res) => {
      const apApi = app.autopilotApi
      if (!apApi?.defaultProviderId) return res.json({})
      try {
        const provider = apApi.autopilotProviders.get(apApi.defaultProviderId)
        const info     = await provider.getData(apApi.defaultDeviceId)
        const stateMap = {
          standby: 0, auto: 1, 'heading-control': 1,
          'no-drift': 2, track: 2, route: 3, nav: 3, wind: 7
        }
        const modes    = [...new Set(
          info.options.states.map(s => stateMap[s.name]).filter(m => m != null)
        )]
        const features = info.options.actions?.some(a => a.id === 'tack') ? ['tack'] : []
        res.json([{ type: 0, modes, features }])
      } catch (e) {
        app.debug(`autopilots/modes error: ${e.message}`)
        res.json({})
      }
    })

    // Autopilot commands are routed to source 254 (primary nav source).
    // Mode numbers map to SignalK autopilot states.
    const ORCA_MODE_TO_SK = { 0: 'standby', 1: 'auto', 2: 'no-drift', 3: 'route', 7: 'wind' }

    const apCommand = async (req, res, fn) => {
      const apApi = app.autopilotApi
      if (!apApi?.defaultProviderId) return res.json({ value: {} })
      try {
        const provider = apApi.autopilotProviders.get(apApi.defaultProviderId)
        await fn(provider, apApi.defaultDeviceId)
      } catch (e) {
        app.debug(`autopilot command error: ${e.message}`)
      }
      res.json({ value: {} })
    }

    rest.post('/v1/autopilots/:source/mode', async (req, res) => {
      const skState = ORCA_MODE_TO_SK[req.body?.value]
      if (!skState) return res.json({ value: {} })
      const apApi = app.autopilotApi
      if (!apApi?.defaultProviderId) return res.json({ value: {} })
      try {
        const provider  = apApi.autopilotProviders.get(apApi.defaultProviderId)
        const info      = await provider.getData(apApi.defaultDeviceId)
        const supported = info.options.states.map(s => s.name)
        if (!supported.includes(skState)) {
          app.debug(`autopilot mode '${skState}' not supported (provider supports: ${supported.join(', ')})`)
          return res.json({ value: {} })
        }
        await provider.setState(skState, apApi.defaultDeviceId)
        // Wind mode: optional wind hold angle sent alongside the mode
        const windAngle = req.body?.wind_value
        if (skState === 'wind' && windAngle != null) {
          await provider.setTarget(windAngle, apApi.defaultDeviceId)
        }
      } catch (e) {
        app.debug(`autopilot command error: ${e.message}`)
      }
      res.json({ value: {} })
    })

    rest.post('/v1/autopilots/:source/engage', (req, res) => {
      apCommand(req, res, (p, id) => p.engage(id))
    })

    rest.post('/v1/autopilots/:source/disengage', (req, res) => {
      apCommand(req, res, (p, id) => p.disengage(id))
    })

    // value is in degrees (valid: 1, -1, 10, -10); adjustTarget expects radians
    rest.post('/v1/autopilots/:source/course-change', (req, res) => {
      const deg = req.body?.value
      if (deg == null) return res.json({ value: {} })
      apCommand(req, res, (p, id) => p.adjustTarget(deg * Math.PI / 180, id))
    })

    rest.post('/v1/autopilots/:source/tack', (req, res) => {
      const dir = req.body?.value === 0 ? 'port' : 'starboard'
      apCommand(req, res, (p, id) => p.tack(dir, id))
    })

    rest.get('/v1/recordings/stats', (req, res) => {
      res.json({ data: { batchesCount: 0, recordingsCount: 0, totalSize: 0 } })
    })
    rest.get('/v1/recordings', (req, res) => res.json({ data: { recordings: [] } }))

    rest.get('/v1/eth/default/status', (req, res) => {
      res.json({ data: { connected: true, ip: localIp() } })
    })
    rest.get('/v1/wlan/sta/default/status', (req, res) => {
      res.json({ data: wlanStatus() })
    })
    rest.get('/v1/remote-access/status', (req, res) => {
      res.json({ data: { enabled: false } })
    })

    // The app pushes its active route here when it starts, changes or cancels navigation. Without
    // a handler this fell through to the catch-all below, which answers 200 and drops the body.
    rest.put('/v1/navigation/route', (req, res) => {
      const route = extractRoute(req.body)
      res.json({ value: {} })
      if (route) {
        app.debug(`navigation/route: ${route.coordinates.length} points, ${routeLength(route.coordinates)} m`)
      }
      const work = route ? () => this._publishRoute(route) : () => this._clearRoute()
      this._routeWork = this._routeWork
        .then(work)
        .catch(e => app.debug(`navigation/route: ${e.message}`))
    })

    rest.get('/v1/logbook', (req, res) => res.json({ data: { entries: [] } }))
    rest.get('/v1/historical', (req, res) => res.json({ data: { points: [] } }))
    rest.get('/v1/data', (req, res) => res.json({ data: {} }))
    rest.get('/v1/debug', (req, res) => res.json({ data: { ok: true } }))

    rest.use((req, res) => {
      app.debug(`UNHANDLED ${req.method} ${req.path}  body=${JSON.stringify(req.body).slice(0, 200)}  version_fw=${req.headers['x-version-fw'] ?? '-'}`)
      res.status(200).json({ data: {} })
    })

    this._listen(rest, HTTP_PORT)

    // ── UI stub :8080 ────────────────────────────────────────────────────────
    // App checks GET /info :8080 for uptime.
    // A sufficiently high uptime value skips the app's bootstrap delay.
    const ui = express()
    ui.get('/info', (req, res) => {
      res.json({ uptime: '9999', version: firmwareVersion, version_fw: firmwareVersion, name: deviceName })
    })
    ui.use((req, res) => res.json({ data: {} }))
    this._listen(ui, UI_PORT)
  }

  _listen (expressApp, port) {
    const srv = expressApp.listen(port, () => {
      this.ctx.app.debug(`HTTP listening on :${port}`)
    })
    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        this.ctx.app.setPluginError(`Port ${port} already in use — stop the conflicting service and restart the plugin`)
      }
    })
    this._servers.push(srv)
    return srv
  }

  stop () {
    // Publishing is detached from the request, so work queued before the servers closed would
    // otherwise still be on its way to the resources API and write a route after the plugin was
    // told to stop.
    this._stopped = true
    for (const s of this._servers) s.close()
    this._servers = []
  }
}

module.exports = Api

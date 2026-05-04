'use strict'

const EventEmitter = require('events')
const WebSocket    = require('ws')
const { buildSensorDelta, buildAisDelta } = require('./mapper')

const WS_PORT = 8089

class Ws {
  constructor (ctx) {
    this.ctx          = ctx
    this._wss         = null
    this._events      = new EventEmitter()
    this._deltaHandler = null
  }

  start () {
    const { app, deltaIntervalMs } = this.ctx
    const selfCtx = app.selfContext

    // ── Subscribe to SignalK delta events ─────────────────────────────────
    // app.signalk fires 'delta' for every delta applied to the server state.
    // We use the context to route: self → sensor clients, other vessels → AIS clients.
    this._deltaHandler = (delta) => {
      const ctx = delta?.context
      if (!ctx) return
      if (ctx === selfCtx || ctx === 'vessels.self') {
        this._events.emit('selfUpdate')
      } else if (ctx.startsWith('vessels.')) {
        this._events.emit('aisUpdate')
      }
    }
    app.signalk.on('delta', this._deltaHandler)

    // AIS targets may be updated rarely; ensure clients get at least one
    // refresh per deltaIntervalMs even if no new AIS delta arrives.
    this._aisTimer = setInterval(
      () => this._events.emit('aisUpdate'),
      Math.max(1000, deltaIntervalMs)
    )


    // ── WebSocket server ───────────────────────────────────────────────────
    const wss = new WebSocket.Server({ port: WS_PORT })
    this._wss = wss

    wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        app.setPluginError(`Port ${WS_PORT} already in use — stop the conflicting service and restart the plugin`)
      }
    })

    wss.on('connection', (ws, req) => {
      const url  = new URL(req.url, 'http://localhost')
      const path = url.pathname
      const ns   = url.searchParams.get('ns') ?? ''

      // Determine minimum send interval for this client.
      // ignoreAppInterval: send on every incoming delta, no throttle.
      // Otherwise: respect ?interval= from the app, fall back to deltaIntervalMs.
      const { ignoreAppInterval } = this.ctx
      const minMs = ignoreAppInterval
        ? 0
        : Math.max(100, parseInt(url.searchParams.get('interval') ?? String(deltaIntervalMs)))

      if (path === '/v1/sensors/delta') {
        this._handleSensorDelta(ws, ns, minMs)
      } else if (path === '/v1/sync') {
        this._handleSync(ws)
      } else {
        app.debug(`WS accepted unknown path: ${path}`)
        ws.on('message', msg => app.debug(`WS ← ${path}: ${msg.toString().slice(0, 200)}`))
      }
    })

    app.debug(`WebSocket listening on :${WS_PORT}`)
  }

  // ── Sensor / AIS delta stream ────────────────────────────────────────────
  //
  // Rate-limiting pattern:
  //   - If enough time has passed since the last send → flush immediately.
  //   - Otherwise → schedule one pending flush at the next allowed time.
  //     Subsequent updates while a flush is already pending are absorbed
  //     (the pending flush will send the latest state when it fires).
  //
  _handleSensorDelta (ws, ns, minIntervalMs) {
    const { app, deviceId } = this.ctx
    const isAis     = (ns === 'ais')
    const eventName = isAis ? 'aisUpdate' : 'selfUpdate'

    let lastSentAt   = 0
    let pendingTimer = null

    const flush = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      try {
        const payload = isAis
          ? buildAisDelta(app, deviceId)
          : buildSensorDelta(app, deviceId)
        ws.send(JSON.stringify(payload))
        lastSentAt = Date.now()
      } catch (e) {
        app.debug(`WS send error: ${e.message}`)
      }
    }

    const onUpdate = () => {
      const elapsed = Date.now() - lastSentAt
      if (elapsed >= minIntervalMs) {
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
        flush()
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(() => { pendingTimer = null; flush() }, minIntervalMs - elapsed)
      }
    }

    this._events.on(eventName, onUpdate)

    // Immediate first frame so the app sees data right after connecting.
    flush()

    // Keepalive: only flush if no real data has been sent within the interval.
    const keepalive = setInterval(() => {
      if (Date.now() - lastSentAt >= minIntervalMs) flush()
    }, minIntervalMs)

    const cleanup = () => {
      this._events.off(eventName, onUpdate)
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
      clearInterval(keepalive)
    }
    ws.on('close', cleanup)
    ws.on('error', cleanup)
  }

  // ── Sync channel ─────────────────────────────────────────────────────────
  _handleSync (ws) {
    const { app } = this.ctx
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg?.cmd === 'ping') {
          ws.send(JSON.stringify({ cmd: 'pong' }))
        } else {
          app.debug(`WS /v1/sync ← ${raw.toString().slice(0, 300)}`)
        }
      } catch {
        // ignore malformed frames
      }
    })
  }

  stop () {
    if (this._deltaHandler) {
      this.ctx.app.signalk.removeListener('delta', this._deltaHandler)
      this._deltaHandler = null
    }
    if (this._aisTimer) { clearInterval(this._aisTimer); this._aisTimer = null }
    if (this._wss)      { this._wss.close(); this._wss = null }
    this._events.removeAllListeners()
  }
}

module.exports = Ws

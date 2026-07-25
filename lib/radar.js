'use strict'

const path         = require('path')
const express      = require('express')
const WebSocket    = require('ws')
const protobuf     = require('protobufjs')
const { encode }   = require('@msgpack/msgpack')
const { compress } = require('@mongodb-js/zstd')

const REST_PORT   = 9081
const WS_PORT     = 9089
const FLUSH_MS    = 1000
const RETRY_MS    = 5000
const DISCOVER_MS = 15000

const SK_RADARS   = '/signalk/v2/api/vessels/self/radars'
const PROTO_PATH  = path.join(__dirname, 'RadarMessage.proto')

class Radar {
  constructor (ctx) {
    this.ctx  = ctx
    this._rest = null
    this._wss  = null
    // radarId → { thetaCount, rhoCount, rangeMeters, model, state, pendingSpokes[], lastAngle }
    this._radars  = new Map()
    // radarId → Set<WebSocket>  (ORCA app clients)
    this._clients = new Map()
    // radarId → interval handle
    this._timers  = new Map()
    // radarId → WebSocket  (connection to mayara-server spoke stream)
    this._sources = new Map()
    this._spokeMsgType  = null
    this._stopped       = false
    this._discoverTimer = null
  }

  // ── Public ────────────────────────────────────────────────────────────────

  start () {
    this._startRest()
    this._startWs()
    this._discover()
  }

  stop () {
    this._stopped = true
    if (this._discoverTimer) { clearTimeout(this._discoverTimer); this._discoverTimer = null }
    for (const ws of this._sources.values()) ws.close()
    this._sources.clear()
    for (const t of this._timers.values()) clearInterval(t)
    this._timers.clear()
    if (this._wss)  { this._wss.close();  this._wss  = null }
    if (this._rest) { this._rest.close(); this._rest = null }
    this._clients.clear()
    this._radars.clear()
  }

  pushSpoke (radarId, spoke) {
    this._onSpoke(radarId, spoke)
  }

  // ── REST :9081 ────────────────────────────────────────────────────────────

  _startRest () {
    const { app } = this.ctx
    const rest = express()
    rest.use(express.json())

    rest.get('/v1/radars', (_req, res) => {
      const results = [...this._radars.entries()].map(([id, r]) => ({
        id,
        model:   r.model  || 'Radar',
        state:   r.state  || 'transmitting',
        range:   r.rangeMeters,
        spokes:  r.thetaCount,
        samples: r.rhoCount,
      }))
      app.debug(`Radar GET /v1/radars → ${JSON.stringify(results)}`)
      res.json({ results })
    })

    // Ranges available for this radar (in metres). Used by the app to populate
    // the range selector. Values match common Furuno/Navico range steps.
    rest.get('/v1/radars/:id/ranges', (req, res) => {
      const ranges = [116, 232, 463, 926, 1852, 3704, 7408, 14816, 29632, 44448]
      app.debug(`Radar GET /v1/radars/${req.params.id}/ranges → ${JSON.stringify(ranges)}`)
      res.json({ results: ranges })
    })

    // Dynamic radar detection path (firmware >= 0.27.0): full radar info object
    // passed directly to radarSetInfoAction — no results wrapper.
    rest.get('/v1/radars/:id/info', (req, res) => {
      if (!this._radars.has(req.params.id)) return res.status(404).json({})
      res.json({
        ranges:   [116, 232, 463, 926, 1852, 3704, 7408, 14816, 29632, 44448],
        modes:    [[0, 'harbor'], [1, 'coastal'], [2, 'offshore'], [3, 'weather']],
        features: ['range', 'gain', 'gain_auto', 'preset_mode', 'state',
                   'sea', 'sea_auto', 'rain', 'rain_auto',
                   'timed_transmit', 'time_standby', 'time_transmit'],
      })
    })

    rest.get('/v1/radars/:id/command', (req, res) => {
      const r = this._radars.get(req.params.id)
      if (!r) return res.status(404).json({})
      res.json({ range: r.rangeMeters, state: r.state || 'transmitting' })
    })

    rest.put('/v1/radars/:id/command', (req, res) => {
      const id = req.params.id
      const r  = this._radars.get(id)
      if (!r) return res.status(404).json({})
      app.debug(`Radar ${id} command: ${JSON.stringify(req.body).slice(0, 200)}`)
      this._forwardCommand(id, req.body)
      res.json({})
    })

    rest.put('/v1/radars/:id/status', (req, res) => {
      const id = req.params.id
      const r  = this._radars.get(id)
      if (!r) return res.status(404).json({})
      app.debug(`Radar ${id} status PUT: ${JSON.stringify(req.body).slice(0, 200)}`)
      this._forwardCommand(id, req.body)
      res.json({})
    })

    rest.get('/v1/radars/:id/status', (req, res) => {
      const r = this._radars.get(req.params.id)
      if (!r) return res.json({})
      // state must be numeric: 0=OFF, 1=STANDBY, 8=TRANSMIT
      const STATE_MAP = { transmitting: 8, transmit: 8, standby: 1, warming_up: 2, spinning_up: 7 }
      const state = STATE_MAP[r.state] ?? 1
      res.json({
        state,
        range:      r.rangeMeters,
        preset_mode: 0,
        gain:       50,
        gain_auto:  true,
        sea:        0,
        sea_auto:   false,
        rain:       0,
        rain_auto:  false,
      })
    })

    rest.use((req, res) => {
      app.debug(`Radar REST unhandled: ${req.method} ${req.path}`)
      res.json({})
    })

    const srv = rest.listen(REST_PORT, () => app.debug(`Radar REST :${REST_PORT}`))
    srv.on('error', err => {
      if (err.code === 'EADDRINUSE')
        app.setPluginError(`Radar REST port ${REST_PORT} already in use`)
    })
    this._rest = srv
  }

  // ── WS :9089 ─────────────────────────────────────────────────────────────

  _startWs () {
    const { app } = this.ctx
    const wss = new WebSocket.Server({ port: WS_PORT })
    this._wss = wss

    wss.on('error', err => {
      if (err.code === 'EADDRINUSE')
        app.setPluginError(`Radar WS port ${WS_PORT} already in use`)
    })

    wss.on('connection', (ws, req) => {
      const pathname = new URL(req.url, 'http://x').pathname
      const spokeM   = pathname.match(/^\/v1\/spokes\/([^/]+)\/(delta|full)$/)
      const statusM  = pathname.match(/^\/v1\/status\/([^/]+)/)

      if (spokeM) {
        const radarId = spokeM[1]
        app.debug(`Radar WS: spoke client for ${radarId}`)
        if (!this._clients.has(radarId)) this._clients.set(radarId, new Set())
        this._clients.get(radarId).add(ws)
        this._ensureTimer(radarId)
        const cleanup = () => {
          const set = this._clients.get(radarId)
          if (set) { set.delete(ws); if (set.size === 0) this._clearTimer(radarId) }
        }
        ws.on('close', cleanup)
        ws.on('error', cleanup)
      } else if (statusM) {
        const rawId   = statusM[1]
        // App may append the server address after radarId in the WS path
        const radarId = [...this._radars.keys()].find(id => rawId === id || rawId.startsWith(id)) || rawId
        app.debug(`Radar WS: status client for ${radarId} (raw path segment: ${rawId})`)
        this._handleStatus(ws, radarId)
      } else {
        app.debug(`Radar WS: unknown path ${pathname}`)
        ws.close(1008, 'unknown path')
      }
    })

    app.debug(`Radar WS :${WS_PORT}`)
  }

  // ── Status stream ─────────────────────────────────────────────────────────

  _handleStatus (ws, radarId) {
    const { app } = this.ctx
    const STATE_MAP = { transmitting: 8, transmit: 8, standby: 1, warming_up: 2, spinning_up: 7 }

    const send = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      const r     = this._radars.get(radarId)
      const state = r ? (STATE_MAP[r.state] ?? 1) : 1
      try {
        ws.send(JSON.stringify({
          state,
          preset_mode:  0,
          gain:         50,
          gain_auto:    true,
          range:        r ? r.rangeMeters : 0,
          sea:          0,
          sea_auto:     false,
          rain:         0,
          rain_auto:    false,
          doppler_mode: 0,
          doppler:      false,
        }))
      } catch (e) {
        app.debug(`Radar status send error: ${e.message}`)
      }
    }

    send()
    const timer = setInterval(send, 1000)
    const cleanup = () => clearInterval(timer)
    ws.on('close', cleanup)
    ws.on('error', cleanup)
  }

  // ── Flush ─────────────────────────────────────────────────────────────────

  _ensureTimer (radarId) {}
  _clearTimer (radarId) {}

  async _flush (radarId) {
    const r       = this._radars.get(radarId)
    const clients = this._clients.get(radarId)
    if (!r || !clients || clients.size === 0 || r.pendingSpokes.length === 0) return

    const spokes = r.pendingSpokes.splice(0)
    try {
      const packed = encode([r.thetaCount * r.rhoCount, r.rangeMeters, r.rhoCount, r.thetaCount, spokes])
      const frame  = await compress(Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength))
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame)
      }
    } catch (e) {
      this.ctx.app.debug(`Radar flush error: ${e.message}`)
    }
  }

  // ── Spoke ingestion ───────────────────────────────────────────────────────

  _onSpoke (radarId, spoke) {
    let r = this._radars.get(radarId)
    if (!r) {
      r = {
        thetaCount:    spoke.thetaCount,
        rhoCount:      spoke.rhoCount,
        rangeMeters:   spoke.rangeMeters,
        model:         spoke.model || 'Radar',
        state:         spoke.state || 'transmit',
        pendingSpokes: [],
        lastAngle:     -1,
      }
      this._radars.set(radarId, r)
      this.ctx.app.debug(`Radar ${radarId}: ${r.thetaCount} spokes/scan, ${r.rhoCount} samples`)
    } else {
      r.rangeMeters = spoke.rangeMeters
    }
    const clients = this._clients.get(radarId)
    if (clients && clients.size > 0) {
      // Detect revolution boundary: angle wraps from high → low
      if (r.lastAngle > spoke.bearing && r.lastAngle > r.thetaCount * 0.75) {
        if (r.pendingSpokes.length > 0) this._flush(radarId)
      }
      r.lastAngle = spoke.bearing
      r.pendingSpokes.push([spoke.bearing, spoke.data])
    }
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  async _discover () {
    const { app, mayaraHost, mayaraPort } = this.ctx
    if (this._stopped) return

    if (this._discoverTimer) { clearTimeout(this._discoverTimer); this._discoverTimer = null }

    let radars = []
    try {
      const res = await fetch(`http://${mayaraHost}:${mayaraPort}${SK_RADARS}`)
      if (res.ok) {
        const data = await res.json()
        const entries = Array.isArray(data) ? data.map(r => [r.id, r]) : Object.entries(data)
        radars = await Promise.all(entries.map(async ([id, info]) => {
          let spokesPerRevolution = 2048, maxSpokeLen = 512
          try {
            const capRes = await fetch(`http://${mayaraHost}:${mayaraPort}${SK_RADARS}/${id}/capabilities`)
            if (capRes.ok) {
              const cap = await capRes.json()
              spokesPerRevolution = cap.spokesPerRevolution ?? spokesPerRevolution
              maxSpokeLen = cap.maxSpokeLength ?? maxSpokeLen
            }
          } catch (e) { app.debug(`Radar ${id}: capabilities failed: ${e.message}`) }
          return { id, ...info, spokesPerRevolution, maxSpokeLen }
        }))
      }
    } catch (e) {
      app.debug(`Radar: discovery failed: ${e.message}`)
    }

    app.debug(`Radar: discovered ${radars.length} radar(s): ${JSON.stringify(radars.map(r => r.id))}`)

    if (radars.length && !this._spokeMsgType) {
      try {
        this._spokeMsgType = (await protobuf.load(PROTO_PATH)).lookupType('RadarMessage')
        app.debug('Radar: protobuf loaded')
      } catch (e) {
        app.debug(`Radar: protobuf load failed: ${e.message}`)
      }
    }

    if (this._spokeMsgType) {
      for (const info of radars) this._connect(info)
    } else if (radars.length) {
      app.debug('Radar: protobuf not loaded — no connections attempted')
    }

    if (!this._stopped) {
      this._discoverTimer = setTimeout(() => this._discover(), DISCOVER_MS)
    }
  }

  // ── Spoke stream connection to mayara-server ──────────────────────────────

  _connect (info) {
    const { app, mayaraHost, mayaraPort } = this.ctx
    const radarId    = info.id
    const thetaCount = info.spokesPerRevolution
    const rhoCount   = info.maxSpokeLen

    if (this._sources.has(radarId)) return

    if (!this._radars.has(radarId)) {
      this._radars.set(radarId, {
        thetaCount, rhoCount,
        rangeMeters:   info.range  || 0,
        model:         info.name   || 'Radar',
        state:         info.status || 'standby',
        pendingSpokes: [],
        lastAngle:     -1,
      })
    } else {
      // Re-sync state from mayara on each discovery cycle
      const r = this._radars.get(radarId)
      if (info.status) r.state = info.status
    }

    const url = info.spokeDataUrl || `ws://${mayaraHost}:${mayaraPort}${SK_RADARS}/${radarId}/spokes`
    app.debug(`Radar ${radarId}: connecting to ${url}`)

    const ws = new WebSocket(url)
    ws.binaryType = 'nodebuffer'
    this._sources.set(radarId, ws)

    ws.on('message', (buf) => {
      if (!this._clients.get(radarId)?.size) return
      let msg
      try { msg = this._spokeMsgType.decode(buf) }
      catch (e) { app.debug(`Radar ${radarId}: decode error: ${e.message}`); return }
      for (const s of msg.spokes) {
        this._onSpoke(radarId, {
          bearing: s.angle, data: s.data, rangeMeters: s.range, thetaCount, rhoCount, model: info.name,
        })
      }
    })

    ws.on('error', e => app.debug(`Radar ${radarId}: WS error: ${e.message}`))

    ws.on('close', () => {
      this._sources.delete(radarId)
      if (!this._stopped) {
        app.debug(`Radar ${radarId}: stream closed — retry in ${RETRY_MS}ms`)
        if (this._discoverTimer) { clearTimeout(this._discoverTimer); this._discoverTimer = null }
        this._discoverTimer = setTimeout(() => this._discover(), RETRY_MS)
      }
    })
  }

  // ── Command forwarding to mayara-server ───────────────────────────────────

  _forwardCommand (radarId, cmd) {
    const { app, mayaraHost, mayaraPort } = this.ctx
    const base = `http://${mayaraHost}:${mayaraPort}${SK_RADARS}/${radarId}/controls`

    const put = (control, value) =>
      fetch(`${base}/${control}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ value }),
      }).catch(e => app.debug(`Radar ${radarId}: ${control} failed: ${e.message}`))

    if (cmd.range != null) put('range', cmd.range)

    if (cmd.state != null) {
      const isTransmit = cmd.state === 'transmitting' || cmd.state === 'transmit' || cmd.state === 8
      put('power', isTransmit ? 2 : 1)
      const r = this._radars.get(radarId)
      if (r) r.state = isTransmit ? 'transmit' : 'standby'
    }
  }
}

module.exports = Radar

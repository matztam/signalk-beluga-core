'use strict'

const path         = require('path')
const express      = require('express')
const WebSocket    = require('ws')
const protobuf     = require('protobufjs')
const { encode }   = require('@msgpack/msgpack')
const { compress } = require('@mongodb-js/zstd')

const REST_PORT   = 9081
const WS_PORT     = 9089
const FLUSH_MS    = 200
const RETRY_MS    = 5000
const DISCOVER_MS = 15000

const SK_RADARS   = '/signalk/v2/api/vessels/self/radars'
const PROTO_PATH  = path.join(__dirname, 'RadarMessage.proto')

class Radar {
  constructor (ctx) {
    this.ctx  = ctx
    this._rest = null
    this._wss  = null
    // radarId → { thetaCount, rhoCount, rangeMeters, model, state, pendingSpokes[] }
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
    if (!this.ctx.app.radarApi) {
      this.ctx.app.debug('Radar: app.radarApi not available — skipping radar ports')
      return
    }
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
      res.json([...this._radars.entries()].map(([id, r]) => ({
        id,
        model:   r.model  || 'Radar',
        state:   r.state  || 'transmitting',
        range:   r.rangeMeters,
        spokes:  r.thetaCount,
        samples: r.rhoCount,
      })))
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

    rest.get('/v1/radars/:id/status', (req, res) => {
      const r = this._radars.get(req.params.id)
      res.json(r ? { state: r.state || 'transmitting', range: r.rangeMeters } : {})
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
      const m = new URL(req.url, 'http://x').pathname.match(/^\/v1\/spokes\/([^/]+)\/(delta|full)$/)
      if (!m) { ws.close(1008, 'unknown path'); return }

      const radarId = m[1]
      app.debug(`Radar WS: client for ${radarId}`)

      if (!this._clients.has(radarId)) this._clients.set(radarId, new Set())
      this._clients.get(radarId).add(ws)
      this._ensureTimer(radarId)

      const cleanup = () => {
        const set = this._clients.get(radarId)
        if (set) { set.delete(ws); if (set.size === 0) this._clearTimer(radarId) }
      }
      ws.on('close', cleanup)
      ws.on('error', cleanup)
    })

    app.debug(`Radar WS :${WS_PORT}`)
  }

  // ── Flush ─────────────────────────────────────────────────────────────────

  _ensureTimer (radarId) {
    if (!this._timers.has(radarId)) {
      this._timers.set(radarId, setInterval(() => this._flush(radarId), FLUSH_MS))
    }
  }

  _clearTimer (radarId) {
    const t = this._timers.get(radarId)
    if (t) { clearInterval(t); this._timers.delete(radarId) }
  }

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
      }
      this._radars.set(radarId, r)
      this.ctx.app.debug(`Radar ${radarId}: ${r.thetaCount} spokes/scan, ${r.rhoCount} samples`)
    } else {
      r.rangeMeters = spoke.rangeMeters
    }
    const clients = this._clients.get(radarId)
    if (clients && clients.size > 0) r.pendingSpokes.push([spoke.bearing, spoke.data])
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  async _discover () {
    const { app } = this.ctx
    if (this._stopped) return

    if (this._discoverTimer) { clearTimeout(this._discoverTimer); this._discoverTimer = null }

    let radars = []
    try {
      radars = await app.radarApi.getRadars()
    } catch (e) {
      app.debug(`Radar: getRadars() failed: ${e.message}`)
    }

    if (radars.length && !this._spokeMsgType) {
      try {
        this._spokeMsgType = (await protobuf.load(PROTO_PATH)).lookupType('RadarMessage')
      } catch (e) {
        app.debug(`Radar: protobuf load failed: ${e.message}`)
      }
    }

    if (this._spokeMsgType) {
      for (const info of radars) this._connect(info)
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
      })
    }

    const url = `ws://${mayaraHost}:${mayaraPort}${SK_RADARS}/${radarId}/spokes`
    app.debug(`Radar ${radarId}: connecting to ${url}`)

    const ws = new WebSocket(url)
    ws.binaryType = 'nodebuffer'
    this._sources.set(radarId, ws)

    ws.on('message', (buf) => {
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
      const isTransmit = cmd.state === 'transmitting' || cmd.state === 'transmit'
      // mayara-server stores power as 2 = transmit, 1 = standby
      put('power', isTransmit ? 2 : 1)
      const r = this._radars.get(radarId)
      if (r) r.state = isTransmit ? 'transmit' : 'standby'
    }
  }
}

module.exports = Radar

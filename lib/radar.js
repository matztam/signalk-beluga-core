'use strict'

const path         = require('path')
const express      = require('express')
const WebSocket    = require('ws')
const protobuf     = require('protobufjs')
const { encode }   = require('@msgpack/msgpack')

const REST_PORT   = 9081
const WS_PORT     = 9089
const FLUSH_MS    = 1000
const RETRY_MS    = 5000
const DISCOVER_MS = 15000
const STATE_MS    = 1000

const SK_RADARS   = '/signalk/v2/api/vessels/self/radars'
const PROTO_PATH  = path.join(__dirname, 'RadarMessage.proto')

// ORCA numeric power states. mayara reports 'off' | 'standby' | 'transmit';
// 'transmitting' and the spin-up values are kept for older/other providers.
const STATE_MAP = {
  off: 0, standby: 1, warming_up: 2, spinning_up: 7, transmit: 8, transmitting: 8,
}

// mayara's `power` control value → the state name used above.
const POWER_STATE = { 0: 'off', 1: 'standby', 2: 'transmit' }

// Doppler wire contract, established by analyzing traffic com.theorca.slate 2026.31.1 <-> Core firmware 2026.29.1
// ORCA supports Doppler natively only for Raymarine Quantum, but the path is
// generic: the app derives, from what the radar server reports,
//   isDopplerFeatureAvailable = info.features.includes('doppler')
//   isDopplerSupported        = featureAvailable && status.doppler >= 0
//   isDopplerEnabled          = featureAvailable && status.doppler >  0
// reading status.doppler (RadarDopplerActive) and status.doppler_mode
// (RadarDopplerMode). So a HALO shows Doppler once we advertise the feature and
// send both fields — capability alone is not enough, state alone is not enough.
const RADAR_DOPPLER_ACTIVE = { UNSUPPORTED: -1, OFF: 0, ON: 1 }
const RADAR_DOPPLER_MODE   = { OFF: 0, APPROACHING: 1, RECEDING: 2, BOTH: 3 }

// The ORCA app's Doppler threshold set (RADAR_RECEIVER_DOPPLER_THRESHOLDS)
// carves these two intensities out of the returns band and colours them:
// approaching red, receding green. Normal returns must never reach them.
const DOPPLER_APPROACHING_PIXEL = 255
const DOPPLER_RECEDING_PIXEL    = 254

// mayara's `doppler` control (DopplerMode) is None=0, Both=1, Approaching=2 —
// note Navico has no receding-only. Map both directions to ORCA's enum.
const MAYARA_TO_ORCA_DOPPLER = {
  0: RADAR_DOPPLER_MODE.OFF,
  1: RADAR_DOPPLER_MODE.BOTH,
  2: RADAR_DOPPLER_MODE.APPROACHING,
}
const ORCA_TO_MAYARA_DOPPLER = {
  [RADAR_DOPPLER_MODE.OFF]:         0,
  [RADAR_DOPPLER_MODE.APPROACHING]: 2,
  [RADAR_DOPPLER_MODE.RECEDING]:    1, // no receding-only on Navico → Both
  [RADAR_DOPPLER_MODE.BOTH]:        1,
}

// Used only when the radar does not report its own preset modes.
const FALLBACK_MODES  = [[0, 'custom'], [1, 'harbor'], [2, 'offshore'], [3, 'buoy'], [4, 'weather']]
const FALLBACK_RANGES = [116, 232, 463, 926, 1852, 3704, 7408, 14816, 29632, 44448]

// mayara reports preset modes as `{ "1": "Harbor", "0": "Custom", … }` on the
// mode control. Turn that into the [[value, label], …] pairs the app expects,
// ordered by value.
//
// These were hardcoded as harbor/coastal/offshore/weather for 0..3, which does
// not match any Navico radar: a HALO is custom/harbor/offshore/buoy/weather/
// bird/bird+ over 0..6. Selecting "harbor" in the app therefore set Custom, and
// three of the four labels were wrong.
function parseModes (descriptions) {
  if (!descriptions || typeof descriptions !== 'object') return null
  const pairs = Object.entries(descriptions)
    .map(([v, label]) => [Number(v), String(label).toLowerCase()])
    .filter(([v]) => Number.isFinite(v))
    .sort((a, b) => a[0] - b[0])
  return pairs.length ? pairs : null
}

// Build a palette-index → 8-bit-intensity lookup table for one radar.
//
// mayara emits palette indices, not intensities: 0..pixelValues-1 are return
// strengths, then a static-background entry, dopplerApproaching/Receding, and
// a run of history (trail) levels — 51 entries on a HALO24. The ORCA app wants
// an 8-bit intensity per sample. Forwarding the raw indices verbatim, as this
// did, meant the strongest possible return arrived as 15/255 and the overlay
// rendered essentially black: present, correct, and invisible.
//
// Return strengths are scaled across the full range using the radar's own
// pixelValues, so this is right for a radar with a palette other than 16.
//
// Doppler and history:
//   - doppler approaching/receding get the two reserved intensities 255/254,
//     which the ORCA app's Doppler threshold set renders red/green (see the
//     Doppler contract above). This is a real channel, not the full-intensity
//     collapse the previous version used because it assumed none existed.
//   - history/trail levels map to 0. They are echoes the radar has already
//     shown, and rendering them as live returns would smear the picture. This
//     drops trails rather than faking them — see targetTrails on the radar.
//
// Normal returns therefore scale across 0..253, never into the reserved pair,
// so a strong echo can't be mistaken for a Doppler target.
function buildPixelLut (cap) {
  const lut    = Buffer.alloc(256)
  const levels = Number(cap && cap.pixelValues) || 16
  const max    = Math.max(1, levels - 1)
  const pixels = cap && cap.legend && cap.legend.pixels
  // Reserve 254/255 for Doppler only on radars that have it; a non-Doppler
  // radar keeps the full 0..255 range for returns.
  const NORMAL_MAX = capHasDoppler(cap) ? DOPPLER_RECEDING_PIXEL - 1 : 255
  const normal = (i) => Math.round((Math.min(i, max) * NORMAL_MAX) / max)

  if (!Array.isArray(pixels) || !pixels.length) {
    for (let i = 0; i < 256; i++) lut[i] = normal(i)
    return lut
  }
  for (let i = 0; i < 256; i++) {
    const type = pixels[i] && pixels[i].type
    if (type === 'normal') lut[i] = normal(i)
    else if (type === 'dopplerApproaching') lut[i] = DOPPLER_APPROACHING_PIXEL
    else if (type === 'dopplerReceding')    lut[i] = DOPPLER_RECEDING_PIXEL
    else lut[i] = 0
  }
  return lut
}

// A radar supports Doppler if mayara says so in /capabilities (`hasDoppler`),
// or, failing that, if its legend actually carries Doppler pixel types.
function capHasDoppler (cap) {
  if (!cap) return false
  if (cap.hasDoppler === true) return true
  const pixels = cap.legend && cap.legend.pixels
  return Array.isArray(pixels) && pixels.some(p =>
    p && (p.type === 'dopplerApproaching' || p.type === 'dopplerReceding'))
}

function mapPixels (buf, lut) {
  if (!lut) return buf
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = lut[buf[i]]
  return out
}

// Normalise the radar list response into [id, info] pairs.
//
// Radar API v3.4.0 wraps the list in an envelope, `{ version, radars: { id:
// info } }`, so the radars live one level down. Earlier servers returned a
// bare `{ id: info }` map or a bare array, both of which are still accepted.
//
// Getting this wrong is not a silent no-op: running Object.entries() over the
// envelope yields 'version' and 'radars' as radar IDs, and the plugin then
// chases capabilities and spoke streams for two radars that do not exist while
// never connecting to the real ones.
//
// Sorted by id because the order is load-bearing: the ORCA app drives a single
// radar and takes the first one it is offered. mayara serialises its radar map
// from a Rust hash map, so key order differs from request to request — a
// dual-range HALO reports A,B or B,A at random. Whichever order arrived on the
// first discovery used to be locked in for the life of the process, so which
// range the app got was decided by a coin flip at startup.
function parseRadarList (data) {
  if (!data || typeof data !== 'object') return []
  const list = !Array.isArray(data) &&
               data.radars && typeof data.radars === 'object' && !Array.isArray(data.radars)
    ? data.radars
    : data
  const entries = Array.isArray(list)
    ? list.filter(r => r && r.id).map(r => [r.id, r])
    : Object.entries(list).filter(([, info]) => info && typeof info === 'object')
  return entries.sort(([a], [b]) => String(a).localeCompare(String(b)))
}

// Prefer Node's built-in zstd (no native addon, nothing an install-time
// `--ignore-scripts` can break) over @mongodb-js/zstd, which needs its
// postinstall to fetch or build a prebuilt binding — silently unavailable
// on npm 12+, which blocks install scripts by default unless allowlisted.
// Resolved lazily and cached: requiring @mongodb-js/zstd at module load
// would crash the whole plugin on load if the binding was never built (the
// reason this was already a lazy require before the fallback existed).
let _compress = null
function getCompress () {
  if (_compress) return _compress
  const zlib = require('zlib')
  if (typeof zlib.zstdCompress === 'function') {
    _compress = (buf) => new Promise((resolve, reject) => {
      zlib.zstdCompress(buf, (err, out) => err ? reject(err) : resolve(out))
    })
  } else {
    _compress = require('@mongodb-js/zstd').compress
  }
  return _compress
}

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
    // failure key → last reported message, so a per-second failure reports once
    this._errors        = new Map()
  }

  // ── Error reporting ───────────────────────────────────────────────────────

  // These failures used to go to app.debug and nowhere else, which is off by
  // default. A blocked zstd native build and an unresolvable mayara host
  // presented identically to the user — radar controls appear, the overlay
  // stays blank, and the plugin reports healthy — which made a two-line
  // misconfiguration take hours to find. Surface them on the config page.
  _setError (key, msg) {
    if (this._errors.get(key) === msg) return
    this._errors.set(key, msg)
    this.ctx.app.setPluginError(msg)
  }

  _clearError (key) {
    if (!this._errors.delete(key)) return
    if (this._errors.size === 0) this.ctx.app.setPluginStatus('Radar: connected to mayara')
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

    // Ranges available for this radar (in metres), used by the app to populate
    // the range selector. Taken from the radar's own capabilities so the
    // selector offers ranges it can actually be set to; the constant is only a
    // fallback for a radar that reports none.
    rest.get('/v1/radars/:id/ranges', (req, res) => {
      const ranges = this._radars.get(req.params.id)?.ranges || FALLBACK_RANGES
      app.debug(`Radar GET /v1/radars/${req.params.id}/ranges → ${JSON.stringify(ranges)}`)
      res.json({ results: ranges })
    })

    // Dynamic radar detection path (firmware >= 0.27.0): full radar info object
    // passed directly to radarSetInfoAction — no results wrapper.
    rest.get('/v1/radars/:id/info', (req, res) => {
      const r = this._radars.get(req.params.id)
      if (!r) return res.status(404).json({})
      const features = ['range', 'gain', 'gain_auto', 'preset_mode', 'state',
                        'sea', 'sea_auto', 'rain', 'rain_auto',
                        'timed_transmit', 'time_standby', 'time_transmit']
      // Advertising 'doppler' is what makes the app's isDopplerFeatureAvailable
      // true; without it the doppler status fields below are ignored.
      if (r.hasDoppler) features.push('doppler')
      res.json({
        ranges:   r.ranges || FALLBACK_RANGES,
        modes:    r.modes  || FALLBACK_MODES,
        features,
      })
    })

    rest.get('/v1/radars/:id/command', (req, res) => {
      const r = this._radars.get(req.params.id)
      if (!r) return res.status(404).json({})
      res.json(this._orcaStatus(r))
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
      res.json(this._orcaStatus(r))
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

    const send = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      const r = this._radars.get(radarId)
      try {
        ws.send(JSON.stringify(this._orcaStatus(r)))
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
      // zstd: prefer node:zlib's built-in zstdCompress (no native addon to
      // break), fall back to @mongodb-js/zstd. If neither works — its install
      // script was blocked or the build failed — there is no binding, every
      // frame throws here, and the app shows an empty overlay with no other
      // symptom, so this is reported, not debug-logged.
      const compress = getCompress()
      // spokeRange, not rangeMeters — see the note in _onSpoke.
      const frameRange = r.spokeRange ?? r.rangeMeters
      const packed = encode([r.thetaCount * r.rhoCount, frameRange, r.rhoCount, r.thetaCount, spokes])
      const frame  = await compress(Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength))
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame)
      }
      this._clearError('flush')
    } catch (e) {
      this._setError('flush', `Radar: cannot encode spoke frames — ${e.message}`)
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
        spokeRange:    spoke.rangeMeters,
        model:         spoke.model || 'Radar',
        state:         spoke.state || 'transmit',
        pendingSpokes: [],
        lastAngle:     -1,
      }
      this._radars.set(radarId, r)
      this.ctx.app.debug(`Radar ${radarId}: ${r.thetaCount} spokes/scan, ${r.rhoCount} samples`)
    } else {
      // Deliberately not rangeMeters. The spoke range is how far the samples
      // in this frame actually reach, which is not the range the operator
      // selected — a Navico HALO on 1852 m sends spokes spanning 3183 m. The
      // frame needs the former to scale its pixels, the app's range readout
      // needs the latter, and writing both to one field made the value race
      // between the spoke stream and the control poll, emitting frames whose
      // declared range did not match their pixels.
      r.spokeRange = spoke.rangeMeters
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this._clearError('discover')
      const data = await res.json()
      const entries = parseRadarList(data)
      radars = await Promise.all(entries.map(async ([id, info]) => {
        let spokesPerRevolution = 2048, maxSpokeLen = 512, ranges = null, modes = null
        let pixelLut = buildPixelLut(null)
        let hasDoppler = false
        try {
          const capRes = await fetch(`http://${mayaraHost}:${mayaraPort}${SK_RADARS}/${id}/capabilities`)
          if (capRes.ok) {
            const cap = await capRes.json()
            spokesPerRevolution = cap.spokesPerRevolution ?? spokesPerRevolution
            maxSpokeLen = cap.maxSpokeLength ?? maxSpokeLen
            ranges = Array.isArray(cap.supportedRanges) && cap.supportedRanges.length
              ? cap.supportedRanges
              : null
            modes = parseModes(cap.controls?.mode?.descriptions)
            pixelLut = buildPixelLut(cap)
            hasDoppler = capHasDoppler(cap)
          }
        } catch (e) { app.debug(`Radar ${id}: capabilities failed: ${e.message}`) }
        return { id, ...info, spokesPerRevolution, maxSpokeLen, ranges, modes, pixelLut, hasDoppler }
      }))
    } catch (e) {
      this._setError('discover',
        `Radar: cannot reach mayara at ${mayaraHost}:${mayaraPort} — ${e.message}`)
    }

    app.debug(`Radar: discovered ${radars.length} radar(s): ${JSON.stringify(radars.map(r => r.id))}`)

    if (radars.length && !this._spokeMsgType) {
      try {
        this._spokeMsgType = (await protobuf.load(PROTO_PATH)).lookupType('RadarMessage')
        app.debug('Radar: protobuf loaded')
      } catch (e) {
        this._setError('protobuf', `Radar: cannot load the spoke decoder — ${e.message}`)
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

  // ── ORCA status payload ───────────────────────────────────────────────────

  // Build the flat status object the app expects from mayara's control map.
  //
  // These were hardcoded (gain 50/auto, sea 0, rain 0), so the app's sliders
  // showed invented values that never matched the radar and snapped back after
  // every edit. mayara reports gain/sea as `{ auto, value }` and rain as
  // `{ value }` — Navico has no rain auto — with `mode` carrying the preset.
  _orcaStatus (r) {
    const c    = (r && r.controls) || {}
    const num  = (ctl, dflt = 0) => (typeof c[ctl]?.value === 'number' ? c[ctl].value : dflt)
    const auto = (ctl) => c[ctl]?.auto === true
    const status = {
      state:        r ? (STATE_MAP[r.state] ?? 1) : 1,
      preset_mode:  num('mode'),
      gain:         num('gain'),
      gain_auto:    auto('gain'),
      range:        r ? r.rangeMeters : 0,
      sea:          num('sea'),
      sea_auto:     auto('sea'),
      rain:         num('rain'),
      rain_auto:    auto('rain'),
    }
    // Doppler: both fields are required. `doppler` (RadarDopplerActive) gates
    // support/enable; `doppler_mode` (RadarDopplerMode) is the mode. A radar
    // without Doppler must report UNSUPPORTED (-1), or the app treats OFF (0) as
    // "supported but off" and offers a control the radar can't honour. The
    // approaching-vs-receding split itself is carried per-cell in the spokes
    // (254/255), so `doppler_mode` only needs to reflect mayara's mode.
    if (r && r.hasDoppler) {
      const dv = num('doppler') // mayara DopplerMode: 0 None, 1 Both, 2 Approaching
      status.doppler      = dv > 0 ? RADAR_DOPPLER_ACTIVE.ON : RADAR_DOPPLER_ACTIVE.OFF
      status.doppler_mode = MAYARA_TO_ORCA_DOPPLER[dv] ?? RADAR_DOPPLER_MODE.OFF
    } else {
      status.doppler      = RADAR_DOPPLER_ACTIVE.UNSUPPORTED
      status.doppler_mode = RADAR_DOPPLER_MODE.OFF
    }
    return status
  }

  // ── Radar state polling ───────────────────────────────────────────────────

  // Status and range come from mayara's `/controls`, not from the spoke stream.
  //
  // `/controls` rather than `/state`: mayara does not implement /state — that
  // endpoint is synthesised by signalk-server from a provider's getState(), and
  // beluga talks to mayara directly. /controls carries the same information
  // (power, range) and is served by both, so this works either way.
  //
  // Inferring them from spokes deadlocked the app. Spokes are only decoded when
  // an app spoke client is attached (see the guard in _connect), and the status
  // stream reported 'standby' whenever it had no spoke-derived data — but the
  // app only opens the spoke stream once status says the radar is transmitting.
  // Status waited on spokes, spokes waited on status, and the radar overlay
  // never started. Polling mayara breaks the cycle: status is correct whether
  // or not anyone is watching.
  //
  // It also fixes a staleness bug. The old code took state from the discovery
  // payload's `status` field, which Radar API v3.4.0 removed from RadarInfo, so
  // `info.status` was always undefined and state stayed pinned at its initial
  // value — a radar switched to transmit never showed as transmitting.
  _startStatePoll (radarId) {
    if (this._timers.has(radarId)) return
    const poll = () => this._pollState(radarId)
    poll()
    this._timers.set(radarId, setInterval(poll, STATE_MS))
  }

  async _pollState (radarId) {
    const { app, mayaraHost, mayaraPort } = this.ctx
    if (this._stopped) return
    try {
      const res = await fetch(`http://${mayaraHost}:${mayaraPort}${SK_RADARS}/${radarId}/controls`)
      // A server too old to serve /controls still reports status and range in
      // the discovery payload, which _connect already applied. Stop polling
      // rather than 404 once a second forever.
      if (res.status === 404) {
        app.debug(`Radar ${radarId}: no /controls endpoint — falling back to discovery`)
        this._stopStatePoll(radarId)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const controls = await res.json()
      const r = this._radars.get(radarId)
      if (!r || !controls || typeof controls !== 'object') return
      r.controls = controls
      r.state    = POWER_STATE[controls.power?.value] ?? r.state
      const range = controls.range?.value
      if (typeof range === 'number') r.rangeMeters = range
    } catch (e) {
      app.debug(`Radar ${radarId}: control poll failed: ${e.message}`)
    }
  }

  _stopStatePoll (radarId) {
    const t = this._timers.get(radarId)
    if (t) { clearInterval(t); this._timers.delete(radarId) }
  }

  // ── Spoke stream connection to mayara-server ──────────────────────────────

  _connect (info) {
    const { app, mayaraHost, mayaraPort } = this.ctx
    const radarId    = info.id
    const thetaCount = info.spokesPerRevolution
    const rhoCount   = info.maxSpokeLen
    const pixelLut   = info.pixelLut

    if (this._sources.has(radarId)) return

    if (!this._radars.has(radarId)) {
      this._radars.set(radarId, {
        thetaCount, rhoCount,
        // Pre-3.4.0 RadarInfo carries status/range/controls inline; 3.4.0
        // stripped them down to identity, and the state poll supplies them
        // instead. Seed from whatever discovery gave us so an older server
        // is correct before the first poll returns.
        rangeMeters:   info.range  || 0,
        model:         info.name   || 'Radar',
        state:         info.status || 'standby',
        controls:      info.controls || {},
        ranges:        info.ranges || null,
        modes:         info.modes  || null,
        hasDoppler:    !!info.hasDoppler,
        pendingSpokes: [],
        lastAngle:     -1,
      })
    } else {
      const r = this._radars.get(radarId)
      if (info.status) r.state = info.status
      if (typeof info.range === 'number') r.rangeMeters = info.range
      if (info.ranges) r.ranges = info.ranges
      if (info.modes)  r.modes  = info.modes
      if (info.hasDoppler != null) r.hasDoppler = info.hasDoppler
    }
    this._startStatePoll(radarId)

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
          bearing: s.angle, data: mapPixels(s.data, pixelLut), rangeMeters: s.range,
          thetaCount, rhoCount, model: info.name,
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

    const put = (control, body) =>
      fetch(`${base}/${control}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      }).catch(e => app.debug(`Radar ${radarId}: ${control} failed: ${e.message}`))

    if (cmd.range != null) put('range', { value: cmd.range })

    if (cmd.state != null) {
      const isTransmit = cmd.state === 'transmitting' || cmd.state === 'transmit' || cmd.state === 8
      put('power', { value: isTransmit ? 2 : 1 })
      const r = this._radars.get(radarId)
      if (r) r.state = isTransmit ? 'transmit' : 'standby'
    }

    if (cmd.preset_mode != null) put('mode', { value: cmd.preset_mode })

    // gain and sea are auto-capable: mayara takes `auto` alongside `value`, and
    // the app sends the slider and its auto toggle as separate fields. Send
    // them together so flipping auto off does not also reset the value, and so
    // moving the slider implies manual. Only `rain` has no auto on Navico.
    for (const ctl of ['gain', 'sea']) {
      const value = cmd[ctl]
      const isAuto = cmd[`${ctl}_auto`]
      if (value == null && isAuto == null) continue
      const body = {}
      if (value != null)  body.value = value
      if (isAuto != null) body.auto  = !!isAuto
      else if (value != null) body.auto = false
      put(ctl, body)
    }

    if (cmd.rain != null) put('rain', { value: cmd.rain })

    // The app sends the ORCA RadarDopplerMode (0..3); mayara's doppler control
    // takes its own DopplerMode (0 None, 1 Both, 2 Approaching). Translate.
    if (cmd.doppler_mode != null)
      put('doppler', { value: ORCA_TO_MAYARA_DOPPLER[cmd.doppler_mode] ?? 0 })
    else if (cmd.doppler != null)
      put('doppler', { value: cmd.doppler ? 1 : 0 })
  }
}

module.exports = Radar
module.exports.parseRadarList = parseRadarList
module.exports.parseModes     = parseModes
module.exports.buildPixelLut  = buildPixelLut
module.exports.capHasDoppler  = capHasDoppler

'use strict'

const test   = require('node:test')
const assert = require('node:assert/strict')
const { parseRadarList } = require('../lib/radar')

// Radar API v3.4.0 moved the radar map behind a `{ version, radars }` envelope.
// Parsing it as a bare map is the failure this covers: it does not yield an
// empty list, it yields two radars called 'version' and 'radars', which the
// plugin then tries to connect spoke streams to.

const INFO_A = { name: 'Halo A', brand: 'Navico', model: 'HALO24', radarIpAddress: '10.56.0.102' }
const INFO_B = { name: 'Halo B', brand: 'Navico', model: 'HALO24', radarIpAddress: '10.56.0.102' }

test('parses the v3.4.0 { version, radars } envelope', () => {
  const entries = parseRadarList({ version: '3.4.0', radars: { nav1034A: INFO_A, nav1034B: INFO_B } })
  assert.deepEqual(entries.map(([id]) => id), ['nav1034A', 'nav1034B'])
  assert.deepEqual(entries[0][1], INFO_A)
})

test('does not mistake the envelope keys for radar IDs', () => {
  const ids = parseRadarList({ version: '3.4.0', radars: { nav1034A: INFO_A } }).map(([id]) => id)
  assert.ok(!ids.includes('version'), 'version must not be treated as a radar')
  assert.ok(!ids.includes('radars'), 'radars must not be treated as a radar')
})

test('still accepts a bare { id: info } map from older servers', () => {
  const entries = parseRadarList({ nav1034A: INFO_A, nav1034B: INFO_B })
  assert.deepEqual(entries.map(([id]) => id), ['nav1034A', 'nav1034B'])
})

test('still accepts a bare array from older servers', () => {
  const entries = parseRadarList([{ id: 'nav1034A', ...INFO_A }])
  assert.deepEqual(entries.map(([id]) => id), ['nav1034A'])
  assert.equal(entries[0][1].name, 'Halo A')
})

test('an empty envelope yields no radars', () => {
  assert.deepEqual(parseRadarList({ version: '3.4.0', radars: {} }), [])
})

test('malformed responses yield no radars rather than throwing', () => {
  for (const bad of [null, undefined, '', 'nope', 42]) {
    assert.deepEqual(parseRadarList(bad), [], `input: ${JSON.stringify(bad)}`)
  }
})

test('array entries without an id are skipped', () => {
  assert.deepEqual(parseRadarList([{ name: 'no id' }, { id: 'nav1034A', ...INFO_A }]).map(([id]) => id),
    ['nav1034A'])
})

// ── ORCA status payload ─────────────────────────────────────────────────────
// The app's sliders read these. They used to be hardcoded (gain 50/auto, sea 0,
// rain 0) regardless of what the radar was actually set to.

const Radar = require('../lib/radar')

function statusFor (radar) {
  return Radar.prototype._orcaStatus.call(null, radar)
}

const CONTROLS = {
  gain:  { auto: true,  value: 45 },
  sea:   { auto: false, value: 39 },
  rain:  { value: 12 },
  mode:  { value: 2 },
  range: { value: 926 },
}

test('status reports the radar\'s real control values', () => {
  const s = statusFor({ state: 'transmit', rangeMeters: 926, controls: CONTROLS })
  assert.equal(s.gain, 45)
  assert.equal(s.gain_auto, true)
  assert.equal(s.sea, 39)
  assert.equal(s.sea_auto, false)
  assert.equal(s.rain, 12)
  assert.equal(s.preset_mode, 2)
  assert.equal(s.range, 926)
})

test('status maps mayara power states to ORCA numerics', () => {
  assert.equal(statusFor({ state: 'transmit', controls: {} }).state, 8)
  assert.equal(statusFor({ state: 'standby',  controls: {} }).state, 1)
  assert.equal(statusFor({ state: 'off',      controls: {} }).state, 0)
})

test('status falls back to standby for an unknown radar', () => {
  assert.equal(statusFor(undefined).state, 1)
  assert.equal(statusFor(undefined).range, 0)
})

test('rain_auto is false when the control has no auto (Navico)', () => {
  assert.equal(statusFor({ state: 'transmit', controls: CONTROLS }).rain_auto, false)
})

test('missing controls degrade to zeros rather than throwing', () => {
  const s = statusFor({ state: 'standby', rangeMeters: 0, controls: {} })
  assert.equal(s.gain, 0)
  assert.equal(s.gain_auto, false)
  assert.equal(s.preset_mode, 0)
})

// ── Range: selected vs spoke extent ─────────────────────────────────────────
// A HALO on 1852 m emits spokes spanning 3183 m. The frame must declare the
// extent its pixels actually cover; the app's readout must show what the
// operator selected. Holding both in one field made them race.

test('spoke range and selected range are tracked separately', () => {
  const r = { thetaCount: 2048, rhoCount: 1024, rangeMeters: 1852, spokeRange: 3183, controls: {}, state: 'transmit' }
  assert.equal(statusFor(r).range, 1852, 'status reports the selected range')
  assert.equal(r.spokeRange, 3183, 'frame scaling uses the spoke extent')
})

// ── Preset modes ────────────────────────────────────────────────────────────
// A HALO reports custom/harbor/offshore/buoy/weather/bird/bird+ over 0..6.
// These were hardcoded as harbor/coastal/offshore/weather for 0..3, so picking
// "harbor" in the app actually set Custom.

const { parseModes } = require('../lib/radar')

test('preset modes come from the radar, ordered by value', () => {
  const modes = parseModes({ '1': 'Harbor', '6': 'Bird+', '5': 'Bird', '0': 'Custom',
                             '3': 'Buoy', '4': 'Weather', '2': 'Offshore' })
  assert.deepEqual(modes, [
    [0, 'custom'], [1, 'harbor'], [2, 'offshore'], [3, 'buoy'],
    [4, 'weather'], [5, 'bird'], [6, 'bird+'],
  ])
})

test('preset modes are null when the radar reports none', () => {
  for (const bad of [undefined, null, {}, 'nope', 42]) assert.equal(parseModes(bad), null)
})

// ── Pixel intensity mapping ─────────────────────────────────────────────────
// mayara sends palette indices; ORCA wants 8-bit intensity. Forwarding indices
// verbatim made the strongest return arrive as 15/255 — a black overlay.

const { buildPixelLut } = require('../lib/radar')

const HALO_CAP = {
  pixelValues: 16,
  legend: {
    pixels: [
      ...Array.from({ length: 16 }, () => ({ type: 'normal' })),
      { type: 'history' },
      { type: 'dopplerApproaching' },
      { type: 'dopplerReceding' },
      ...Array.from({ length: 32 }, () => ({ type: 'history' })),
    ],
  },
}

test('return strengths scale across the full 8-bit range', () => {
  const lut = buildPixelLut(HALO_CAP)
  assert.equal(lut[0], 0, 'no return stays transparent')
  assert.equal(lut[15], 255, 'strongest return reaches full intensity')
  assert.equal(lut[8], 136)
})

test('doppler indices paint at full intensity', () => {
  const lut = buildPixelLut(HALO_CAP)
  assert.equal(lut[17], 255)
  assert.equal(lut[18], 255)
})

test('history/trail levels are dropped, not painted as live returns', () => {
  const lut = buildPixelLut(HALO_CAP)
  assert.equal(lut[16], 0)
  for (let i = 19; i <= 50; i++) assert.equal(lut[i], 0, `history index ${i}`)
})

test('a radar with a non-16 palette scales to its own depth', () => {
  const lut = buildPixelLut({ pixelValues: 8, legend: { pixels: Array.from({ length: 8 }, () => ({ type: 'normal' })) } })
  assert.equal(lut[7], 255, '8-level palette tops out at 255')
  assert.equal(lut[0], 0)
})

test('no legend falls back to a linear ramp', () => {
  const lut = buildPixelLut(null)
  assert.equal(lut[0], 0)
  assert.equal(lut[15], 255)
})

test('radars are ordered deterministically', () => {
  // mayara serialises from a Rust hash map, so key order varies per request.
  // The app takes the first radar it is offered, so the order must not.
  const A = { name: 'Halo A' }, B = { name: 'Halo B' }
  const forward = parseRadarList({ version: '3.4.0', radars: { nav1034A: A, nav1034B: B } })
  const reverse = parseRadarList({ version: '3.4.0', radars: { nav1034B: B, nav1034A: A } })
  assert.deepEqual(forward.map(([id]) => id), ['nav1034A', 'nav1034B'])
  assert.deepEqual(reverse.map(([id]) => id), ['nav1034A', 'nav1034B'])
})

test('deeper palettes scale to their own depth, not a hardcoded 16', () => {
  for (const depth of [8, 16, 32, 64, 256]) {
    const lut = buildPixelLut({
      pixelValues: depth,
      legend: { pixels: Array.from({ length: depth }, () => ({ type: 'normal' })) },
    })
    assert.equal(lut[0], 0, `depth ${depth}: no return transparent`)
    assert.equal(lut[depth - 1], 255, `depth ${depth}: strongest return saturates`)
    assert.equal(lut[Math.floor((depth - 1) / 2)], Math.round((Math.floor((depth - 1) / 2) * 255) / (depth - 1)))
  }
})

test('doppler is found by legend type, not by hardcoded index', () => {
  // Navico puts doppler at 17/18. A brand that puts it elsewhere still works.
  const pixels = Array.from({ length: 40 }, () => ({ type: 'normal' }))
  pixels[33] = { type: 'dopplerApproaching' }
  pixels[34] = { type: 'dopplerReceding' }
  const lut = buildPixelLut({ pixelValues: 32, legend: { pixels } })
  assert.equal(lut[33], 255)
  assert.equal(lut[34], 255)
})

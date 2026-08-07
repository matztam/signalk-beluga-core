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

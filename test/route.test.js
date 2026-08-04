'use strict'

// The default route name is in server-local time, so the expected strings below depend on the
// timezone. Pin it before anything reads a Date: node resolves the zone once and caches it.
process.env.TZ = 'Europe/Stockholm'

const test = require('node:test')
const assert = require('node:assert')
const {
  extractRoute, toSignalKRoute, routeLength, routeIdentities, defaultRouteName, storedIdentities
} = require('../lib/route')

// Captured off the wire from Orca 2026.28.1 on PUT /v1/navigation/route. Keeping the real payload
// rather than a tidied-up one is the point: it is the only record of what the app actually sends,
// and the handler exists because this body used to be dropped by the catch-all route.
const ORCA_BODY = {
  value: {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { updatedAt: 1785762597942, hash: '1e937d58e7393a5d2c5b28a9835e8313' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [11.843728, 57.618678], [11.852809, 57.611516], [11.862434, 57.607796],
          [11.875739, 57.602386], [11.879486, 57.601666], [11.880964, 57.60185],
          [11.881028, 57.601876], [11.881483, 57.602156], [11.88186, 57.602551],
          [11.882568, 57.603037], [11.883886, 57.605462], [11.884158, 57.605401]
        ]
      }
    }]
  }
}

test('the route Orca actually sends is understood', () => {
  const r = extractRoute(ORCA_BODY)
  assert.ok(r)
  assert.equal(r.coordinates.length, 12)
  assert.deepEqual(r.coordinates[0], [11.843728, 57.618678])
  assert.equal(r.hash, '1e937d58e7393a5d2c5b28a9835e8313')
  assert.equal(r.updatedAt, 1785762597942)
})

test('an unwrapped body is accepted too', () => {
  // The wrapper is the app's convention, not GeoJSON's, so do not require it.
  assert.ok(extractRoute(ORCA_BODY.value))
})

test('a bare Feature is accepted', () => {
  assert.equal(extractRoute(ORCA_BODY.value.features[0]).coordinates.length, 12)
})

test('an empty collection reads as no route, which is how cancel arrives', () => {
  // The app sends an empty collection when navigation stops. It has to read as "no route", which
  // is what the handler turns into removing the published resource.
  assert.equal(extractRoute({ value: { type: 'FeatureCollection', features: [] } }), null)
})

test('malformed bodies are rejected before reaching the resource provider', () => {
  for (const body of [
    null, undefined, {}, { value: null }, { value: 'nope' }, { value: 42 },
    { value: { type: 'FeatureCollection' } },
    { value: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } }] } },
    { value: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[11, 57]] } } },
    { value: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[11, 57], [999, 57]] } } },
    { value: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[11, 57], [11, 'x']] } } },
    { value: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[11, 57], null] } } },
    { value: { type: 'Feature', geometry: { type: 'LineString', coordinates: 'nope' } } }
  ]) {
    assert.equal(extractRoute(body), null, `should reject: ${JSON.stringify(body)}`)
  }
})

test('a collection with other features still finds the line', () => {
  const mixed = {
    value: {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [11, 57] } },
        ORCA_BODY.value.features[0]
      ]
    }
  }
  assert.equal(extractRoute(mixed).coordinates.length, 12)
})

test('missing properties do not sink an otherwise good route', () => {
  const r = extractRoute({ value: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[11, 57], [11.1, 57.1]] } } })
  assert.ok(r)
  assert.equal(r.hash, null)
  assert.equal(r.updatedAt, null)
})

test('the distance is right, checked against the real route', () => {
  // The twelve captured points measure 3455 m. Sanity check that does not just restate the code:
  // end to end as the crow flies is 2828 m, and a route that bends is longer than that but not by
  // a factor — so anything outside this band means the summation or the projection is wrong.
  const d = routeLength(extractRoute(ORCA_BODY).coordinates)
  assert.ok(d > 2828 && d < 4000, `got ${d} m`)
})

test('one degree of latitude is about 111 km', () => {
  assert.ok(Math.abs(routeLength([[0, 0], [0, 1]]) - 111195) < 100)
})

test('it comes out in the shape the resources API takes', () => {
  const sk = toSignalKRoute(extractRoute(ORCA_BODY), 'ORCA active route')
  assert.equal(sk.name, 'ORCA active route')
  assert.equal(sk.feature.type, 'Feature')
  assert.equal(sk.feature.geometry.type, 'LineString')
  assert.equal(sk.feature.geometry.coordinates.length, 12)
  assert.equal(typeof sk.distance, 'number')
  assert.equal(sk.feature.properties.orcaHash, '1e937d58e7393a5d2c5b28a9835e8313')
})

test('coordinates stay in GeoJSON order and are not aliased to the input', () => {
  // Both formats are [longitude, latitude]; swapping them would put this route in Somalia and
  // still look plausible in a test that only counts points.
  const sk = toSignalKRoute(extractRoute(ORCA_BODY), 'x')
  const [lon, lat] = sk.feature.geometry.coordinates[0]
  assert.ok(lon > 11 && lon < 12, `longitude ${lon}`)
  assert.ok(lat > 57 && lat < 58, `latitude ${lat}`)
  sk.feature.geometry.coordinates[0][0] = 0
  assert.equal(ORCA_BODY.value.features[0].geometry.coordinates[0][0], 11.843728, 'input untouched')
})

test('a route carries both its app hash and its geometry digest', () => {
  const r = extractRoute(ORCA_BODY)
  const ids = routeIdentities(r)
  assert.equal(ids.length, 2)
  assert.equal(ids[0], `orca:${r.hash}`)
  assert.match(ids[1], /^geom:[0-9a-f]{64}$/)
})

test('the same geometry sent with and without a hash is still one route', () => {
  // The overlap on the geometry digest is what makes this work. Keying on the app hash alone
  // would archive the identical route twice the first time a push arrived without one.
  const r = extractRoute(ORCA_BODY)
  const withHash = routeIdentities(r)
  const without = routeIdentities({ ...r, hash: null })
  assert.ok(without.some(i => withHash.includes(i)), 'the two share an identity')
  assert.deepEqual(without, routeIdentities({ ...r, hash: '' }), 'an empty hash is as good as none')
})

test('moving a single point makes it a different route', () => {
  const r = extractRoute(ORCA_BODY)
  const moved = { ...r, hash: null, coordinates: r.coordinates.map((c, i) => i === 0 ? [c[0] + 0.001, c[1]] : c) }
  const a = routeIdentities({ ...r, hash: null })
  const b = routeIdentities(moved)
  assert.ok(!b.some(i => a.includes(i)))
})

test('a geometry digest can never be mistaken for an app hash', () => {
  // Both are hex strings. Without the namespace an app hash that happened to equal a digest would
  // match a route it has nothing to do with.
  const r = extractRoute(ORCA_BODY)
  const geom = routeIdentities({ ...r, hash: null })[0].replace(/^geom:/, '')
  const other = routeIdentities({ coordinates: [[1, 1], [2, 2]], hash: geom })
  assert.ok(!other.includes(`geom:${geom}`), 'the hash does not masquerade as the digest')
  assert.equal(other[0], `orca:${geom}`)
})

test('the starting name is derived from the push, and survives a missing timestamp', () => {
  // 13:09 UTC, i.e. 15:09 in the pinned zone. Reading UTC here would put a route drawn after
  // dinner on the wrong side of midnight, which is precisely when the name has to be trusted.
  assert.equal(defaultRouteName(1785762597942), 'ORCA 2026-08-03 15:09')
  assert.equal(defaultRouteName(null), 'ORCA route')
  assert.equal(defaultRouteName(undefined), 'ORCA route')
  assert.equal(defaultRouteName(NaN), 'ORCA route')
  assert.equal(defaultRouteName(8.64e15 + 1), 'ORCA route', 'out of Date range, not a crash')
})

test('every field in the name is zero padded', () => {
  // 2026-01-02 03:04 local. Unpadded getters would render this "2026-1-2 3:4" and sort wrong in
  // the route list, which is the one job the timestamp has.
  const t = new Date(2026, 0, 2, 3, 4, 0).getTime()
  assert.equal(defaultRouteName(t), 'ORCA 2026-01-02 03:04')
})

test('a stored route is recognised in every form it has ever been written', () => {
  // Three shapes exist in the wild, and failing to read any one of them means an upgrade
  // duplicates the route it was already storing.
  const r = extractRoute(ORCA_BODY)
  const ids = routeIdentities(r)

  const current = storedIdentities(toSignalKRoute(r, 'x'))
  assert.ok(ids.every(i => current.includes(i)), 'written by this version')

  const firstVersion = { feature: { properties: { orcaHash: r.hash } } }
  assert.ok(storedIdentities(firstVersion).some(i => ids.includes(i)), 'orcaHash only')

  const shortLived = { feature: { properties: { orcaIdentity: `orca:${r.hash}` } } }
  assert.ok(storedIdentities(shortLived).some(i => ids.includes(i)), 'orcaIdentity only')

  // Both fields present and saying the same thing, which is what the short-lived version wrote.
  const both = { feature: { properties: { orcaHash: r.hash, orcaIdentity: `orca:${r.hash}` } } }
  assert.deepEqual(storedIdentities(both), [`orca:${r.hash}`], 'listed once, not twice')

  const geomOnly = { feature: { properties: { orcaGeometry: ids[1].replace(/^geom:/, '') } } }
  assert.ok(storedIdentities(geomOnly).some(i => ids.includes(i)), 'geometry only')
})

test('a resource that is not ours answers to no identity', () => {
  for (const r of [null, undefined, {}, { feature: {} }, { feature: { properties: {} } },
    { feature: { properties: { orcaHash: '', orcaGeometry: '', orcaIdentity: '' } } },
    { feature: { properties: { orcaHash: 42 } } }]) {
    assert.deepEqual(storedIdentities(r), [], `should be empty: ${JSON.stringify(r)}`)
  }
})

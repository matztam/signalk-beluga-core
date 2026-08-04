'use strict'

// The ORCA app pushes its active route on PUT /v1/navigation/route:
//   {"value":{"type":"FeatureCollection","features":[{"type":"Feature",
//     "properties":{"updatedAt":1785762597942,"hash":"1e937d58…"},
//     "geometry":{"type":"LineString","coordinates":[[11.843728,57.618678],…]}}]}}
// SignalK stores a route as one Feature plus a name and a distance, so this is mostly unwrapping.

const { createHash } = require('crypto')

const EARTH_R = 6371000

// Equirectangular — ample over the length of a route leg. Does not wrap the antimeridian, which
// only affects the reported distance.
function legMetres (a, b) {
  const la = a[1] * Math.PI / 180
  const lb = b[1] * Math.PI / 180
  const x = (b[0] - a[0]) * Math.PI / 180 * Math.cos((la + lb) / 2)
  const y = lb - la
  return Math.sqrt(x * x + y * y) * EARTH_R
}

function routeLength (coordinates) {
  let total = 0
  for (let i = 1; i < coordinates.length; i++) {
    total += legMetres(coordinates[i - 1], coordinates[i])
  }
  return Math.round(total)
}

// GeoJSON position, [longitude, latitude].
function isPosition (c) {
  return Array.isArray(c) && c.length >= 2 &&
    Number.isFinite(c[0]) && Number.isFinite(c[1]) &&
    c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90
}

// Returns {coordinates, hash, updatedAt}, or null when the body carries no route. The app sends an
// empty FeatureCollection when navigation is cancelled, which lands here as null too.
function extractRoute (body) {
  const v = (body && body.value !== undefined) ? body.value : body
  if (!v || typeof v !== 'object') { return null }

  let feature = null
  if (v.type === 'FeatureCollection' && Array.isArray(v.features)) {
    feature = v.features.find(f => f && f.geometry && f.geometry.type === 'LineString') || null
  } else if (v.type === 'Feature') {
    feature = v
  }
  if (!feature || !feature.geometry || feature.geometry.type !== 'LineString') { return null }

  const coordinates = feature.geometry.coordinates
  if (!Array.isArray(coordinates) || coordinates.length < 2) { return null }
  if (!coordinates.every(isPosition)) { return null }

  const props = feature.properties || {}
  return {
    coordinates: coordinates.map(c => [c[0], c[1]]),
    hash: typeof props.hash === 'string' ? props.hash : null,
    updatedAt: Number.isFinite(props.updatedAt) ? props.updatedAt : null
  }
}

function geometryDigest (coordinates) {
  return createHash('sha256')
    .update(coordinates.map(c => `${c[0]},${c[1]}`).join(';'))
    .digest('hex')
}

// Every identity a route answers to, used to tell a route we have already stored from a new one.
// A route carries both the app's own hash, which is what the app considers the same route, and a
// digest of its geometry. Two rather than one because either can be missing: a push may arrive
// without a hash, and a route stored by an older version has no digest recorded. Matching on any
// overlap means the same route sent once with a hash and once without is still recognised.
//
// The two forms are namespaced apart so a hash that happens to look like a digest cannot match a
// route it has nothing to do with.
function routeIdentities (route) {
  const ids = []
  if (typeof route.hash === 'string' && route.hash !== '') { ids.push(`orca:${route.hash}`) }
  ids.push(`geom:${geometryDigest(route.coordinates)}`)
  return ids
}

// Starting name for a route the app has not sent before. Deliberately plain: the point is that the
// user renames it in Freeboard and the name then survives, so this only has to be good enough to
// tell apart from its neighbours in the list. It is NOT unique — the resolution is minutes, and
// two routes stored in the same minute get the same name.
//
// Server-local time, not UTC. This name is read by someone standing on the boat trying to work out
// which of three routes is the one they just drew, and an hour or two of offset is exactly enough
// to make that guess wrong. Built from the Date getters rather than toLocaleString so the format
// is fixed rather than following the server's locale.
function defaultRouteName (updatedAt) {
  const t = Number.isFinite(updatedAt) ? new Date(updatedAt) : null
  if (!t || isNaN(t.getTime())) { return 'ORCA route' }
  const p = (n) => String(n).padStart(2, '0')
  return `ORCA ${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ` +
    `${p(t.getHours())}:${p(t.getMinutes())}`
}

function toSignalKRoute (route, name) {
  return {
    name: name,
    description: 'Route pushed by the ORCA app',
    distance: routeLength(route.coordinates),
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.coordinates },
      properties: {
        orcaHash: route.hash,
        orcaGeometry: geometryDigest(route.coordinates),
        orcaUpdatedAt: route.updatedAt
      }
    }
  }
}

// Every identity an already-stored resource answers to. Three forms are read because three have
// been written: orcaHash from the first version, orcaIdentity from a short-lived one that stored a
// single namespaced string, and orcaHash plus orcaGeometry from this one. Reading all three is what
// keeps an upgrade from duplicating the route it was already storing.
function storedIdentities (resource) {
  const p = (resource && resource.feature && resource.feature.properties) || {}
  const ids = new Set()
  if (typeof p.orcaIdentity === 'string' && p.orcaIdentity !== '') { ids.add(p.orcaIdentity) }
  if (typeof p.orcaHash === 'string' && p.orcaHash !== '') { ids.add(`orca:${p.orcaHash}`) }
  if (typeof p.orcaGeometry === 'string' && p.orcaGeometry !== '') { ids.add(`geom:${p.orcaGeometry}`) }
  return [...ids]
}

module.exports = {
  extractRoute, toSignalKRoute, routeLength, routeIdentities, defaultRouteName, storedIdentities
}

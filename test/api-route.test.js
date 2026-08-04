'use strict'

// The default route name is in server-local time; pin the zone before anything reads a Date.
process.env.TZ = 'Europe/Stockholm'

const test   = require('node:test')
const assert = require('node:assert/strict')
const Api    = require('../lib/api')

// route.test.js covers the conversion. This covers the wiring: that the app's PUT reaches a
// handler at all. It used to reach the catch-all, which answers 200 and drops the body.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const ORCA_ROUTE = {
  value: {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { updatedAt: 1785762597942, hash: '1e937d58e7393a5d2c5b28a9835e8313' },
      geometry: {
        type: 'LineString',
        coordinates: [[11.843728, 57.618678], [11.852809, 57.611516], [11.862434, 57.607796]]
      }
    }]
  }
}

const EMPTY_ROUTE = { value: { type: 'FeatureCollection', features: [] } }

function ctx (opts) {
  const o = opts || {}
  const written = []
  const deleted = []
  const errors  = []
  // Stands in for the resources provider: what was written is what is listed back, which is what
  // makes "already stored" testable at all.
  const store = { ...(o.store || {}) }
  return {
    written,
    deleted,
    errors,
    store,
    app: {
      debug: () => {},
      setPluginError: (m) => errors.push(m),
      getSelfPath: () => null,
      resourcesApi: {
        listResources: async (type) => {
          if (type !== 'routes') { throw new Error(`asked for ${type}, not routes`) }
          if (o.failLists) { throw new Error('no provider registered') }
          // The server's listFromAll runs Promise.allSettled and drops a provider that rejects, so
          // a failing provider is indistinguishable from an empty library. That is the silent case.
          if (o.blindLists) { return {} }
          return store
        },
        setResource: async (type, id, data) => {
          if (o.failWrites) { throw new Error('no provider registered') }
          // A real provider writes to disk, so the store is not updated in the same tick the call
          // is made. Without this the mock is too fast to expose a concurrent write at all.
          if (o.slowWrites) { await new Promise(r => setImmediate(r)) }
          written.push({ type, id, data })
          store[id] = data
        },
        deleteResource: async (type, id) => {
          if (o.failDeletes) { throw new Error('not found') }
          deleted.push({ type, id })
          delete store[id]
        }
      }
    },
    deviceId: 'test01',
    deviceName: 'orca-test01',
    firmwareVersion: '2026.25.1',
    publishRoutes: 'publishRoutes' in o ? o.publishRoutes : true
  }
}

// Api.start() binds fixed ports, which a test should not do. Capture the express app instead and
// drive it directly, so express's own routing still decides which handler runs.
function apiUnderTest (opts) {
  const c = ctx(opts)
  const api = new Api(c)
  const apps = []
  api._listen = (expressApp) => { apps.push(expressApp); return { close () {} } }
  api.start()
  return { api, c, rest: apps[0] }
}

function request (expressApp, method, url, body) {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      originalUrl: url,
      baseUrl: '',
      path: url,
      headers: { 'content-type': 'application/json' },
      body,
      get (h) { return this.headers[h.toLowerCase()] }
    }
    const res = {
      statusCode: 200,
      status (c) { this.statusCode = c; return this },
      set () { return this },
      setHeader () { return this },
      getHeader () { return undefined },
      end () { resolve({ status: this.statusCode, body: this._json }) },
      json (payload) { this._json = payload; this.end() }
    }
    expressApp(req, res)
  })
}

// The publish runs detached from the response, so the assertions have to wait for it.
const settled = () => new Promise(r => setImmediate(r))

test('a route pushed by the app is published as a SignalK resource', async () => {
  const { c, rest } = apiUnderTest()
  const res = await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { value: {} })
  assert.equal(c.written.length, 1)
  assert.equal(c.written[0].type, 'routes')
  assert.match(c.written[0].id, UUID_RE, 'the resources API takes nothing but a UUID v4')
  assert.equal(c.written[0].data.feature.geometry.coordinates.length, 3)
  assert.equal(c.written[0].data.name, 'ORCA 2026-08-03 15:09')
})

test('the app is answered before the resources API is touched at all', { timeout: 2000 }, async () => {
  // The phone is blocking on this PUT, so a slow or hanging resource provider must not hold it up.
  // Hanging the list is the harder case of the two: it is the first call the publish makes.
  let release
  const c = ctx()
  c.app.resourcesApi.listResources = () => new Promise(r => { release = r })
  const api = new Api(c)
  const apps = []
  api._listen = (a) => { apps.push(a); return { close () {} } }
  api.start()
  const res = await request(apps[0], 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  assert.equal(res.status, 200, 'answered while the read is still outstanding')
  assert.equal(c.written.length, 0, 'and nothing written yet')
  release({})
})

test('the same route sent again is not written a second time', async () => {
  // The app re-sends on every change of its own route, so a second write here is what would
  // overwrite the name the user gave the route in Freeboard.
  const { c, rest } = apiUnderTest()
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  assert.equal(c.written.length, 1)
})

test('two pushes arriving together still store the route once', async () => {
  // Without serialising, both read the empty store before either has finished writing, and the
  // route lands twice. slowWrites is what makes that reachable: a provider that updates the store
  // in the same tick it is called leaves no window for the second read to fall into.
  const { c, rest } = apiUnderTest({ slowWrites: true })
  await Promise.all([
    request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE),
    request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  ])
  for (let i = 0; i < 5; i++) { await settled() }
  assert.equal(c.written.length, 1)
})

test('a name given in Freeboard survives the app sending the route again', async () => {
  const { c, rest } = apiUnderTest()
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  const id = c.written[0].id
  c.store[id] = { ...c.store[id], name: 'Hättan-Askim' }
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  assert.equal(c.store[id].name, 'Hättan-Askim')
})

test('a different route is stored alongside, under an id of its own', async () => {
  const { c, rest } = apiUnderTest()
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  const changed = JSON.parse(JSON.stringify(ORCA_ROUTE))
  changed.value.features[0].properties.hash = '9c4f0b21d6e8a3f5b7c1d9e2a4f6b8c0'
  changed.value.features[0].geometry.coordinates.push([11.875739, 57.602386])
  await request(rest, 'PUT', '/v1/navigation/route', changed)
  await settled()
  assert.equal(c.written.length, 2)
  assert.notEqual(c.written[1].id, c.written[0].id)
  assert.equal(c.written[1].data.feature.geometry.coordinates.length, 4)
})

test('a hashless route is recognised the second time, by its geometry', async () => {
  // Nothing else drives the geometry digest through the handler: every other fixture has a hash,
  // so the digest could be dropped from the stored resource and no test would notice.
  const bare = JSON.parse(JSON.stringify(ORCA_ROUTE))
  delete bare.value.features[0].properties.hash
  const { c, rest } = apiUnderTest()
  await request(rest, 'PUT', '/v1/navigation/route', bare)
  await settled()
  assert.equal(c.written.length, 1)
  await request(rest, 'PUT', '/v1/navigation/route', bare)
  await settled()
  assert.equal(c.written.length, 1, 'the second push found the first')
})

test('a route first seen without a hash is found when it later has one', async () => {
  // The stored resource then answers only to the geometry, while the incoming route leads with its
  // app hash. Matching on the first identity alone misses it and archives a second copy.
  const bare = JSON.parse(JSON.stringify(ORCA_ROUTE))
  delete bare.value.features[0].properties.hash
  const { c, rest } = apiUnderTest()
  await request(rest, 'PUT', '/v1/navigation/route', bare)
  await settled()
  assert.equal(c.written.length, 1)

  // A fresh instance, so the run-local memory cannot be what finds it.
  const second = apiUnderTest({ store: c.store })
  await request(second.rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  assert.equal(second.c.written.length, 0, 'matched on the geometry it already had')
})

test('the right route is found among several already stored', async () => {
  // The library behaviour the README sells: store A, store B, send A again. With one route in the
  // store a match can be found by accident.
  const { c, rest } = apiUnderTest()
  const b = JSON.parse(JSON.stringify(ORCA_ROUTE))
  b.value.features[0].properties.hash = '9c4f0b21d6e8a3f5b7c1d9e2a4f6b8c0'
  b.value.features[0].geometry.coordinates.push([11.875739, 57.602386])

  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  await request(rest, 'PUT', '/v1/navigation/route', b)
  await settled()
  assert.equal(c.written.length, 2)

  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  assert.equal(c.written.length, 2, 'the first route was found, not re-stored')
})

test('a library that reads back empty does not cause a duplicate', async () => {
  // listResources swallows a failing provider and returns {}, so "no routes stored" is exactly
  // what a broken provider looks like. Without the run-local memory this stores a copy per push.
  const { c, rest } = apiUnderTest({ blindLists: true })
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  assert.equal(c.written.length, 1)
})

test('a route queued when the plugin stops is not written afterwards', async () => {
  // Publishing is detached from the request, so work already in flight would otherwise reach the
  // resources API after the plugin was told to shut down.
  let release
  const c = ctx()
  const realList = c.app.resourcesApi.listResources
  c.app.resourcesApi.listResources = () => new Promise(r => { release = () => r({}) })
  const api = new Api(c)
  const apps = []
  api._listen = (a) => { apps.push(a); return { close () {} } }
  api.start()
  await request(apps[0], 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  api.stop()
  c.app.resourcesApi.listResources = realList
  release()
  for (let i = 0; i < 5; i++) { await settled() }
  assert.equal(c.written.length, 0)
})

test('a route with no timestamp is named for when it arrived', async () => {
  // Falling through to a fixed string would give every such route the same name, which defeats the
  // one thing the name is for.
  const bare = JSON.parse(JSON.stringify(ORCA_ROUTE))
  delete bare.value.features[0].properties.updatedAt
  const { c, rest } = apiUnderTest()
  await request(rest, 'PUT', '/v1/navigation/route', bare)
  await settled()
  assert.equal(c.written.length, 1)
  assert.match(c.written[0].data.name, /^ORCA \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('a route stored before orcaIdentity existed is matched, not duplicated', async () => {
  // Anything published by the previous version carries orcaHash and nothing else. Failing to
  // recognise it would mean every upgrade silently duplicated the route it was already storing.
  const legacy = {
    name: 'ORCA active route',
    feature: { type: 'Feature', properties: { orcaHash: '1e937d58e7393a5d2c5b28a9835e8313' } }
  }
  const { c, rest } = apiUnderTest({ store: { 'legacy-id': legacy } })
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  assert.equal(c.written.length, 0)
})

test('cancelling navigation leaves the stored routes alone', async () => {
  // They are a library now, not a mirror of what the app is doing this minute.
  const { c, rest } = apiUnderTest()
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  const res = await request(rest, 'PUT', '/v1/navigation/route', EMPTY_ROUTE)
  await settled()
  assert.equal(res.status, 200)
  assert.deepEqual(c.deleted, [])
  assert.equal(Object.keys(c.store).length, 1)
})

test('nothing is written when publishing is off', async () => {
  const { c, rest } = apiUnderTest({ publishRoutes: false })
  await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await request(rest, 'PUT', '/v1/navigation/route', EMPTY_ROUTE)
  await settled()
  assert.equal(c.written.length, 0)
  assert.equal(c.deleted.length, 0)
})

test('a route is not written when the existing ones cannot be read', async () => {
  // Writing blind would add a duplicate on every push, which is worse than not writing at all.
  const { c, rest } = apiUnderTest({ failLists: true })
  const res = await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  assert.equal(res.status, 200, 'the app is still answered')
  assert.equal(c.written.length, 0)
  assert.equal(c.errors.length, 1)
  assert.match(c.errors[0], /no provider registered/)
})

test('a rejected write is surfaced, not just logged', async () => {
  // Silence here is what makes a misconfigured resource provider look like a working feature.
  const { c, rest } = apiUnderTest({ failWrites: true })
  const res = await request(rest, 'PUT', '/v1/navigation/route', ORCA_ROUTE)
  await settled()
  assert.equal(res.status, 200, 'the app is still answered')
  assert.equal(c.errors.length, 1)
  assert.match(c.errors[0], /no provider registered/)
})

test('an empty push is answered without touching the resources API at all', async () => {
  const { c, rest } = apiUnderTest()
  const res = await request(rest, 'PUT', '/v1/navigation/route', EMPTY_ROUTE)
  await settled()
  assert.equal(res.status, 200)
  assert.deepEqual(c.errors, [])
  assert.equal(c.written.length, 0)
  assert.equal(c.deleted.length, 0)
})

test('a body carrying no route is treated as cancelled, not published', async () => {
  const { c, rest } = apiUnderTest()
  const res = await request(rest, 'PUT', '/v1/navigation/route', { value: { nonsense: true } })
  await settled()
  assert.equal(res.status, 200)
  assert.equal(c.written.length, 0)
})

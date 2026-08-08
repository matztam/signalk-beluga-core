'use strict'

// The plugin can start before the network interface is fully up (observed on
// a fresh boot: ENETUNREACH sending to the mDNS multicast group). bonjour-
// service's default error handler is `(err) => { throw err }`, which would
// otherwise surface as an uncaught exception. These tests drive the same
// error paths bonjour-service/multicast-dns use internally and assert the
// process survives.

const test   = require('node:test')
const assert = require('node:assert/strict')
const Mdns   = require('../lib/mdns.js')

function mockApp () {
  const debugLines = []
  return { debug: (msg) => debugLines.push(msg), debugLines }
}

test('a network error on the mdns socket does not crash the process', (t) => {
  const app  = mockApp()
  const mdns = new Mdns({ app, deviceId: 'test01', deviceName: 'orca-test01', firmwareVersion: '1.0' })
  t.after(() => mdns.stop())

  mdns.start()

  const err = new Error('send ENETUNREACH 224.0.0.251:5353')
  err.code = 'ENETUNREACH'

  assert.doesNotThrow(() => mdns._bonjour.server.mdns.emit('warning', err))
  assert.doesNotThrow(() => mdns._bonjour.server.errorCallback(err))
  assert.ok(app.debugLines.some(l => l.includes('ENETUNREACH')), 'error should be logged via app.debug')
})

test('start() and stop() still work normally', (t) => {
  const app  = mockApp()
  const mdns = new Mdns({ app, deviceId: 'test01', deviceName: 'orca-test01', firmwareVersion: '1.0' })

  assert.doesNotThrow(() => mdns.start())
  assert.doesNotThrow(() => mdns.stop())
})

'use strict'

// The plugin can start before the network interface is fully up (observed on
// a fresh boot: ENETUNREACH sending to the mDNS multicast group). That
// specific error is thrown from inside Node's own dgram internals
// (doSend/afterDns) during the async DNS-resolution phase of a send() —
// a known Node limitation (nodejs/node#28664, nodejs/node#12841) where the
// error bypasses try/catch and the socket's own 'error'/'warning' events, so
// the only place left to catch it is a process-wide uncaughtException
// handler. These tests drive that handler the same way Node would.

const test   = require('node:test')
const assert = require('node:assert/strict')
const Mdns   = require('../lib/mdns.js')

function mockApp () {
  const debugLines = []
  return { debug: (msg) => debugLines.push(msg), debugLines }
}

function unreachableMdnsError () {
  const err = new Error('send ENETUNREACH 224.0.0.251:5353')
  err.code = 'ENETUNREACH'
  err.syscall = 'send'
  err.address = '224.0.0.251'
  err.port = 5353
  return err
}

// Exercises the registered listener function directly rather than via
// process.emit('uncaughtException', ...) — node:test installs its own
// uncaughtException handler that treats an emitted event as a real test
// failure, regardless of other listeners. Calling the function directly
// tests the same logic without fighting the test runner's own handling.
function findOurHandler (mdns) {
  return process.listeners('uncaughtException').find(l => l === mdns._onUncaught)
}

test('the boot-time ENETUNREACH case is caught and logged, not thrown', (t) => {
  const app  = mockApp()
  const mdns = new Mdns({ app, deviceId: 'test01', deviceName: 'orca-test01', firmwareVersion: '1.0' })
  t.after(() => mdns.stop())

  mdns.start()
  const handler = findOurHandler(mdns)
  assert.ok(handler, 'uncaughtException handler should be registered after start()')

  assert.doesNotThrow(() => handler(unreachableMdnsError()))
  assert.ok(
    app.debugLines.some(l => l.includes('network unreachable')),
    'should log via app.debug instead of staying silent'
  )
})

// Critical: throwing from inside an uncaughtException handler crashes the
// process outright, even past other handlers that would otherwise have kept
// it alive (verified manually against a real process — a re-throw here
// bypasses process-level handlers registered before this one). So for
// anything that isn't the known case, the handler must do nothing.
test('an unrelated uncaught exception is left alone, not thrown or logged as ours', (t) => {
  const app  = mockApp()
  const mdns = new Mdns({ app, deviceId: 'test01', deviceName: 'orca-test01', firmwareVersion: '1.0' })
  t.after(() => mdns.stop())

  mdns.start()
  const handler = findOurHandler(mdns)

  assert.doesNotThrow(() => handler(new Error('totally unrelated')))
  assert.ok(
    !app.debugLines.some(l => l.includes('network unreachable')),
    'unrelated errors must not be logged as the mDNS case'
  )
})

test('stop() removes the uncaughtException listener, no leak across restarts', () => {
  const app = mockApp()
  const before = process.listenerCount('uncaughtException')

  for (let i = 0; i < 5; i++) {
    const mdns = new Mdns({ app, deviceId: 'test01', deviceName: 'orca-test01', firmwareVersion: '1.0' })
    mdns.start()
    mdns.stop()
  }

  assert.equal(process.listenerCount('uncaughtException'), before)
})

test('start() and stop() still work normally', (t) => {
  const app  = mockApp()
  const mdns = new Mdns({ app, deviceId: 'test01', deviceName: 'orca-test01', firmwareVersion: '1.0' })

  assert.doesNotThrow(() => mdns.start())
  assert.doesNotThrow(() => mdns.stop())
})

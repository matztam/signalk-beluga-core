'use strict'

// The relay is exercised through _handleSync with fake sockets rather than over
// a real server: the WebSocket port is a fixed 8089, and node --test runs files
// in parallel, so binding it here would collide with plugin.test.js starting the
// whole plugin. Fakes also make delivery assertions synchronous — no waiting on
// a timeout to prove that something was *not* delivered.

const test   = require('node:test')
const assert = require('node:assert/strict')

const Ws = require('../lib/websocket.js')

const OPEN   = 1
const CLOSED = 3

function fakeSocket () {
  const handlers = {}
  return {
    readyState: OPEN,
    sent: [],
    on (event, fn) { (handlers[event] ??= []).push(fn) },
    send (data) { this.sent.push(data) },
    // Drive the socket from the test side.
    fire (event, ...args) { for (const fn of handlers[event] ?? []) fn(...args) }
  }
}

function relayWith (...sockets) {
  const server = new Ws({ app: { debug: () => {} } })
  for (const s of sockets) server._handleSync(s)
  return server
}

test('a frame is relayed to every other client', () => {
  const a = fakeSocket()
  const b = fakeSocket()
  const c = fakeSocket()
  relayWith(a, b, c)

  a.fire('message', Buffer.from('{"type":"routeHash","value":"abc123"}'))

  assert.deepEqual(b.sent, ['{"type":"routeHash","value":"abc123"}'])
  assert.deepEqual(c.sent, ['{"type":"routeHash","value":"abc123"}'])
})

test('the sender does not receive its own frame back', () => {
  const a = fakeSocket()
  const b = fakeSocket()
  relayWith(a, b)

  a.fire('message', Buffer.from('{"type":"routeHash","value":"def456"}'))

  assert.deepEqual(a.sent, [])
})

test('ping is answered on the sending socket only', () => {
  const a = fakeSocket()
  const b = fakeSocket()
  relayWith(a, b)

  a.fire('message', Buffer.from('{"cmd":"ping"}'))

  assert.deepEqual(a.sent, ['{"cmd":"pong"}'])
  assert.deepEqual(b.sent, [], 'ping must not be relayed as shared state')
})

test('malformed frames are ignored and leave the channel usable', () => {
  const a = fakeSocket()
  const b = fakeSocket()
  relayWith(a, b)

  a.fire('message', Buffer.from('not json'))
  assert.deepEqual(b.sent, [])

  a.fire('message', Buffer.from('{"type":"still","value":"alive"}'))
  assert.deepEqual(b.sent, ['{"type":"still","value":"alive"}'])
})

test('a closed or errored client is dropped from the relay', () => {
  const a = fakeSocket()
  const b = fakeSocket()
  const c = fakeSocket()
  relayWith(a, b, c)

  b.fire('close')
  c.fire('error', new Error('reset by peer'))
  a.fire('message', Buffer.from('{"type":"afterClose","value":1}'))

  assert.deepEqual(b.sent, [])
  assert.deepEqual(c.sent, [])
})

test('a client that is not OPEN is skipped without throwing', () => {
  const a = fakeSocket()
  const b = fakeSocket()
  const c = fakeSocket()
  relayWith(a, b, c)
  b.readyState = CLOSED

  a.fire('message', Buffer.from('{"type":"closing","value":1}'))

  assert.deepEqual(b.sent, [])
  assert.deepEqual(c.sent, ['{"type":"closing","value":1}'])
})

test('stop() forgets every registered client', () => {
  const a = fakeSocket()
  const b = fakeSocket()
  const server = relayWith(a, b)

  server.stop()

  assert.equal(server._syncClients.size, 0)
})

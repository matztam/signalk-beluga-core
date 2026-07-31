'use strict'

const test   = require('node:test')
const assert = require('node:assert/strict')

function mockApp () {
  const errors    = []
  const statuses  = []
  const savedOpts = []
  return {
    debug:             () => {},
    setPluginError:    (m) => errors.push(m),
    setPluginStatus:   (m) => statuses.push(m),
    savePluginOptions: (o, cb) => { savedOpts.push(o); if (cb) cb() },
    errors, statuses, savedOpts
  }
}

function schemaDefaults (schema) {
  const defaults = {}
  for (const [key, prop] of Object.entries(schema.properties)) {
    if ('default' in prop) defaults[key] = prop.default
  }
  return defaults
}

test('plugin factory returns a valid plugin object', () => {
  const factory = require('../index.js')
  const plugin  = factory(mockApp())

  assert.equal(typeof plugin, 'object')
  assert.equal(plugin.id, 'signalk-beluga-core')
  assert.equal(typeof plugin.name, 'string')
  assert.equal(typeof plugin.description, 'string')
  assert.equal(typeof plugin.schema, 'function')
  assert.equal(typeof plugin.uiSchema, 'function')
  assert.equal(typeof plugin.start, 'function')
  assert.equal(typeof plugin.stop, 'function')
})

test('schema() returns a valid JSON schema with defaults', () => {
  const factory = require('../index.js')
  const plugin  = factory(mockApp())
  const schema  = plugin.schema()

  assert.equal(schema.type, 'object')
  assert.ok(Array.isArray(schema.required))
  assert.ok(schema.properties && typeof schema.properties === 'object')
})

test('start() completes synchronously with schema defaults and reports status', async (t) => {
  const app     = mockApp()
  const factory = require('../index.js')
  const plugin  = factory(app)
  const defaults = schemaDefaults(plugin.schema())

  // Avoid touching real BLE/hardware/network setup in the test environment.
  defaults.enableBle  = false
  defaults.mayaraHost = ''

  t.after(() => plugin.stop())

  assert.doesNotThrow(() => plugin.start(defaults))
  assert.equal(app.errors.length, 0)
  assert.equal(app.statuses.length, 1)
  assert.match(app.statuses[0], /^Running/)
})

test('stop() tears down cleanly after start()', (t) => {
  const app     = mockApp()
  const factory = require('../index.js')
  const plugin  = factory(app)
  const defaults = schemaDefaults(plugin.schema())
  defaults.enableBle  = false
  defaults.mayaraHost = ''

  plugin.start(defaults)
  assert.doesNotThrow(() => plugin.stop())
  assert.equal(app.statuses.at(-1), 'Stopped')
})

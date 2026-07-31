'use strict'

const test   = require('node:test')
const assert = require('node:assert/strict')
const path   = require('path')
const fs     = require('fs')
const { spawn } = require('child_process')

const PIDFILE = path.join(__dirname, '..', '.ble_beacon.pid')

function isAlive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// Spawns a long-lived dummy process whose argv contains "ble_beacon.py", so
// Ble's killOrphan() (which greps /proc/<pid>/cmdline for that string)
// recognises and kills it exactly like a real orphaned beacon.
function spawnFakeOrphan () {
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', 'ble_beacon.py'])
  return proc
}

test('start() kills a leftover ble_beacon.py process from a previous run', async (t) => {
  const orphan = spawnFakeOrphan()
  await new Promise((resolve) => orphan.on('spawn', resolve))
  fs.writeFileSync(PIDFILE, String(orphan.pid))

  t.after(() => {
    try { fs.unlinkSync(PIDFILE) } catch {}
    try { process.kill(orphan.pid, 'SIGKILL') } catch {}
  })

  assert.equal(isAlive(orphan.pid), true, 'precondition: fake orphan is running')

  delete require.cache[require.resolve('../lib/ble.js')]
  const Ble = require('../lib/ble.js')
  const app = { debug: () => {}, setPluginError: () => {} }
  const ble = new Ble({ app, deviceName: 'orca-test', wifiSsid: '', firmwareVersion: '1', model: 'test' })

  ble.start()
  t.after(() => ble.stop())

  await new Promise((resolve) => { orphan.on('exit', resolve); setTimeout(resolve, 2000) })

  assert.equal(isAlive(orphan.pid), false, 'orphan should have been killed by killOrphan()')
})

test('start() does not touch a live process whose pidfile entry is stale/unrelated', async (t) => {
  // A pidfile pointing at a real process that is NOT a ble_beacon.py should
  // be left alone — killOrphan() must verify argv before killing.
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  await new Promise((resolve) => unrelated.on('spawn', resolve))
  fs.writeFileSync(PIDFILE, String(unrelated.pid))

  t.after(() => {
    try { fs.unlinkSync(PIDFILE) } catch {}
    try { process.kill(unrelated.pid, 'SIGKILL') } catch {}
  })

  delete require.cache[require.resolve('../lib/ble.js')]
  const Ble = require('../lib/ble.js')
  const app = { debug: () => {}, setPluginError: () => {} }
  const ble = new Ble({ app, deviceName: 'orca-test', wifiSsid: '', firmwareVersion: '1', model: 'test' })

  ble.start()
  t.after(() => ble.stop())

  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.equal(isAlive(unrelated.pid), true, 'unrelated process must survive killOrphan()')
})

test('start() cleans up a stale pidfile whose process is already dead', async (t) => {
  // Simulates the crash case: the beacon died (or the machine rebooted) but
  // stop() never ran, so the pidfile still names a PID nothing is using.
  const deadPid = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => deadPid.on('exit', resolve))
  fs.writeFileSync(PIDFILE, String(deadPid.pid))

  t.after(() => { try { fs.unlinkSync(PIDFILE) } catch {} })

  delete require.cache[require.resolve('../lib/ble.js')]
  const Ble = require('../lib/ble.js')
  const app = { debug: () => {}, setPluginError: () => {} }
  const ble = new Ble({ app, deviceName: 'orca-test', wifiSsid: '', firmwareVersion: '1', model: 'test' })

  assert.doesNotThrow(() => ble.start())
  t.after(() => ble.stop())

  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.equal(fs.existsSync(PIDFILE), true, 'a fresh pidfile should exist again (written by the new spawn)')
  assert.notEqual(
    parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10),
    deadPid.pid,
    'stale dead PID must not linger in the pidfile'
  )
})

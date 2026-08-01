'use strict'

const test   = require('node:test')
const assert = require('node:assert/strict')
const fs     = require('fs')
const { spawn } = require('child_process')
const { killOrphan, PIDFILE } = require('../lib/ble.js')

function isAlive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// Spawns a long-lived dummy process whose argv contains "ble_beacon.py", so
// killOrphan() (which greps /proc/<pid>/cmdline for that string) recognises
// and kills it exactly like a real orphaned beacon.
function spawnFakeOrphan () {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', 'ble_beacon.py'])
}

test('killOrphan() kills a leftover ble_beacon.py process and clears the pidfile', async (t) => {
  const orphan = spawnFakeOrphan()
  await new Promise((resolve) => orphan.on('spawn', resolve))
  fs.writeFileSync(PIDFILE, String(orphan.pid))

  t.after(() => {
    try { fs.unlinkSync(PIDFILE) } catch {}
    try { process.kill(orphan.pid, 'SIGKILL') } catch {}
  })

  assert.equal(isAlive(orphan.pid), true, 'precondition: fake orphan is running')

  killOrphan()

  await new Promise((resolve) => { orphan.on('exit', resolve); setTimeout(resolve, 2000) })

  assert.equal(isAlive(orphan.pid), false, 'orphan should have been killed')
  assert.equal(fs.existsSync(PIDFILE), false, 'pidfile should be removed')
})

test('killOrphan() does not touch a live process unrelated to ble_beacon.py', async (t) => {
  // A pidfile pointing at a real process that is NOT a ble_beacon.py should
  // be left alone — killOrphan() must verify argv before killing.
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  await new Promise((resolve) => unrelated.on('spawn', resolve))
  fs.writeFileSync(PIDFILE, String(unrelated.pid))

  t.after(() => {
    try { fs.unlinkSync(PIDFILE) } catch {}
    try { process.kill(unrelated.pid, 'SIGKILL') } catch {}
  })

  killOrphan()

  assert.equal(isAlive(unrelated.pid), true, 'unrelated process must survive killOrphan()')
  assert.equal(fs.existsSync(PIDFILE), false, 'pidfile for an unrelated process should still be cleared')
})

test('killOrphan() cleans up a stale pidfile whose process is already dead', async () => {
  // Simulates the crash case: the beacon died (or the machine rebooted) but
  // stop() never ran, so the pidfile still names a PID nothing is using.
  const deadPid = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => deadPid.on('exit', resolve))
  fs.writeFileSync(PIDFILE, String(deadPid.pid))

  assert.doesNotThrow(() => killOrphan())

  assert.equal(fs.existsSync(PIDFILE), false, 'stale pidfile should be removed')
})

test('killOrphan() is a no-op when no pidfile exists', () => {
  try { fs.unlinkSync(PIDFILE) } catch {}
  assert.doesNotThrow(() => killOrphan())
})

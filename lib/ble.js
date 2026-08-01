'use strict'

const { spawn, execFileSync } = require('child_process')
const path                    = require('path')
const fs                      = require('fs')

const SCRIPT     = path.join(__dirname, '..', 'ble_beacon.py')
const VENV       = path.join(__dirname, '..', '.venv')
const PYTHON     = path.join(VENV, 'bin', 'python3')
const PIP        = path.join(VENV, 'bin', 'pip')
const PIDFILE    = path.join(__dirname, '..', '.ble_beacon.pid')
const SETUP_TIMEOUT_MS = 60000

// Kills any ble_beacon.py left running from a previous Node process (e.g.
// after a crash or unclean server restart, where our stop() never ran and
// SIGTERM never reached the child). Verifies the PID is still our script
// before killing, in case it was recycled by an unrelated process.
function killOrphan () {
  let pid
  try { pid = parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10) } catch { return }
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    if (!cmdline.includes('ble_beacon.py')) { fs.unlinkSync(PIDFILE); return }
  } catch {
    // /proc/<pid> gone — process already dead, pidfile is stale
    try { fs.unlinkSync(PIDFILE) } catch {}
    return
  }
  try { process.kill(pid, 'SIGKILL') } catch {}
  try { fs.unlinkSync(PIDFILE) } catch {}
}

function writePid (pid) {
  try { fs.writeFileSync(PIDFILE, String(pid)) } catch {}
}

function clearPidFile (pid) {
  try {
    if (parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10) === pid) fs.unlinkSync(PIDFILE)
  } catch {}
}

const PACKAGES = [
  { import: 'bless',     pip: 'bless'     },
  { import: 'dbus_next', pip: 'dbus-next' },
]

class Ble {
  constructor (ctx) {
    this.ctx       = ctx
    this._proc     = null
    this._stopping = false
  }

  start () {
    const { app } = this.ctx

    try {
      execFileSync('python3', ['--version'], { stdio: 'pipe' })
    } catch {
      app.setPluginError('BLE: python3 not found — install Python 3')
      return false
    }

    // Guard against a duplicate advertiser: a previous Node process may have
    // died without calling stop(), leaving its ble_beacon.py child running.
    killOrphan()

    this._stopping = false
    this._setupAndSpawn()
    return true
  }

  _setupAndSpawn () {
    const { app } = this.ctx

    // If venv exists and all packages importable, go straight to spawn
    if (fs.existsSync(PYTHON)) {
      const missing = PACKAGES.filter(({ import: mod }) => {
        try { execFileSync(PYTHON, ['-c', `import ${mod}`], { stdio: 'pipe' }); return false }
        catch { return true }
      })
      if (missing.length === 0) { this._spawn(); return }
    }

    // First run: create venv + pip-install (async, non-blocking)
    app.debug('BLE: first run — creating venv + installing bless / dbus-next…')

    const pipPackages = PACKAGES.map(p => p.pip)

    const runStep = (steps) => {
      if (steps.length === 0) { this._spawn(); return }
      const [cmd, args] = steps[0]
      const remaining   = steps.slice(1)
      const proc = spawn(cmd, args)
      const timer = setTimeout(() => {
        app.setPluginError('BLE: setup timed out (no network?) — disabling BLE for this session')
        proc.kill('SIGKILL')
      }, SETUP_TIMEOUT_MS)
      proc.stdout.on('data', d => app.debug(`BLE setup: ${d.toString().trimEnd()}`))
      proc.stderr.on('data', d => app.debug(`BLE setup: ${d.toString().trimEnd()}`))
      proc.on('exit', code => {
        clearTimeout(timer)
        if (this._stopping) return
        if (code !== 0) { app.setPluginError('BLE: Python dependency installation failed — check debug log'); return }
        runStep(remaining)
      })
      proc.on('error', err => { clearTimeout(timer); app.setPluginError(`BLE: setup error — ${err.message}`) })
    }

    runStep([
      ['python3', ['-m', 'venv', VENV]],
      [PIP,       ['install', '--quiet', ...pipPackages]],
    ])
  }

  _spawn () {
    const { app, deviceName, wifiSsid, firmwareVersion, model } = this.ctx

    const env = {
      ...process.env,
      ORCA_DEVICE_NAME:      deviceName,
      ORCA_WIFI_SSID:        wifiSsid,
      ORCA_FIRMWARE_VERSION: firmwareVersion,
      ORCA_MODEL:            model,
    }

    const proc = spawn(PYTHON, [SCRIPT], { env })
    this._proc = proc

    proc.stdout.on('data', d => app.debug(`BLE: ${d.toString().trimEnd()}`))
    proc.stderr.on('data', d => app.debug(`BLE: ${d.toString().trimEnd()}`))

    proc.on('spawn', () => {
      app.debug(`BLE: ble_beacon.py started (pid=${proc.pid})`)
      writePid(proc.pid)
    })

    proc.on('exit', (code, signal) => {
      this._proc = null
      clearPidFile(proc.pid)
      if (this._stopping) return
      app.debug(`BLE: exited (code=${code} signal=${signal}), restarting in 5s`)
      setTimeout(() => { if (!this._stopping) this._spawn() }, 5000)
    })

    proc.on('error', err => app.debug(`BLE: failed to start — ${err.message}`))
  }

  stop () {
    this._stopping = true
    if (this._proc) {
      clearPidFile(this._proc.pid)
      this._proc.kill('SIGTERM')
      this._proc = null
    }
  }
}

module.exports = Ble
module.exports.killOrphan = killOrphan
module.exports.PIDFILE    = PIDFILE

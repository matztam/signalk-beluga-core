'use strict'

const { spawn, execFileSync } = require('child_process')
const path                    = require('path')
const fs                      = require('fs')

const SCRIPT = path.join(__dirname, '..', 'ble_beacon.py')
const VENV   = path.join(__dirname, '..', '.venv')
const PYTHON = path.join(VENV, 'bin', 'python3')
const PIP    = path.join(VENV, 'bin', 'pip')

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
      proc.stdout.on('data', d => app.debug(`BLE setup: ${d.toString().trimEnd()}`))
      proc.stderr.on('data', d => app.debug(`BLE setup: ${d.toString().trimEnd()}`))
      proc.on('exit', code => {
        if (this._stopping) return
        if (code !== 0) { app.setPluginError('BLE: Python dependency installation failed — check debug log'); return }
        runStep(remaining)
      })
      proc.on('error', err => app.setPluginError(`BLE: setup error — ${err.message}`))
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

    proc.on('spawn', () => app.debug(`BLE: ble_beacon.py started (pid=${proc.pid})`))

    proc.on('exit', (code, signal) => {
      this._proc = null
      if (this._stopping) return
      app.debug(`BLE: exited (code=${code} signal=${signal}), restarting in 5s`)
      setTimeout(() => { if (!this._stopping) this._spawn() }, 5000)
    })

    proc.on('error', err => app.debug(`BLE: failed to start — ${err.message}`))
  }

  stop () {
    this._stopping = true
    if (this._proc) {
      this._proc.kill('SIGTERM')
      this._proc = null
    }
  }
}

module.exports = Ble

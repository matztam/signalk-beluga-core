'use strict'

// Source IDs used in the ORCA sensor delta format.
const NAV_SRC  = 254  // navigation + environment
const WIND_SRC = 5    // wind
const PROP_SRC = 150  // propulsion / engine
const BATT_SRC = 160  // electrical / battery banks
const TANK_SRC = 170  // fluid tanks
const RUDD_SRC = 151  // rudder
const AP_SRC   = 152  // autopilot / heading control

// SignalK tank fluid-type keys → ORCA fluid type values
const SK_TANK_TYPES = {
  fuel:         0,
  freshWater:   1,
  wasteWater:   2,
  liveWell:     3,
  oil:          4,
  blackWater:   5,
  fuelGasoline: 6,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Only write a value when it's a real, finite number.
function put(values, key, val) {
  if (val != null && typeof val === 'number' && isFinite(val)) values[key] = val
}

// Get the self-vessel node from the full SignalK state tree.
// app.selfContext is e.g. "vessels.urn:mrn:imo:mmsi:211099001".
function selfVessel(app) {
  try {
    const state   = app.signalk.retrieve()
    const vessels = state?.vessels ?? {}
    const ctx     = app.selfContext ?? ''
    // retrieve() keys may or may not carry the "vessels." prefix — try both
    return vessels[ctx] ?? vessels[ctx.replace(/^vessels\./, '')] ?? {}
  } catch { return {} }
}

// ─────────────────────────────────────────────────────────────────────────────
// Propulsion
// ─────────────────────────────────────────────────────────────────────────────

function addPropulsion(vessel, values, devices) {
  const propulsion = vessel.propulsion
  if (!propulsion || typeof propulsion !== 'object') return

  let inst = 0
  for (const eng of Object.values(propulsion)) {
    if (!eng || typeof eng !== 'object') continue

    const pfx = `propulsion.${PROP_SRC}.${inst}`

    // SignalK revolutions is in Hz (rev/s); ORCA expects RPM
    const revs = eng.revolutions?.value
    if (revs != null) put(values, `${pfx}.speed`, revs * 60)

    put(values, `${pfx}.temperature`,      eng.temperature?.value)
    put(values, `${pfx}.oilPressure`,      eng.oilPressure?.value)
    put(values, `${pfx}.oilTemperature`,   eng.oilTemperature?.value)
    put(values, `${pfx}.fuelRate`,         eng.fuelRate?.value)
    put(values, `${pfx}.torque`,           eng.torque?.value)
    put(values, `${pfx}.totalHours`,       eng.runTime?.value)
    put(values, `${pfx}.boostPressure`,    eng.boostPressure?.value)
    put(values, `${pfx}.trim`,             eng.trim?.value)
    put(values, `${pfx}.altenatorVoltage`, eng.alternatorVoltage?.value)

    // SignalK engineLoad is a ratio 0–1; ORCA expects %
    const load = eng.engineLoad?.value
    if (load != null) put(values, `${pfx}.load`, load * 100)

    devices[String(PROP_SRC)] = '0'
    inst++
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Battery / Electrical
// ─────────────────────────────────────────────────────────────────────────────

function addBattery(vessel, values, devices) {
  const batteries = vessel.electrical?.batteries
  if (!batteries || typeof batteries !== 'object') return

  let inst = 0
  for (const bat of Object.values(batteries)) {
    if (!bat || typeof bat !== 'object') continue

    const pfx = `battery.${BATT_SRC}.${inst}`

    put(values, `${pfx}.voltage`,       bat.voltage?.value)
    put(values, `${pfx}.current`,       bat.current?.value)
    put(values, `${pfx}.temperature`,   bat.temperature?.value)
    put(values, `${pfx}.rippleVoltage`, bat.rippleVoltage?.value)

    // SignalK stateOfCharge / stateOfHealth are ratios 0–1; ORCA expects %
    const soc = bat.capacity?.stateOfCharge?.value
    if (soc != null) put(values, `${pfx}.charge`, soc * 100)

    const soh = bat.capacity?.stateOfHealth?.value
    if (soh != null) put(values, `${pfx}.health`, soh * 100)

    // SignalK timeRemaining is in seconds; ORCA expects minutes
    const tr = bat.capacity?.timeRemaining?.value
    if (tr != null) put(values, `${pfx}.timeRemaining`, tr / 60)

    // SignalK capacity.nominal is in Coulombs; ORCA expects Ah
    const cap = bat.capacity?.nominal?.value
    if (cap != null) put(values, `${pfx}.ampHours`, cap / 3600)

    devices[String(BATT_SRC)] = '0'
    inst++
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tanks
// ─────────────────────────────────────────────────────────────────────────────

function addTanks(vessel, values, devices) {
  const tanks = vessel.tanks
  if (!tanks || typeof tanks !== 'object') return

  let inst = 0
  for (const [fluidType, instances] of Object.entries(tanks)) {
    const typeCode = SK_TANK_TYPES[fluidType]
    if (typeCode == null || !instances || typeof instances !== 'object') continue

    for (const tank of Object.values(instances)) {
      if (!tank || typeof tank !== 'object') continue

      const pfx = `tank.${TANK_SRC}.${inst}`
      values[`${pfx}.type`] = typeCode

      // SignalK currentLevel is a ratio 0–1; ORCA expects %
      const level = tank.currentLevel?.value
      if (level != null) put(values, `${pfx}.level`, level * 100)

      put(values, `${pfx}.capacity`, tank.capacity?.value)

      devices[String(TANK_SRC)] = '0'
      inst++
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Steering (rudder + autopilot / heading control)
// ─────────────────────────────────────────────────────────────────────────────

function addSteering(vessel, values, devices) {
  const rudder = vessel.steering?.rudderAngle?.value
  if (rudder != null) {
    put(values, `steering.rudder.${RUDD_SRC}.0.position`, rudder)
    devices[String(RUDD_SRC)] = '0'
  }

  const ap = vessel.steering?.autopilot
  if (!ap) return

  const state      = ap.state?.value
  const targetTrue = ap.target?.headingTrue?.value
  const targetMag  = ap.target?.headingMagnetic?.value
  const targetWind = ap.target?.windAngleApparent?.value
  const course     = targetTrue ?? targetMag

  let hasAp = false

  if (state != null) {
    const s = String(state).toLowerCase()
    values[`autopilot.${AP_SRC}.state`] = (s === 'standby') ? 0 : 1

    // Map SignalK mode strings to ORCA autopilot mode values
    let mode = 0
    if      (s === 'auto' || s === 'heading-control') mode = 1
    else if (s === 'no-drift' || s === 'track')       mode = 2
    else if (s === 'route'    || s === 'nav')         mode = 3
    else if (s === 'wind')                            mode = 7
    values[`autopilot.${AP_SRC}.mode`] = mode
    hasAp = true
  }

  if (course != null) {
    put(values, `autopilot.${AP_SRC}.course`, course)
    put(values, `steering.headingControl.${AP_SRC}.headingToSteer`, course)
    values[`steering.headingControl.${AP_SRC}.reference`] = targetTrue != null ? 0 : 1
    hasAp = true
  }

  if (targetWind != null) {
    put(values, `autopilot.${AP_SRC}.windHoldAngle`, targetWind)
    hasAp = true
  }

  if (hasAp) {
    // Ensure state/mode are always present — ORCA requires them for detection.
    // Default to standby (0) if the autopilot plugin hasn't written state yet.
    if (values[`autopilot.${AP_SRC}.state`] == null) {
      values[`autopilot.${AP_SRC}.state`] = 0
      values[`autopilot.${AP_SRC}.mode`]  = 0
    }
    values[`autopilot.${AP_SRC}.type`] = 0  // 0 = SIMNET/Simrad
    devices[String(AP_SRC)] = '0'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main sensor delta  (ws://.../v1/sensors/delta)
// ─────────────────────────────────────────────────────────────────────────────

function buildSensorDelta(app, deviceId) {
  const vessel  = selfVessel(app)
  const nav     = vessel.navigation   ?? {}
  const envData = vessel.environment  ?? {}

  const devices = { [String(NAV_SRC)]: '0' }
  const values  = {}

  // ── Position ──────────────────────────────────────────────────────────────
  const pos = nav.position?.value ?? {}
  if (pos.latitude  != null) values[`navigation.position.${NAV_SRC}.latitude`]  = pos.latitude
  if (pos.longitude != null) values[`navigation.position.${NAV_SRC}.longitude`] = pos.longitude

  // ── GNSS ──────────────────────────────────────────────────────────────────
  if (pos.latitude  != null) values[`navigation.gnss.${NAV_SRC}.latitude`]  = pos.latitude
  if (pos.longitude != null) values[`navigation.gnss.${NAV_SRC}.longitude`] = pos.longitude
  values[`navigation.gnss.${NAV_SRC}.datetime`] = new Date().toISOString()
  if (pos.latitude != null) values[`navigation.gnss.${NAV_SRC}.method`] = 1
  put(values, `navigation.gnss.${NAV_SRC}.altitude`,   nav.gnss?.antennaAltitude?.value)
  put(values, `navigation.gnss.${NAV_SRC}.satellites`, nav.gnss?.satellites?.value)
  put(values, `navigation.gnss.${NAV_SRC}.HDOP`,       nav.gnss?.horizontalDilution?.value)
  put(values, `navigation.gnss.${NAV_SRC}.PDOP`,       nav.gnss?.positionDilution?.value)

  // ── COG / SOG ─────────────────────────────────────────────────────────────
  const cog = nav.courseOverGroundTrue?.value
  const sog = nav.speedOverGround?.value
  put(values, `navigation.cogsog.${NAV_SRC}.course`, cog)
  put(values, `navigation.cogsog.${NAV_SRC}.speed`,  sog)
  if (cog != null || sog != null) values[`navigation.cogsog.${NAV_SRC}.headingReference`] = 0

  // ── Heading ───────────────────────────────────────────────────────────────
  const hdgTrue = nav.headingTrue?.value
  const hdgMag  = nav.headingMagnetic?.value
  const hdg     = hdgTrue ?? hdgMag
  put(values, `navigation.heading.${NAV_SRC}.heading`, hdg)
  if (hdg != null) values[`navigation.heading.${NAV_SRC}.reference`] = hdgTrue != null ? 0 : 1
  put(values, `navigation.heading.${NAV_SRC}.deviation`, nav.headingDeviation?.value)
  const magvar = nav.magneticVariation?.value
  if (magvar != null) put(values, `navigation.heading.${NAV_SRC}.variation`, magvar)
  put(values, `navigation.heading.${NAV_SRC}.rot`, nav.rateOfTurn?.value)

  // ── Magnetic variation ────────────────────────────────────────────────────
  if (magvar != null) put(values, `navigation.magvar.${NAV_SRC}.variation`, magvar)

  // ── Attitude ──────────────────────────────────────────────────────────────
  const att = nav.attitude?.value ?? {}
  if (att.pitch != null) values[`environment.attitude.${NAV_SRC}.pitch`] = att.pitch
  if (att.roll  != null) values[`environment.attitude.${NAV_SRC}.roll`]  = att.roll
  if (att.yaw   != null) values[`environment.attitude.${NAV_SRC}.yaw`]   = att.yaw

  // ── Depth ─────────────────────────────────────────────────────────────────
  put(values, `environment.depth.${NAV_SRC}.belowTransducer`, envData.depth?.belowTransducer?.value)
  put(values, `environment.depth.${NAV_SRC}.offset`,          envData.depth?.surfaceToKeel?.value)

  // ── Water speed ───────────────────────────────────────────────────────────
  const wSpeed = envData.water?.speed?.value
  put(values, `environment.waterSpeed.${NAV_SRC}.waterReferenced`,      wSpeed)
  // SOG is the best available proxy for ground-referenced speed
  put(values, `environment.waterSpeed.${NAV_SRC}.speedGroundReferenced`, sog)
  const anySpeed = wSpeed ?? sog
  if (anySpeed != null) {
    values[`environment.waterSpeed.${NAV_SRC}.referenceType`] = 1
    put(values, `environment.waterSpeed.${NAV_SRC}.speed`, anySpeed)
  }

  // ── Temperature ───────────────────────────────────────────────────────────
  const wTemp = envData.water?.temperature?.value
  if (wTemp != null) {
    values[`environment.temperature.${NAV_SRC}.0.temperature`] = wTemp
    values[`environment.temperature.${NAV_SRC}.0.source`]      = 0
  }

  // ── Pressure ──────────────────────────────────────────────────────────────
  const pressure = envData.outside?.pressure?.value
  if (pressure != null) {
    values[`environment.pressure.${NAV_SRC}.0.pressure`] = pressure
    values[`environment.pressure.${NAV_SRC}.0.source`]   = 0
  }

  // ── Wind ──────────────────────────────────────────────────────────────────
  // Prefer apparent wind; fall back to true-water, then true-ground
  const windAngleApp  = envData.wind?.angleApparent?.value
  const windAngleTrW  = envData.wind?.angleTrueWater?.value
  const windAngleTrG  = envData.wind?.angleTrueGround?.value
  const windSpeedApp  = envData.wind?.speedApparent?.value
  const windSpeedTrue = envData.wind?.speedTrue?.value

  const windAngle = windAngleApp ?? windAngleTrW ?? windAngleTrG
  const windSpeed = windSpeedApp ?? windSpeedTrue

  if (windAngle != null || windSpeed != null) {
    let windRef
    if      (windAngleApp != null) windRef = 2   // APPARENT
    else if (windAngleTrW != null) windRef = 4   // TRUE_WATER
    else                           windRef = 0   // TRUE_NORTH (ground-referenced)

    put(values, `environment.wind.${WIND_SRC}.angle`, windAngle)
    put(values, `environment.wind.${WIND_SRC}.speed`, windSpeed)
    if (windAngle != null) values[`environment.wind.${WIND_SRC}.reference`] = windRef
    devices[String(WIND_SRC)] = '0'
  }

  // ── Dynamic sources ───────────────────────────────────────────────────────
  addPropulsion(vessel, values, devices)
  addBattery(vessel, values, devices)
  addTanks(vessel, values, devices)
  addSteering(vessel, values, devices)

  return {
    context:        `vessels.${deviceId}`,
    timestamp:      new Date().toISOString(),
    event_type:     'delta',
    devicesUpdated: false,
    values,
    values_age:     Object.fromEntries(Object.keys(values).map(k => [k, 0])),
    devices,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AIS delta  (ws://.../v1/sensors/delta?ns=ais)
// ─────────────────────────────────────────────────────────────────────────────

function buildAisDelta(app, deviceId) {
  const values = {}

  try {
    const state   = app.signalk.retrieve()
    const vessels = state?.vessels ?? {}
    const selfCtx = app.selfContext

    for (const [ctx, vessel] of Object.entries(vessels)) {
      if (ctx === selfCtx) continue

      const mmsi = vessel.mmsi?.value
                ?? ctx.match(/mmsi:(\d+)/)?.[1]
                ?? ctx.replace(/\D/g, '').slice(-9)
      if (!mmsi || String(mmsi).length < 7) continue

      const p   = `ais.vessels.${mmsi}.position`
      const nav = vessel.navigation ?? {}

      const pos = nav.position?.value
      if (pos?.latitude  != null) values[`${p}.latitude`]  = pos.latitude
      if (pos?.longitude != null) values[`${p}.longitude`] = pos.longitude

      const cog = nav.courseOverGroundTrue?.value
      if (cog != null) values[`${p}.COG`] = cog

      const sog = nav.speedOverGround?.value
      if (sog != null) values[`${p}.SOG`] = sog

      const hdg = nav.headingTrue?.value ?? nav.headingMagnetic?.value
      if (hdg != null) values[`${p}.headingTrue`] = hdg

      const name = vessel.name?.value
      if (name) values[`${p}.name`] = name

      const callsign = vessel.communication?.callsignVhf?.value
      if (callsign) values[`${p}.callsign`] = callsign

      const vesselType = vessel.design?.aisShipType?.value?.id
      if (vesselType != null) values[`${p}.vesselType`] = vesselType

      const dest = nav.destination?.commonName?.value
      if (dest != null) values[`${p}.destination`] = dest

      const eta = nav.destination?.eta?.value
      if (eta != null) {
        values[`${p}.eta`] = typeof eta === 'string' ? eta : new Date(eta).toISOString()
      }

      const length = vessel.design?.length?.overall?.value
      if (length != null) values[`${p}.length`] = length

      const beam = vessel.design?.beam?.value
      if (beam != null) values[`${p}.beam`] = beam

      const draft = vessel.design?.draft?.maximum?.value
      if (draft != null) values[`${p}.draft`] = draft
    }

    // own MMSI with tranceiverInfo=2 → activates AIS receiver indicator
    const selfMmsi = app.getSelfPath('mmsi')?.value
    if (selfMmsi) {
      values[`ais.vessels.${selfMmsi}.position.tranceiverInfo`] = 2
    }
  } catch {
    // AIS is best-effort — never crash the delta loop
  }

  return {
    context:    `vessels.${deviceId}`,
    timestamp:  new Date().toISOString(),
    event_type: 'delta',
    values,
    values_age: Object.fromEntries(Object.keys(values).map(k => [k, 0])),
  }
}

module.exports = { buildSensorDelta, buildAisDelta }

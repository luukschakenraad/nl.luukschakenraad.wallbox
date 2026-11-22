'use strict'

/**
 * Number of phases the car charges on
 *
 * The Wallbox API has no phase field, only config_data.phase_switch.enabled.
 * While charging, power / (230 V x set current) gives the phases in use, as
 * long as the car draws the full set current. The car decides (1, 2 or 3
 * phases), and some chargers switch from 3 to 1 phase for solar charging.
 */

const { STATUS, CAR_CONNECTED, VOLT, MIN_AMP } = require('./contract')

const MIN_KW = 1 // Ignore readings while power ramps up
const MARGIN = 0.1 // Ratio within 10% of a whole number of phases
const STABLE_MS = 60 * 1000 // Same reading this long (quick polls come soon after a change)

/**
 * Phases for one poll, or null when it doesn't fit a whole number
 * (car draws less than the set current, or stale power after a change)
 *
 * @param {string} status - STATUS id
 * @param {number|null} amps - set current
 * @param {number} kw - charging power
 * @return {number|null} 1, 2, 3 or null
 */
function reading(status, amps, kw) {
  if (status !== STATUS.CHARGING || !(amps >= MIN_AMP) || !(kw >= MIN_KW))
    return null

  const ratio = (kw * 1000) / (VOLT * amps)
  const phases = Math.round(ratio)
  if (phases < 1 || phases > 3 || Math.abs(ratio / phases - 1) > MARGIN)
    return null
  return phases
}

class PhaseMeter {

  /**
   * @param {number} last - phases of the last session, if known (store value 'phases')
   */
  constructor(last) {
    this.last = [1, 2, 3].includes(last) ? last : 1
    this.session = null // highest stable reading this session
    this.prev = null // first poll of the current reading
  }

  /**
   * Last known phases: this session, else the last session (for amps and the slider maximum)
   */
  get phases() {
    return this.session || this.last
  }

  /**
   * Phases measured this session, else 1 (lowest minimum, so any car can start)
   */
  get measured() {
    return this.session || 1
  }

  /**
   * Update with a poll of the charger
   *
   * A reading counts when it stays the same, at the same set current, for at
   * least a minute. The highest reading of a session wins, so tapering near
   * full or a switch to 1 phase never raises the current. Without a car
   * (ready, locked) the session ends: the next car may charge on other phases.
   *
   * @param {string} status - STATUS id
   * @param {number|null} amps - set current (View.maxCurrent)
   * @param {number} kw - charging power in kW (View.powerW / 1000)
   * @param {number} now - time in ms
   * @return {number} phases in use
   */
  update(status, amps, kw, now) {
    if (CAR_CONNECTED[status] === false) {
      this.session = null
      this.prev = null
      return this.phases
    }

    const phases = reading(status, amps, kw)
    const prev = this.prev
    if (!phases || !prev || prev.amps !== amps || prev.phases !== phases) {
      this.prev = phases ? { amps, phases, at: now } : null
      return this.phases
    }

    if (now - prev.at >= STABLE_MS && (!this.session || phases > this.session)) {
      this.session = phases
      this.last = phases
    }
    return this.phases
  }

}

module.exports = { PhaseMeter, reading, MIN_AMP }

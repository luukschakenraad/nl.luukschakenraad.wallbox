'use strict'

/**
 * Pure decisions for one charger: amps for a target power, the Homey Energy
 * reconcile, the current throttle and the follow check after a Start or Stop.
 * No clock, timers or I/O: everything comes in as an argument.
 *
 * Core rule: others can change the charger at any time. The latest poll (a
 * View) is the truth, never our own last write.
 */

const {
  STATUS, CAR_CONNECTED, GROUP, GROUP_MEMBERS, COMMAND, REASON, START_REASON, MODE, TIMING,
  VOLT, MIN_AMP, MAX_AMP
} = require('../contract')

const FLOWING = GROUP_MEMBERS[GROUP.CHARGING] // power flows
const WAITING = GROUP_MEMBERS[GROUP.WAITING]

/**
 * Highest current that can be set
 *
 * @param {number|null} maxAvailable - View.maxAvailable, A
 * @return {number} A, at most MAX_AMP
 */
function maxAmps(maxAvailable) {
  return maxAvailable > 0 ? Math.min(maxAvailable, MAX_AMP) : MAX_AMP
}

/**
 * Current for a target power, rounded down so the target is never exceeded
 *
 * @param {number} watts - target power
 * @param {number} phases - phases the car charges on
 * @param {number|null} maxAvailable - View.maxAvailable, A
 * @return {number} A, MIN_AMP .. maxAmps(maxAvailable)
 */
function ampsForPower(watts, phases, maxAvailable) {
  const amps = Math.floor((Number(watts) || 0) / (VOLT * (phases || 1)))
  return Math.max(MIN_AMP, Math.min(amps, maxAmps(maxAvailable)))
}

/**
 * Lowest power the car can charge at
 *
 * @param {number} measuredPhases - phases measured this session, else 1
 * @return {number} W
 */
function minPower(measuredPhases) {
  return MIN_AMP * VOLT * (measuredPhases || 1)
}

/**
 * Options of the target_power capability (slider)
 *
 * @param {number|null} maxAvailable - View.maxAvailable, A
 * @param {number} phases - last known phases, for the step (the maximum is always 3 phases)
 * @param {number} measuredPhases - phases measured this session, else 1, for the minimum
 * @return {Object} { min, max, step, excludeMin, excludeMax }
 */
function targetOptions(maxAvailable, phases, measuredPhases) {
  return {
    min: 0,
    max: maxAmps(maxAvailable) * VOLT * 3, // the charger's full range: the car's phases may not be known yet
    step: VOLT * phases,
    excludeMin: 0,
    excludeMax: minPower(measuredPhases)
  }
}

/**
 * The status says a car is connected and the charger takes commands
 * (not locked, not offline or updating)
 *
 * @param {Object} view - View
 * @return {boolean}
 */
function controllable(view) {
  return CAR_CONNECTED[view.status] === true && view.status !== STATUS.LOCKED_CAR
}

/**
 * Lifecycle of our own pause from target power, after a poll
 *
 * - a poll showing paused confirms it;
 * - after confirmation, any other status clears it, except the inconclusive
 *   ones (updating, error, offline, unknown);
 * - no car clears it;
 * - unconfirmed after TIMING.TARGET_PAUSE_EXPIRE, it's dropped.
 *
 * @param {Object|null} targetPaused - { at, confirmed } or null
 * @param {Object|null} view - View, null before the first poll
 * @param {number} now - ms
 * @return {Object|null} { at, confirmed } or null
 */
function nextTargetPaused(targetPaused, view, now) {
  if (!targetPaused || !view)
    return targetPaused || null

  const car = CAR_CONNECTED[view.status]
  if (car === false)
    return null
  if (view.status === STATUS.PAUSED)
    return targetPaused.confirmed ? targetPaused : { at: targetPaused.at, confirmed: true }
  if (targetPaused.confirmed)
    return car == null ? targetPaused : null
  return now - targetPaused.at >= TIMING.TARGET_PAUSE_EXPIRE ? null : targetPaused
}

/**
 * What Homey Energy wants from the charger now
 *
 * Only acts in Homey mode. The amps follow the target while a car is
 * connected, also when someone changed them elsewhere. Pause when the target
 * is below the minimum while power flows. Resume only our own, confirmed
 * pause, from paused, when the target is at or above the minimum: never a
 * pause of someone else, and never from waiting, scheduled or locked.
 *
 * @param {Object} input
 * @param {Object|null} input.view - latest View; maxCurrent is the observed current
 * @param {string|null} input.mode - target_power_mode
 * @param {number|null} input.target - target_power, W
 * @param {number} input.phases - last known phases
 * @param {number} input.measuredPhases - phases measured this session, else 1
 * @param {Object|null} input.targetPaused - our own pause { at, confirmed } or null
 * @param {number} input.now - ms
 * @return {Object} { amps: A|null (null: unchanged), action: 'pause'|'resume'|null,
 *   targetPaused: the value after the action }
 */
function reconcile({ view, mode, target, phases, measuredPhases, targetPaused, now }) {
  const kept = nextTargetPaused(targetPaused, view, now)
  const result = { amps: null, action: null, targetPaused: kept }
  if (mode !== MODE.HOMEY || target == null || !view || !controllable(view))
    return result

  // Below the minimum the charger pauses or stays paused: no current write
  const below = target < minPower(measuredPhases)
  const amps = ampsForPower(target, phases, view.maxAvailable)
  if (!below && amps !== view.maxCurrent)
    result.amps = amps

  if (below && FLOWING.includes(view.status)) {
    result.action = 'pause'
    result.targetPaused = { at: now, confirmed: false }
  } else if (!below && view.status === STATUS.PAUSED && kept && kept.confirmed) {
    result.action = 'resume'
    result.targetPaused = null
  }
  return result
}

/**
 * Current throttle: at most one increase per TIMING.INCREASE_WINDOW,
 * decreases at once. The result always replaces a queued value, so the
 * newest wanted value wins and it never sticks on an old one.
 *
 * @param {Object} input
 * @param {number} input.wanted - A
 * @param {number|null} input.observed - latest polled current, or the PUT response after it
 * @param {number|null} input.lastIncreaseAt - ms of the last increase sent, null if none
 * @param {Object|null} input.queued - queued increase { amps, at }, replaced by the result
 * @param {number} input.now - ms
 * @return {Object} { send: A|null, queue: { amps, at }|null }
 */
function planCurrent({ wanted, observed, lastIncreaseAt, now }) {
  if (wanted === observed)
    return { send: null, queue: null }
  if (observed != null && wanted < observed)
    return { send: wanted, queue: null }
  if (lastIncreaseAt == null || now - lastIncreaseAt >= TIMING.INCREASE_WINDOW)
    return { send: wanted, queue: null }
  return { send: null, queue: { amps: wanted, at: lastIncreaseAt + TIMING.INCREASE_WINDOW } }
}

/**
 * Did the charger follow a Start or Stop, at a poll after it
 *
 * Start: charging or discharging is followed, other statuses give their
 * START_REASON. Waiting reasons only count at the second waiting poll in a
 * row (a resume may pass Waiting before Charging).
 * Stop: charging or discharging gives still_charging, the rest is followed.
 * Both: 'wait' statuses (updating, offline, unknown) check again next poll.
 *
 * @param {string} command - COMMAND id
 * @param {Object} view - View
 * @param {boolean} seenWaiting - the previous poll showed a waiting status
 * @return {Object} { done, reason: REASON id|null (null: followed), seenWaiting }
 */
function followCheck(command, view, seenWaiting) {
  const status = view.status
  const reason = START_REASON[status]
  if (reason === 'wait')
    return { done: false, reason: null, seenWaiting }

  const flowing = FLOWING.includes(status)
  if (command === COMMAND.STOP)
    return { done: true, reason: flowing ? REASON.STILL_CHARGING : null, seenWaiting: false }
  if (flowing)
    return { done: true, reason: null, seenWaiting: false }

  const waiting = WAITING.includes(status)
  if (waiting && !seenWaiting)
    return { done: false, reason: null, seenWaiting: true }
  return { done: true, reason: reason || null, seenWaiting: waiting }
}

module.exports = {
  maxAmps,
  ampsForPower,
  minPower,
  targetOptions,
  controllable,
  nextTargetPaused,
  reconcile,
  planCurrent,
  followCheck
}

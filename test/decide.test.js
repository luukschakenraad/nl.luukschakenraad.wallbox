'use strict'

// Run with: node --test test/
const test = require('node:test')
const assert = require('node:assert')
const decide = require('../lib/charger/decide')
const { PhaseMeter } = require('../lib/phases')
const { STATUS, CAR_CONNECTED, COMMAND, REASON, START_REASON, GROUP, GROUP_MEMBERS, MODE, TIMING } = require('../lib/contract')

const { ampsForPower, minPower, targetOptions, reconcile, planCurrent, followCheck, nextTargetPaused } = decide
const WINDOW = TIMING.INCREASE_WINDOW

function view(status, extra = {}) {
  return { status, carConnected: CAR_CONNECTED[status], maxCurrent: 13, maxAvailable: 32, powerW: 0, locked: false, ...extra }
}

// Homey mode, 1 phase, no own pause, at t = 0
function homey(status, target, extra = {}) {
  return reconcile({ view: view(status, extra.view), mode: MODE.HOMEY, target, phases: 1, measuredPhases: 1, targetPaused: null, now: 0, ...extra.input })
}

const own = { at: 0, confirmed: true }

// Ported slider tests (test/device.test.js)

test('poll readings: 3 phases stored, slider follows (max 11040 W, min 4140 W, step 690 W)', () => {
  const meter = new PhaseMeter(1)
  const options = () => targetOptions(16, meter.phases, meter.measured)
  meter.update(STATUS.CHARGING, 6, 4.6598, 0)
  meter.update(STATUS.CHARGING, 6, 4.0255, 10000)
  assert.deepStrictEqual(options(), { min: 0, max: 3680, step: 230, excludeMin: 0, excludeMax: 1380 }, 'stale reading and first fit do not count')
  meter.update(STATUS.CHARGING, 6, 4.0255, 133000)
  assert.strictEqual(meter.last, 3, 'stored')
  assert.deepStrictEqual(options(), { min: 0, max: 11040, step: 690, excludeMin: 0, excludeMax: 4140 })
  meter.update(STATUS.CHARGING, 6, 4.0255, 256000)
  assert.deepStrictEqual(options(), { min: 0, max: 11040, step: 690, excludeMin: 0, excludeMax: 4140 }, 'no change')
})

test('slider step 690 W on 3 phases: max from the stored phases, minimum from the measured ones', () => {
  assert.deepStrictEqual(targetOptions(16, 3, 1), { min: 0, max: 11040, step: 690, excludeMin: 0, excludeMax: 1380 })
})

// Amps and minimum

test('amps for power: rounded down, within 6 A and the charger maximum (and 32 A)', () => {
  assert.strictEqual(ampsForPower(3680, 1, 32), 16)
  assert.strictEqual(ampsForPower(3679, 1, 32), 15, 'never above the target')
  assert.strictEqual(ampsForPower(7360, 3, 16), 10, '3 phases: 7360 W rounds down to 10 A')
  assert.strictEqual(ampsForPower(4140, 3, 16), 6)
  assert.strictEqual(ampsForPower(11040, 3, 16), 16)
  assert.strictEqual(ampsForPower(0, 1, 32), 6)
  assert.strictEqual(ampsForPower(690, 1, 32), 6)
  assert.strictEqual(ampsForPower(7360, 1, 16), 16)
  assert.strictEqual(ampsForPower(20000, 1, null), 32, 'maximum unknown: 32 A')
  assert.strictEqual(ampsForPower(20000, 1, 40), 32)
})

test('minimum power: 6 A on the measured phases', () => {
  assert.strictEqual(minPower(1), 1380)
  assert.strictEqual(minPower(3), 4140)
  assert.strictEqual(minPower(null), 1380)
})

// Reconcile

test('reconcile: only in homey mode (null and device are inactive)', () => {
  for (const mode of [null, MODE.DEVICE]) {
    const result = reconcile({ view: view(STATUS.CHARGING), mode, target: 0, phases: 1, measuredPhases: 1, targetPaused: null, now: 0 })
    assert.deepStrictEqual(result, { amps: null, action: null, targetPaused: null }, `mode ${mode}`)
  }
})

test('reconcile: the amps follow the target while a car is connected, also when changed elsewhere', () => {
  assert.deepStrictEqual(homey(STATUS.CHARGING, 3680), { amps: 16, action: null, targetPaused: null })
  assert.deepStrictEqual(homey(STATUS.CHARGING, 3680, { view: { maxCurrent: 20 } }), { amps: 16, action: null, targetPaused: null }, 'set to 20 A elsewhere')
  assert.strictEqual(homey(STATUS.CHARGING, 3680, { view: { maxCurrent: 16 } }).amps, null, 'unchanged')
  for (const status of [STATUS.PAUSED, STATUS.SCHEDULED, STATUS.CAR_FULL, STATUS.ECO_SMART, STATUS.POWER_SHARING])
    assert.strictEqual(homey(status, 7360).amps, 32, status)
})

test('reconcile: nothing without a car, while locked, offline or updating', () => {
  for (const status of [STATUS.READY, STATUS.LOCKED, STATUS.LOCKED_CAR, STATUS.OFFLINE, STATUS.UPDATING, STATUS.ERROR, STATUS.UNKNOWN])
    assert.deepStrictEqual(homey(status, 7360), { amps: null, action: null, targetPaused: null }, status)
  assert.strictEqual(reconcile({ view: null, mode: MODE.HOMEY, target: 7360, phases: 1, measuredPhases: 1, targetPaused: null, now: 0 }).amps, null, 'no poll yet')
  assert.strictEqual(homey(STATUS.CHARGING, null).amps, null, 'no target')
})

test('reconcile: pause below the minimum while charging or discharging', () => {
  for (const status of [STATUS.CHARGING, STATUS.DISCHARGING])
    assert.deepStrictEqual(homey(status, 1000, { input: { now: 5 } }), { amps: 6, action: 'pause', targetPaused: { at: 5, confirmed: false } }, status)
  assert.strictEqual(homey(STATUS.CHARGING, 1380).action, null, 'at the minimum')
  assert.strictEqual(homey(STATUS.CHARGING, 3680, { input: { measuredPhases: 3 } }).action, 'pause', 'below 4140 W on 3 measured phases')
  for (const status of [STATUS.PAUSED, STATUS.SCHEDULED, STATUS.CAR_FULL, STATUS.ECO_SMART])
    assert.strictEqual(homey(status, 0).action, null, status)
})

test('reconcile: resume only an own, confirmed pause, from paused, at or above the minimum', () => {
  assert.deepStrictEqual(homey(STATUS.PAUSED, 7360, { input: { targetPaused: own } }), { amps: 32, action: 'resume', targetPaused: null })
  assert.strictEqual(homey(STATUS.PAUSED, 1380, { input: { targetPaused: own } }).action, 'resume', 'at the minimum')
  assert.strictEqual(homey(STATUS.PAUSED, 1000, { input: { targetPaused: own } }).action, null, 'below the minimum')
  assert.strictEqual(homey(STATUS.PAUSED, 7360).action, null, 'a pause of someone else is never resumed')
  const unconfirmed = homey(STATUS.CHARGING, 7360, { input: { targetPaused: { at: 0, confirmed: false } } })
  assert.strictEqual(unconfirmed.action, null, 'not seen paused yet')
  for (const status of [STATUS.SCHEDULED, STATUS.CAR_FULL, STATUS.ECO_SMART, STATUS.POWER_BOOST, STATUS.LOCKED_CAR])
    assert.strictEqual(homey(status, 7360, { input: { targetPaused: own } }).action, null, `never from ${status}`)
})

test('reconcile: a paused poll confirms the own pause, then resumes it', () => {
  const result = homey(STATUS.PAUSED, 7360, { input: { targetPaused: { at: 0, confirmed: false } } })
  assert.strictEqual(result.action, 'resume')
})

// Own pause lifecycle

test('own pause: confirmed by a paused poll, cleared by any other status after that', () => {
  const unconfirmed = { at: 0, confirmed: false }
  assert.deepStrictEqual(nextTargetPaused(unconfirmed, view(STATUS.PAUSED), 1000), { at: 0, confirmed: true })
  assert.strictEqual(nextTargetPaused(own, view(STATUS.PAUSED), 1000), own)
  for (const status of [STATUS.CHARGING, STATUS.SCHEDULED, STATUS.ECO_SMART, STATUS.CAR_FULL, STATUS.LOCKED_CAR])
    assert.strictEqual(nextTargetPaused(own, view(status), 1000), null, status)
})

test('own pause: kept through inconclusive statuses (offline, updating, error, unknown)', () => {
  for (const status of [STATUS.OFFLINE, STATUS.UPDATING, STATUS.ERROR, STATUS.UNKNOWN])
    assert.strictEqual(nextTargetPaused(own, view(status), 1000), own, status)
})

test('own pause: no car clears it', () => {
  for (const status of [STATUS.READY, STATUS.LOCKED]) {
    assert.strictEqual(nextTargetPaused(own, view(status), 1000), null, status)
    assert.strictEqual(nextTargetPaused({ at: 0, confirmed: false }, view(status), 1000), null, status)
  }
})

test('own pause: unconfirmed, it is dropped after TARGET_PAUSE_EXPIRE', () => {
  const unconfirmed = { at: 0, confirmed: false }
  assert.strictEqual(nextTargetPaused(unconfirmed, view(STATUS.CHARGING), TIMING.TARGET_PAUSE_EXPIRE - 1), unconfirmed, 'poll not caught up yet')
  assert.strictEqual(nextTargetPaused(unconfirmed, view(STATUS.CHARGING), TIMING.TARGET_PAUSE_EXPIRE), null)
  assert.strictEqual(nextTargetPaused(unconfirmed, view(STATUS.OFFLINE), TIMING.TARGET_PAUSE_EXPIRE), null)
  assert.strictEqual(nextTargetPaused(null, view(STATUS.PAUSED), 0), null)
  assert.strictEqual(nextTargetPaused(unconfirmed, null, TIMING.TARGET_PAUSE_EXPIRE), unconfirmed, 'no poll yet')
})

// Current throttle

test('throttle: equal to the observed current is skipped and drops a queued value', () => {
  assert.deepStrictEqual(planCurrent({ wanted: 10, observed: 10, lastIncreaseAt: null, queued: { amps: 14, at: 60000 }, now: 0 }), { send: null, queue: null })
})

test('throttle: a decrease is sent at once and drops a queued increase', () => {
  assert.deepStrictEqual(planCurrent({ wanted: 6, observed: 10, lastIncreaseAt: 0, queued: { amps: 14, at: WINDOW }, now: 1000 }), { send: 6, queue: null })
})

test('throttle: an increase is sent at once when the last one was a window ago (or never)', () => {
  assert.deepStrictEqual(planCurrent({ wanted: 16, observed: 10, lastIncreaseAt: null, queued: null, now: 0 }), { send: 16, queue: null })
  assert.deepStrictEqual(planCurrent({ wanted: 16, observed: 10, lastIncreaseAt: 0, queued: null, now: WINDOW }), { send: 16, queue: null })
  assert.deepStrictEqual(planCurrent({ wanted: 16, observed: null, lastIncreaseAt: null, queued: null, now: 0 }), { send: 16, queue: null }, 'current unknown')
})

test('throttle: an increase within the window is queued at its end, the newest value replaces it', () => {
  assert.deepStrictEqual(planCurrent({ wanted: 16, observed: 10, lastIncreaseAt: 0, queued: null, now: WINDOW - 1 }), { send: null, queue: { amps: 16, at: WINDOW } })
  assert.deepStrictEqual(planCurrent({ wanted: 12, observed: 10, lastIncreaseAt: 0, queued: { amps: 16, at: WINDOW }, now: 5000 }), { send: null, queue: { amps: 12, at: WINDOW } })
})

test('throttle: 6, 8, 12, 14 A within 15 s gives 6 now, then 14 at the end of the window', () => {
  // Last increase (to 10 A) at t = 0
  let state = { observed: 10, lastIncreaseAt: 0, queued: null }
  const sent = []
  const step = (wanted, now) => {
    const plan = planCurrent({ wanted, ...state, now })
    if (plan.send != null) {
      sent.push([plan.send, now])
      if (plan.send > state.observed)
        state.lastIncreaseAt = now
      state.observed = plan.send
    }
    state = { ...state, queued: plan.queue }
  }
  step(6, 1000)
  step(8, 5000)
  step(12, 10000)
  step(14, 15000)
  assert.deepStrictEqual(sent, [[6, 1000]])
  assert.deepStrictEqual(state.queued, { amps: 14, at: WINDOW })
  step(state.queued.amps, state.queued.at) // the timer re-plans at the window's end
  assert.deepStrictEqual(sent, [[6, 1000], [14, WINDOW]])
  assert.strictEqual(state.queued, null)
})

test('throttle: 6 A already set is skipped, 8 A then goes at once when no increase was recent', () => {
  let state = { observed: 6, lastIncreaseAt: null, queued: null }
  const plans = [6, 8, 12, 14].map((wanted, i) => {
    const plan = planCurrent({ wanted, ...state, now: i * 5000 })
    if (plan.send != null)
      state = { observed: plan.send, lastIncreaseAt: i * 5000, queued: null }
    else
      state = { ...state, queued: plan.queue }
    return plan
  })
  assert.deepStrictEqual(plans.map(plan => plan.send), [null, 8, null, null])
  assert.deepStrictEqual(state.queued, { amps: 14, at: 5000 + WINDOW }, 'newest value at the window end')
})

// Follow check

test('follow check after Start: charging or discharging is followed', () => {
  for (const status of [STATUS.CHARGING, STATUS.DISCHARGING])
    assert.deepStrictEqual(followCheck(COMMAND.START, view(status), false), { done: true, reason: null, seenWaiting: false }, status)
})

test('follow check after Start: every not-waiting status gives its reason at once', () => {
  const waiting = GROUP_MEMBERS[GROUP.WAITING]
  const expected = {
    [STATUS.PAUSED]: REASON.STILL_PAUSED,
    [STATUS.LOCKED]: REASON.LOCKED,
    [STATUS.LOCKED_CAR]: REASON.LOCKED,
    [STATUS.READY]: REASON.NO_CAR,
    [STATUS.ERROR]: REASON.CHARGER_FAULT
  }
  for (const [status, reason] of Object.entries(START_REASON).filter(([status, reason]) => reason !== 'wait' && !waiting.includes(status))) {
    assert.strictEqual(reason, expected[status], status)
    assert.deepStrictEqual(followCheck(COMMAND.START, view(status), false), { done: true, reason, seenWaiting: false }, status)
  }
})

test('follow check after Start: waiting reasons only count at the second waiting poll in a row', () => {
  const expected = {
    [STATUS.SCHEDULED]: REASON.SCHEDULED,
    [STATUS.CAR_FULL]: REASON.CAR_FULL,
    [STATUS.POWER_SHARING]: REASON.WAITING_FOR_POWER,
    [STATUS.POWER_BOOST]: REASON.WAITING_FOR_POWER,
    [STATUS.ECO_SMART]: REASON.WAITING_FOR_SOLAR,
    [STATUS.SESSION_FINISHED]: REASON.SESSION_FINISHED,
    [STATUS.MID_FAILED]: REASON.CHARGER_FAULT,
    [STATUS.MID_MARGIN]: REASON.CHARGER_FAULT
  }
  assert.deepStrictEqual(Object.keys(expected).sort(), [...GROUP_MEMBERS[GROUP.WAITING]].sort())
  for (const [status, reason] of Object.entries(expected)) {
    assert.deepStrictEqual(followCheck(COMMAND.START, view(status), false), { done: false, reason: null, seenWaiting: true }, `first ${status}`)
    assert.deepStrictEqual(followCheck(COMMAND.START, view(status), true), { done: true, reason, seenWaiting: true }, `second ${status}`)
  }
  assert.deepStrictEqual(followCheck(COMMAND.START, view(STATUS.CHARGING), true), { done: true, reason: null, seenWaiting: false }, 'waiting, then charging')
  assert.deepStrictEqual(followCheck(COMMAND.START, view(STATUS.PAUSED), true), { done: true, reason: REASON.STILL_PAUSED, seenWaiting: false }, 'waiting, then paused')
})

test('follow check: offline, updating and unknown check again next poll', () => {
  for (const command of [COMMAND.START, COMMAND.STOP])
    for (const status of [STATUS.OFFLINE, STATUS.UPDATING, STATUS.UNKNOWN]) {
      assert.deepStrictEqual(followCheck(command, view(status), false), { done: false, reason: null, seenWaiting: false }, `${command} ${status}`)
      assert.deepStrictEqual(followCheck(command, view(status), true), { done: false, reason: null, seenWaiting: true }, `${command} ${status} keeps a waiting poll`)
    }
})

test('follow check after Stop: charging or discharging is still_charging, the rest is followed', () => {
  for (const status of [STATUS.CHARGING, STATUS.DISCHARGING])
    assert.deepStrictEqual(followCheck(COMMAND.STOP, view(status), false), { done: true, reason: REASON.STILL_CHARGING, seenWaiting: false }, status)
  for (const status of [STATUS.PAUSED, STATUS.SCHEDULED, STATUS.ECO_SMART, STATUS.CAR_FULL, STATUS.READY, STATUS.LOCKED, STATUS.ERROR])
    assert.deepStrictEqual(followCheck(COMMAND.STOP, view(status), false), { done: true, reason: null, seenWaiting: false }, status)
})

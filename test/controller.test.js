'use strict'

// Run with: node --test test/
const test = require('node:test')
const assert = require('node:assert')
const { ChargerController } = require('../lib/charger/controller')
const { STATUS, CAR_CONNECTED, CAP, MODE, TIMING, ERR, REASON, COMMAND, FLOW } = require('../lib/contract')

const {
  CHARGING, PAUSED, READY, LOCKED, LOCKED_CAR, SCHEDULED, CAR_FULL, POWER_SHARING, POWER_BOOST, ECO_SMART, OFFLINE
} = STATUS
const MINUTE = 60 * 1000
const OWN = Object.freeze({ at: 0, confirmed: true }) // own pause from target power, seen in a poll

// Fake clock and timers for the queued current, the controller reads them at call time
test.beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }))

const flush = () => new Promise(resolve => setImmediate(resolve))

async function tick(t, ms) {
  t.mock.timers.tick(ms)
  await flush()
}

function view(status, extra = {}) {
  return { status, carConnected: CAR_CONNECTED[status], charging: status === CHARGING, locked: false, powerW: 0, maxCurrent: 13, maxAvailable: 32, ...extra }
}

function apiError(code, extra = {}) {
  return Object.assign(new Error(`wallbox ${code}`), { code, status: null, retryAt: null, ...extra })
}

/**
 * Controller with a mocked Wallbox api, records api calls in order.
 * The first poll shows `status` at `maxCurrent` (13 A, so a wanted 6, 10, 16
 * or 32 A is a write). phases: stored phase count, measured for this car
 * unless measured = false. stored: store values before the start.
 * send(batch) runs a command and stores the values, like Homey after the listener.
 * poll(status, extra) polls at the current the charger has as far as we know.
 */
async function setup({ status = PAUSED, maxCurrent = 13, maxAvailable = 32, mode = null, target = null, phases, measured = true, stored = {} } = {}) {
  const values = { [CAP.TARGET_MODE]: null, [CAP.TARGET_POWER]: null }
  const store = { ...stored }
  if (phases)
    store.phases = phases
  const calls = []
  const saved = []
  const polls = []
  const events = []
  const logs = []
  const api = {
    setCurrent: async (id, amps) => { calls.push(['setCurrent', amps]); return amps },
    pause: async () => { calls.push(['pause']) },
    resume: async () => { calls.push(['resume']) },
    setLocked: async (id, locked) => { calls.push(['setLocked', locked]) },
    setEcoSmart: async (id, mode) => { calls.push(['setEcoSmart', mode]) }
  }
  const controller = new ChargerController({
    api,
    chargerId: 'charger',
    now: () => Date.now(),
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) },
    store: { get: key => store[key], set: async (key, value) => { saved.push([key, value]); store[key] = value } },
    log: message => logs.push(message),
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    caps: { get: id => (id in values ? values[id] : null) },
    requestPoll: ms => polls.push(ms),
    onEvent: (trigger, tokens) => events.push([trigger, tokens])
  })
  if (phases && measured)
    controller.meter.session = phases
  await controller.onPoll(view(status, { maxCurrent, maxAvailable }))
  values[CAP.TARGET_MODE] = mode
  values[CAP.TARGET_POWER] = target
  calls.length = 0
  saved.length = 0
  polls.length = 0

  const send = async batch => {
    await controller.command(batch)
    Object.assign(values, batch)
  }
  const poll = (status, extra = {}) => controller.onPoll(view(status, { maxCurrent: controller.observed, maxAvailable, ...extra }))
  return { controller, api, calls, values, saved, polls, events, logs, store, send, poll }
}

// Ported from test/device.test.js (35 tests: 33 here, the 2 slider tests in decide.test.js)

test('start while paused, no target power: resume, current untouched', async () => {
  const { send, calls } = await setup()
  await send({ evcharger_charging: true })
  assert.deepStrictEqual(calls, [['resume']])
})

test('start while paused, stored target power 7360 W (homey): current, then resume', async () => {
  const { send, calls } = await setup({ target: 7360, mode: MODE.HOMEY })
  await send({ evcharger_charging: true })
  assert.deepStrictEqual(calls, [['setCurrent', 32], ['resume']])
})

test('start with target power in the same batch: current only in homey mode (null is inactive now)', async () => {
  const inactive = await setup()
  await inactive.send({ evcharger_charging: true, target_power: 3680 })
  assert.deepStrictEqual(inactive.calls, [['resume']], 'mode null: current stays as set')

  const homey = await setup({ mode: MODE.HOMEY })
  await homey.send({ evcharger_charging: true, target_power: 3680 })
  assert.deepStrictEqual(homey.calls, [['setCurrent', 16], ['resume']])
})

test('start: stored target power only counts in homey mode', async () => {
  for (const mode of [null, MODE.DEVICE]) {
    const { send, calls } = await setup({ target: 7360, mode })
    await send({ evcharger_charging: true })
    assert.deepStrictEqual(calls, [['resume']], `mode ${mode}`)
  }
})

test('start: current kept within the charger maximum; below the 6 A minimum homey mode refuses the Start (was 6 A, resume)', async () => {
  const max = await setup({ maxAvailable: 16, mode: MODE.HOMEY })
  await max.send({ evcharger_charging: true, target_power: 7360 })
  assert.deepStrictEqual(max.calls, [['setCurrent', 16], ['resume']])

  const low = await setup({ mode: MODE.HOMEY })
  await assert.rejects(low.send({ evcharger_charging: true, target_power: 690 }), { message: 'errors.homey_controls' })
  assert.deepStrictEqual(low.calls, [])
})

test('start while charging: still resumes', async () => {
  const { send, calls } = await setup({ status: CHARGING })
  await send({ evcharger_charging: true })
  assert.deepStrictEqual(calls, [['resume']])
})

test('start without car: no-car error when Wallbox refuses and the latest poll shows no car', async () => {
  const { send, api } = await setup({ status: READY })
  api.resume = async () => { throw apiError(ERR.REFUSED, { status: 403 }) }
  await assert.rejects(send({ evcharger_charging: true }), { message: 'errors.no_car', code: ERR.REFUSED })
})

test('start refused while locked with a car: locked error; otherwise the general refusal', async () => {
  const locked = await setup({ status: STATUS.LOCKED_CAR })
  locked.api.resume = async () => { throw apiError(ERR.REFUSED, { status: 403 }) }
  await assert.rejects(locked.send({ evcharger_charging: true }), { message: 'errors.locked' })
  const paused = await setup({ status: PAUSED })
  paused.api.resume = async () => { throw apiError(ERR.REFUSED, { status: 403 }) }
  await assert.rejects(paused.send({ evcharger_charging: true }), { message: 'errors.refused' })
})

test('targetOptions: stored 3 phases, car not measured yet: max for 3 phases, minimum for 1', async () => {
  const { controller } = await setup({ phases: 3, measured: false, maxAvailable: 16 })
  assert.deepStrictEqual(controller.targetOptions(), { min: 0, max: 11040, step: 690, excludeMin: 0, excludeMax: 1380 })
})

test('stop: pause', async () => {
  const { send, calls } = await setup({ status: CHARGING })
  await send({ evcharger_charging: false })
  assert.deepStrictEqual(calls, [['pause']])
})

test('stop while not charging: Wallbox refuses (wrong current status), the latest poll agrees, so done', async () => {
  for (const status of [PAUSED, READY]) {
    const { send, api, polls } = await setup({ status })
    api.pause = async () => { throw apiError(ERR.REFUSED, { status: 403 }) }
    await send({ evcharger_charging: false })
    assert.deepStrictEqual(polls, [TIMING.FOLLOW_DELAY], `${status}: follow-up poll still asked`)
  }
})

test('stop refused while the latest poll shows charging: the card fails', async () => {
  const { send, api } = await setup({ status: CHARGING })
  api.pause = async () => { throw apiError(ERR.REFUSED, { status: 403 }) }
  await assert.rejects(send({ evcharger_charging: false }), { message: 'errors.refused' })
})

test('start refused while the latest poll shows charging: done, no error', async () => {
  const { send, api, polls } = await setup({ status: CHARGING })
  api.resume = async () => { throw apiError(ERR.REFUSED, { status: 403 }) }
  await send({ evcharger_charging: true })
  assert.deepStrictEqual(polls, [TIMING.FOLLOW_DELAY])
})

test('dispose: a queued increase is dropped, no writes after it', async t => {
  const { controller, send, calls, values } = await setup({ status: CHARGING, maxCurrent: 6 })
  values[CAP.TARGET_MODE] = MODE.DEVICE
  await controller.setCurrent(10)
  await controller.setCurrent(16)
  calls.length = 0
  controller.dispose()
  await tick(t, TIMING.INCREASE_WINDOW)
  await send({ evcharger_charging: false })
  assert.deepStrictEqual(calls, [])
})

test('target power while charging (homey): current only', async () => {
  const { send, calls } = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await send({ target_power: 3680 })
  assert.deepStrictEqual(calls, [['setCurrent', 16]])
})

test('target power 0 while charging: pause, current untouched (no write below the minimum)', async () => {
  const { send, calls } = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await send({ target_power: 0 })
  assert.deepStrictEqual(calls, [['pause']])
})

test('target power below 6 A while charging (set at 6 A): pause', async () => {
  const { send, calls } = await setup({ status: CHARGING, maxCurrent: 6, mode: MODE.HOMEY })
  await send({ target_power: 1000 })
  assert.deepStrictEqual(calls, [['pause']])
})

test('device mode: no crash, charger left as is', async () => {
  const { send, calls } = await setup({ status: CHARGING })
  await send({ target_power_mode: MODE.DEVICE })
  assert.deepStrictEqual(calls, [])
})

test('device mode: target power ignored', async () => {
  const stored = await setup({ status: CHARGING, mode: MODE.DEVICE })
  await stored.send({ target_power: 3680 })
  assert.deepStrictEqual(stored.calls, [], 'stored device mode')

  const batch = await setup({ status: CHARGING })
  await batch.send({ target_power: 3680, target_power_mode: MODE.DEVICE })
  assert.deepStrictEqual(batch.calls, [], 'device mode in the same batch')

  const start = await setup({ mode: MODE.DEVICE })
  await start.send({ evcharger_charging: true, target_power: 3680 })
  assert.deepStrictEqual(start.calls, [['resume']], 'start only resumes')
})

test('device mode with start in the same batch: still resumes', async () => {
  const { send, calls } = await setup({ target: 7360, mode: MODE.HOMEY })
  await send({ target_power_mode: MODE.DEVICE, evcharger_charging: true })
  assert.deepStrictEqual(calls, [['resume']])
})

test('target power while paused by someone else: current only, no resume (was current, then resume)', async () => {
  const { send, calls } = await setup()
  await send({ target_power: 7360, target_power_mode: MODE.HOMEY })
  assert.deepStrictEqual(calls, [['setCurrent', 32]])
})

test('target power while waiting (car full, queue, Eco-Smart, scheduled): current follows, no resume (was nothing)', async () => {
  for (const status of [CAR_FULL, POWER_SHARING, POWER_BOOST, ECO_SMART, SCHEDULED]) {
    const { send, calls } = await setup({ status })
    await send({ target_power: 7360, target_power_mode: MODE.HOMEY })
    await send({ target_power: 7360 })
    assert.deepStrictEqual(calls, [['setCurrent', 32]], status)
  }
})

test('auto-resume of an own pause: resume refused (car gone) is logged, not thrown', async () => {
  const { send, calls, api } = await setup({ mode: MODE.HOMEY, stored: { targetPaused: OWN } })
  api.resume = async () => { calls.push(['resume']); throw apiError(ERR.REFUSED, { status: 403 }) }
  await send({ target_power: 7360 })
  assert.deepStrictEqual(calls, [['setCurrent', 32], ['resume']])
})

test('after a resume from target power, target 0 pauses at the next poll (the latest poll decides)', async t => {
  const { send, poll, calls } = await setup({ mode: MODE.HOMEY, stored: { targetPaused: OWN } })
  await send({ target_power: 7360 })
  await send({ target_power: 0 })
  assert.deepStrictEqual(calls, [['setCurrent', 32], ['resume']], 'last poll still paused')
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(CHARGING)
  assert.deepStrictEqual(calls, [['setCurrent', 32], ['resume'], ['pause']])
})

test('after a pause from target power, a higher target resumes once a poll shows paused', async t => {
  const { send, poll, calls } = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await send({ target_power: 1000 })
  await send({ target_power: 7360 })
  assert.deepStrictEqual(calls, [['pause'], ['setCurrent', 32]], 'last poll still charging')
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(PAUSED)
  assert.deepStrictEqual(calls, [['pause'], ['setCurrent', 32], ['resume']])
})

test('start right after a pause from target power: HOMEY_CONTROLS while the target is below the minimum (was resume)', async () => {
  const { send, calls } = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await send({ target_power: 0 })
  await assert.rejects(send({ evcharger_charging: true }), { message: 'errors.homey_controls' })
  await send({ evcharger_charging: true, target_power: 3680 })
  assert.deepStrictEqual(calls, [['pause'], ['setCurrent', 16], ['resume']])
})

test('the 3-minute hold is gone: the latest poll decides', async t => {
  const { send, poll, calls } = await setup({ mode: MODE.HOMEY, stored: { targetPaused: OWN } })
  await send({ target_power: 7360 })
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(CAR_FULL) // car never started (full)
  await send({ target_power: 7360 })
  await tick(t, 3 * MINUTE)
  await poll(PAUSED)
  await send({ target_power: 7360 })
  assert.deepStrictEqual(calls, [['setCurrent', 32], ['resume']], 'no second resume: not our pause any more')
})

test('changes run one at a time (target 0 then waits for a poll showing charging)', async () => {
  const { controller, calls, api, values } = await setup({ mode: MODE.HOMEY, stored: { targetPaused: OWN } })
  let release
  api.setCurrent = async (id, amps) => {
    calls.push(['setCurrent', amps])
    if (amps === 32)
      await new Promise(resolve => { release = resolve })
    return amps
  }
  const first = controller.command({ target_power: 7360 })
  values[CAP.TARGET_POWER] = 7360
  const second = controller.command({ target_power: 0 })
  await flush()
  assert.deepStrictEqual(calls, [['setCurrent', 32]], 'second waits for the first')
  release()
  await Promise.all([first, second])
  assert.deepStrictEqual(calls, [['setCurrent', 32], ['resume']])
})

test('switch to homey mode applies the stored target power', async () => {
  const { send, calls } = await setup({ status: CHARGING, target: 3680, mode: MODE.DEVICE })
  await send({ target_power_mode: MODE.HOMEY })
  assert.deepStrictEqual(calls, [['setCurrent', 16]])
})

test('device mode: target pause kept unless confirmed own pause', async t => {
  const unconfirmed = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await unconfirmed.send({ target_power: 0 })
  await unconfirmed.send({ target_power_mode: MODE.DEVICE })
  assert.deepStrictEqual(unconfirmed.calls, [['pause']], 'not seen paused yet: kept')

  const confirmed = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await confirmed.send({ target_power: 0 })
  await tick(t, TIMING.FOLLOW_DELAY)
  await confirmed.poll(PAUSED)
  await confirmed.send({ target_power_mode: MODE.DEVICE })
  assert.deepStrictEqual(confirmed.calls, [['pause'], ['resume']], 'confirmed own pause: resumed')

  const user = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await user.send({ evcharger_charging: false })
  await tick(t, TIMING.FOLLOW_DELAY)
  await user.poll(PAUSED)
  await user.send({ target_power_mode: MODE.DEVICE })
  assert.deepStrictEqual(user.calls, [['pause']], 'stopped by the user')
})

test('pause from target power is stored ({ at, confirmed }), so device mode undoes it after a restart', async t => {
  const first = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await first.send({ target_power: 0 })
  assert.deepStrictEqual(first.saved, [['targetPaused', { at: 0, confirmed: false }]])
  await tick(t, TIMING.FOLLOW_DELAY)
  await first.poll(PAUSED)
  assert.deepStrictEqual(first.saved[1], ['targetPaused', { at: 0, confirmed: true }])

  // After a restart the controller reads the stored value
  const restarted = await setup({ target: 0, mode: MODE.HOMEY, stored: { targetPaused: first.store.targetPaused } })
  await restarted.send({ target_power_mode: MODE.DEVICE })
  assert.deepStrictEqual(restarted.calls, [['resume']])
  assert.deepStrictEqual(restarted.saved, [['targetPaused', null]])
})

test('target power without car or locked: kept for later', async () => {
  for (const status of [READY, LOCKED, LOCKED_CAR]) {
    const { send, calls } = await setup({ status })
    await send({ target_power: 7360, target_power_mode: MODE.HOMEY })
    assert.deepStrictEqual(calls, [], status)
  }
})

test('target power below 6 A while paused: nothing, no current write', async () => {
  const { send, calls } = await setup({ mode: MODE.HOMEY })
  await send({ target_power: 0 })
  await send({ target_power: 1000 })
  assert.deepStrictEqual(calls, [])
})

test('3 phases: 7360 W rounds down to 10 A (4140 W = 6 A, 11040 W = 16 A)', async () => {
  for (const [watts, amps] of [[4140, 6], [7360, 10], [11040, 16]]) {
    const { send, calls } = await setup({ status: CHARGING, maxAvailable: 16, phases: 3, mode: MODE.HOMEY })
    await send({ target_power: watts })
    assert.deepStrictEqual(calls, [['setCurrent', amps]], `${watts} W`)
  }
})

test('3 phases: below 4140 W while charging pauses, current untouched', async () => {
  const { send, calls } = await setup({ status: CHARGING, maxAvailable: 16, phases: 3, mode: MODE.HOMEY })
  await send({ target_power: 3680 })
  assert.deepStrictEqual(calls, [['pause']])
})

test('3 phases: start with stored target power 7360 W (homey) rounds down to 10 A', async () => {
  const { send, calls } = await setup({ target: 7360, mode: MODE.HOMEY, maxAvailable: 16, phases: 3 })
  await send({ evcharger_charging: true })
  assert.deepStrictEqual(calls, [['setCurrent', 10], ['resume']])
})

test('poll readings: a phase change re-applies the target power (homey), rounded down to 10 A', async t => {
  const { poll, calls } = await setup({ status: CHARGING, maxCurrent: 16, maxAvailable: 16, target: 7360, mode: MODE.HOMEY })
  await poll(CHARGING, { maxCurrent: 16, powerW: 11040 })
  assert.deepStrictEqual(calls, [], '1 phase: 16 A is the maximum, unchanged')
  await tick(t, 123000)
  await poll(CHARGING, { maxCurrent: 16, powerW: 11040 })
  assert.deepStrictEqual(calls, [['setCurrent', 10]])
})

test('3 phases stored, car not measured yet: 1-phase minimum, so an own pause resumes at 3000 W', async () => {
  const { send, calls } = await setup({ mode: MODE.HOMEY, maxAvailable: 16, phases: 3, measured: false, stored: { targetPaused: OWN } })
  await send({ target_power: 3000 })
  assert.deepStrictEqual(calls, [['setCurrent', 6], ['resume']])
})

test('no reading yet: 1 phase, as before', async () => {
  const { send, calls } = await setup({ status: CHARGING, maxAvailable: 16, mode: MODE.HOMEY })
  await send({ target_power: 3680 })
  assert.deepStrictEqual(calls, [['setCurrent', 16]])
})

// Target power mode

test('mode null: target power is inactive (the old app treated it as homey)', async () => {
  const { send, poll, calls } = await setup({ status: CHARGING })
  await send({ target_power: 0 })
  await poll(CHARGING, { maxCurrent: 20 })
  assert.deepStrictEqual(calls, [])
})

test('a current changed elsewhere is reverted in homey mode and left alone in Automatic', async () => {
  const homey = await setup({ status: CHARGING, mode: MODE.HOMEY, target: 3680 })
  await homey.poll(CHARGING)
  assert.deepStrictEqual(homey.calls, [['setCurrent', 16]], 'follows the target')
  await homey.poll(CHARGING, { maxCurrent: 20 })
  assert.deepStrictEqual(homey.calls, [['setCurrent', 16], ['setCurrent', 16]], 'set to 20 A in the Wallbox app: back to 16 A')

  for (const mode of [MODE.DEVICE, null]) {
    const automatic = await setup({ status: CHARGING, mode, target: 3680 })
    await automatic.poll(CHARGING, { maxCurrent: 20 })
    assert.deepStrictEqual(automatic.calls, [], `mode ${mode}`)
  }
})

// Current throttle

test('card: sent, unchanged and queued results', async t => {
  const { controller, calls } = await setup({ status: CHARGING })
  assert.deepStrictEqual(await controller.setCurrent(16), { result: 'sent', amps: 16, seconds: 0 })
  assert.deepStrictEqual(await controller.setCurrent(16), { result: 'unchanged', amps: 16, seconds: 0 })
  await tick(t, 20000)
  assert.deepStrictEqual(await controller.setCurrent(20), { result: 'queued', amps: 20, seconds: 40 })
  assert.deepStrictEqual(await controller.setCurrent(10), { result: 'sent', amps: 10, seconds: 0 }, 'a decrease goes at once')
  await tick(t, MINUTE)
  assert.deepStrictEqual(calls, [['setCurrent', 16], ['setCurrent', 10]], 'the decrease dropped the queued increase')
})

test('card: the PUT response is the current until the next poll', async () => {
  const { controller, api, poll } = await setup({ status: CHARGING })
  api.setCurrent = async () => 15 // charger kept a lower value
  assert.deepStrictEqual(await controller.setCurrent(16), { result: 'sent', amps: 15, seconds: 0 })
  assert.strictEqual(controller.observed, 15)
  await poll(CHARGING, { maxCurrent: 14 })
  assert.strictEqual(controller.observed, 14)
})

test('card: 6, 8, 12, 14 A within 15 s gives 6 now, then 14 at the end of the window', async t => {
  const { controller, calls } = await setup({ status: CHARGING })
  await controller.setCurrent(16) // increase at t = 0
  calls.length = 0
  await tick(t, 1000)
  const results = []
  for (const amps of [6, 8, 12, 14]) {
    results.push(await controller.setCurrent(amps))
    await tick(t, 4000)
  }
  assert.deepStrictEqual(results.map(result => result.result), ['sent', 'queued', 'queued', 'queued'])
  assert.deepStrictEqual(results[3], { result: 'queued', amps: 14, seconds: 47 })
  assert.deepStrictEqual(calls, [['setCurrent', 6]])
  await tick(t, 60000 - 17000 - 1)
  assert.deepStrictEqual(calls, [['setCurrent', 6]], 'not before the window ends')
  await tick(t, 1)
  assert.deepStrictEqual(calls, [['setCurrent', 6], ['setCurrent', 14]], 'newest value at the window end')
  await tick(t, 5 * MINUTE)
  assert.strictEqual(calls.length, 2)
})

test('homey: a queued increase is re-planned at the window end against the latest poll', async t => {
  const queued = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await queued.send({ target_power: 3680 }) // 16 A, increase at t = 0
  await queued.send({ target_power: 2300 }) // 10 A
  await queued.send({ target_power: 2760 }) // 12 A, within the window
  await tick(t, 30000)
  await queued.poll(CHARGING, { maxCurrent: 10 })
  assert.deepStrictEqual(queued.calls, [['setCurrent', 16], ['setCurrent', 10]])
  await tick(t, 30000)
  assert.deepStrictEqual(queued.calls, [['setCurrent', 16], ['setCurrent', 10], ['setCurrent', 12]], 'sent at the window end')

  const already = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await already.send({ target_power: 3680 })
  await already.send({ target_power: 2300 })
  await already.send({ target_power: 2760 })
  await tick(t, 30000)
  await already.poll(CHARGING, { maxCurrent: 12 }) // set to 12 A elsewhere
  await tick(t, 30000)
  assert.deepStrictEqual(already.calls, [['setCurrent', 16], ['setCurrent', 10]], 'the poll shows it already: dropped')

  const back = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await back.send({ target_power: 3680 })
  await back.send({ target_power: 2300 })
  await back.send({ target_power: 3220 }) // 14 A, queued
  await back.send({ target_power: 2300 }) // back to the 10 A it has
  await tick(t, MINUTE)
  assert.deepStrictEqual(back.calls, [['setCurrent', 16], ['setCurrent', 10]], 'target back to the current: dropped')
})

test('a queued increase is dropped: of Homey when switching to Automatic, of the card when changed elsewhere', async t => {
  const homey = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await homey.send({ target_power: 3680 })
  await homey.send({ target_power: 2300 })
  await homey.send({ target_power: 2760 }) // queued
  await homey.send({ target_power_mode: MODE.DEVICE })
  await tick(t, MINUTE)
  assert.deepStrictEqual(homey.calls, [['setCurrent', 16], ['setCurrent', 10]])

  const card = await setup({ status: CHARGING })
  await card.controller.setCurrent(16)
  await card.controller.setCurrent(10)
  await card.controller.setCurrent(12) // queued
  await card.poll(CHARGING, { maxCurrent: 8 }) // set to 8 A in the Wallbox app
  await tick(t, MINUTE)
  assert.deepStrictEqual(card.calls, [['setCurrent', 16], ['setCurrent', 10]])
})

// Card

test('card: HOMEY_CONTROLS in homey mode, and the current range', async () => {
  const homey = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await assert.rejects(homey.controller.setCurrent(10), { message: 'errors.homey_controls' })

  const range = await setup({ status: CHARGING, maxAvailable: 16 })
  await assert.rejects(range.controller.setCurrent(5), { message: 'errors.current_range {"min":6,"max":16}' })
  await assert.rejects(range.controller.setCurrent(17), { message: 'errors.current_range {"min":6,"max":16}' })
  assert.deepStrictEqual(await range.controller.setCurrent(16), { result: 'sent', amps: 16, seconds: 0 })
  assert.deepStrictEqual(homey.calls.concat(range.calls), [['setCurrent', 16]])
})

test('start: HOMEY_CONTROLS below the minimum, also with no target and on 3 measured phases', async () => {
  for (const [target, phases] of [[1000, undefined], [null, undefined], [3680, 3]]) {
    const { send, calls } = await setup({ mode: MODE.HOMEY, target, phases })
    await assert.rejects(send({ evcharger_charging: true }), { message: 'errors.homey_controls' }, `${target} W`)
    assert.deepStrictEqual(calls, [])
  }
})

// Own pause from target power

test('own pause: an old stored true is read as unconfirmed, a paused poll confirms it', async () => {
  const { controller, send, calls } = await setup({ status: PAUSED, mode: MODE.HOMEY, target: 0, stored: { targetPaused: true } })
  assert.deepStrictEqual(controller.targetPaused, { at: 0, confirmed: true }, 'confirmed by the first poll')
  await send({ target_power: 3680 })
  assert.deepStrictEqual(calls, [['setCurrent', 16], ['resume']])
})

test('own pause: dropped when never seen paused within TARGET_PAUSE_EXPIRE, cleared without a car', async t => {
  const expired = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await expired.send({ target_power: 0 })
  await expired.send({ target_power_mode: MODE.DEVICE })
  await tick(t, TIMING.TARGET_PAUSE_EXPIRE)
  await expired.poll(SCHEDULED)
  assert.strictEqual(expired.controller.targetPaused, null)
  assert.deepStrictEqual(expired.saved.map(([, value]) => value), [{ at: 0, confirmed: false }, null])

  const unplugged = await setup({ mode: MODE.HOMEY, stored: { targetPaused: OWN } })
  await unplugged.poll(READY)
  await unplugged.poll(PAUSED)
  await unplugged.send({ target_power: 7360 })
  assert.deepStrictEqual(unplugged.calls, [['setCurrent', 32]], 'a new car after unplugging: current follows, not our pause')
})

test('a user pause is never resumed: Stop in homey mode, or a pause in the Wallbox app', async t => {
  const stop = await setup({ status: CHARGING, mode: MODE.HOMEY, target: 3680, maxCurrent: 16 })
  await stop.send({ evcharger_charging: false })
  await tick(t, TIMING.FOLLOW_DELAY)
  await stop.poll(PAUSED)
  await stop.send({ target_power: 7360 })
  assert.deepStrictEqual(stop.calls, [['pause'], ['setCurrent', 32]])

  const app = await setup({ status: CHARGING, mode: MODE.HOMEY, target: 3680, maxCurrent: 16 })
  await app.poll(PAUSED)
  await app.send({ target_power: 2300 })
  await app.poll(PAUSED)
  assert.deepStrictEqual(app.calls, [['setCurrent', 10]])
})

test('stop, then a low target before a poll: no second pause, it stays the user\'s pause', async t => {
  const { send, poll, calls, controller } = await setup({ status: CHARGING, mode: MODE.HOMEY, target: 3680, maxCurrent: 16 })
  await send({ evcharger_charging: false })
  await send({ target_power: 0 })
  assert.deepStrictEqual(calls, [['pause']])
  assert.strictEqual(controller.targetPaused, null)
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(PAUSED)
  await send({ target_power: 7360 })
  assert.deepStrictEqual(calls, [['pause'], ['setCurrent', 32]], 'never resumed')
})

test('resume only from paused: an own pause that moved to waiting is not resumed', async t => {
  const { send, poll, calls } = await setup({ status: CHARGING, mode: MODE.HOMEY })
  await send({ target_power: 0 })
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(PAUSED) // confirmed
  await tick(t, MINUTE)
  await poll(ECO_SMART) // someone else's choice now
  await send({ target_power: 7360 })
  await tick(t, MINUTE)
  await poll(PAUSED)
  assert.deepStrictEqual(calls, [['pause'], ['setCurrent', 32]])
})

test('own pause: a poll keeps following the target, also in a later session', async t => {
  const { poll, calls, values } = await setup({ status: CHARGING, mode: MODE.HOMEY, target: 3680, maxCurrent: 16 })
  values[CAP.TARGET_POWER] = 1000
  await poll(CHARGING)
  assert.deepStrictEqual(calls, [['pause']], 'pause from a poll')
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(PAUSED)
  values[CAP.TARGET_POWER] = 3680
  await poll(PAUSED)
  assert.deepStrictEqual(calls, [['pause'], ['resume']], 'resume from a poll, the current stayed 16 A')
})

// Follow check

test('follow check: Start followed, no trigger; the poll asked for comes FOLLOW_DELAY later', async t => {
  const { send, poll, events, polls } = await setup()
  await send({ evcharger_charging: true })
  assert.deepStrictEqual(polls, [TIMING.FOLLOW_DELAY])
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(CHARGING)
  await tick(t, MINUTE)
  await poll(PAUSED)
  assert.deepStrictEqual(events, [], 'checked once')
})

test('follow check: Start not followed, still paused', async t => {
  const { send, poll, events } = await setup()
  await send({ evcharger_charging: true })
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(PAUSED)
  assert.deepStrictEqual(events, [[FLOW.TRIGGER.NOT_FOLLOWED, { command: COMMAND.START, reason: REASON.STILL_PAUSED }]])
})

test('follow check: a poll right after the command does not count', async t => {
  const { send, poll, events } = await setup()
  await send({ evcharger_charging: true })
  await tick(t, 5000)
  await poll(PAUSED) // charger did not react yet, or the poll was under way already
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(CHARGING)
  assert.deepStrictEqual(events, [])
})

test('follow check: waiting reasons count at the second waiting poll in a row', async t => {
  const twice = await setup()
  await twice.send({ evcharger_charging: true })
  await tick(t, TIMING.FOLLOW_DELAY)
  await twice.poll(ECO_SMART)
  assert.deepStrictEqual(twice.events, [], 'first waiting poll')
  await tick(t, 2 * MINUTE)
  await twice.poll(ECO_SMART)
  assert.deepStrictEqual(twice.events, [[FLOW.TRIGGER.NOT_FOLLOWED, { command: COMMAND.START, reason: REASON.WAITING_FOR_SOLAR }]])

  const passing = await setup()
  await passing.send({ evcharger_charging: true })
  await tick(t, TIMING.FOLLOW_DELAY)
  await passing.poll(POWER_SHARING)
  await tick(t, 2 * MINUTE)
  await passing.poll(CHARGING)
  assert.deepStrictEqual(passing.events, [], 'waiting, then charging')
})

test('follow check: offline checks again next poll, and the check gives up after 3 polls (changed: was 10 min)', async t => {
  const again = await setup()
  await again.send({ evcharger_charging: true })
  await tick(t, TIMING.FOLLOW_DELAY)
  await again.poll(OFFLINE)
  await tick(t, 2 * MINUTE)
  await again.poll(READY)
  assert.deepStrictEqual(again.events, [[FLOW.TRIGGER.NOT_FOLLOWED, { command: COMMAND.START, reason: REASON.NO_CAR }]])

  const expired = await setup()
  await expired.send({ evcharger_charging: true })
  await tick(t, TIMING.FOLLOW_DELAY)
  for (let i = 0; i < 3; i++) {
    await expired.poll(OFFLINE)
    await tick(t, MINUTE)
  }
  await expired.poll(PAUSED)
  assert.deepStrictEqual(expired.events, [], 'gave up after 3 inconclusive polls')
})

test('follow check: a waiting reason still fires with a 600 s poll interval', async t => {
  const { send, poll, events } = await setup()
  await send({ evcharger_charging: true })
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(STATUS.CAR_FULL)
  await tick(t, 10 * MINUTE)
  await poll(STATUS.CAR_FULL)
  assert.deepStrictEqual(events, [[FLOW.TRIGGER.NOT_FOLLOWED, { command: COMMAND.START, reason: REASON.CAR_FULL }]])
})

test('minimum: a 3-phase reading is kept while paused, so an own pause is not resumed below 4140 W (no loop)', async t => {
  const { poll, calls, values } = await setup({ status: CHARGING, mode: MODE.HOMEY, target: 11040, maxCurrent: 16, phases: 3, measured: false })
  await poll(CHARGING, { maxCurrent: 16, powerW: 11040 })
  values[CAP.TARGET_POWER] = 3000
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(CHARGING, { maxCurrent: 16, powerW: 11040 })
  assert.deepStrictEqual(calls, [['pause']])
  for (let i = 0; i < 3; i++) {
    await tick(t, TIMING.FOLLOW_DELAY)
    await poll(PAUSED, { maxCurrent: 16, powerW: 0 })
  }
  assert.deepStrictEqual(calls, [['pause']], 'still paused: 3000 W stays below the 3-phase minimum')
})

test('minimum: a reading right after a current change does not count (power is still the old one)', async () => {
  const { controller, poll } = await setup({ status: CHARGING, maxCurrent: 16 })
  await poll(CHARGING, { maxCurrent: 8, powerW: 3680 })
  assert.strictEqual(controller.minimumPhases(), 1, '3680 W at a new 8 A looks like 2 phases, but the current just changed')
})

test('start refused while locked without a car: locked message, not no car', async () => {
  const { send, api } = await setup({ status: STATUS.LOCKED })
  api.resume = async () => { throw apiError(ERR.REFUSED, { status: 403 }) }
  await assert.rejects(send({ evcharger_charging: true }), { message: 'errors.locked' })
})

test('set current card: a sent value asks for a poll soon', async () => {
  const { controller, values, polls } = await setup({ status: CHARGING, maxCurrent: 16 })
  values[CAP.TARGET_MODE] = MODE.DEVICE
  await controller.setCurrent(10)
  assert.deepStrictEqual(polls, [TIMING.FOLLOW_DELAY])
})

test('follow check: Stop still charging, or followed', async t => {
  const still = await setup({ status: CHARGING })
  await still.send({ evcharger_charging: false })
  await tick(t, TIMING.FOLLOW_DELAY)
  await still.poll(CHARGING)
  assert.deepStrictEqual(still.events, [[FLOW.TRIGGER.NOT_FOLLOWED, { command: COMMAND.STOP, reason: REASON.STILL_CHARGING }]])

  const followed = await setup({ status: CHARGING })
  await followed.send({ evcharger_charging: false })
  await tick(t, TIMING.FOLLOW_DELAY)
  await followed.poll(SCHEDULED)
  assert.deepStrictEqual(followed.events, [])
})

test('follow check: a new command replaces the armed one', async t => {
  const { send, poll, events } = await setup({ status: CHARGING })
  await send({ evcharger_charging: false })
  await tick(t, 10000)
  await send({ evcharger_charging: true })
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(CHARGING)
  assert.deepStrictEqual(events, [])
})

// Errors and retries

test('errors from the api: translated messages', async () => {
  const cases = [
    [apiError(ERR.REFUSED, { status: 403 }), 'errors.refused'],
    [apiError(ERR.AUTH_REJECTED, { status: 401 }), 'errors.login'],
    [apiError(ERR.TIMEOUT), 'errors.timeout'],
    [apiError(ERR.NETWORK), 'errors.network'],
    [apiError(ERR.HTTP, { status: 500 }), 'errors.failed {"status":500}'],
    [apiError(ERR.BAD_RESPONSE, { status: 200 }), 'errors.failed {"status":200}'],
    [new TypeError('boom'), 'errors.failed {"status":"-"}'],
    [apiError(ERR.THROTTLED, { retryAt: 90000 }), 'errors.busy {"minutes":2}']
  ]
  for (const [error, message] of cases) {
    const { controller, api } = await setup({ status: CHARGING })
    api.pause = async () => { throw error }
    api.setLocked = async () => { throw error }
    await assert.rejects(controller.command({ evcharger_charging: false }), { message }, message)
    await assert.rejects(controller.setLocked(true), { message }, message)
  }
})

test('throttled Stop: busy, retried at the first poll after retryAt', async t => {
  const { send, poll, api, calls, polls } = await setup({ status: CHARGING })
  let fail = true
  api.pause = async () => {
    calls.push(['pause'])
    if (fail) {
      fail = false
      throw apiError(ERR.THROTTLED, { retryAt: Date.now() + 2 * MINUTE })
    }
  }
  await assert.rejects(send({ evcharger_charging: false }), { message: 'errors.busy {"minutes":2}' })
  assert.deepStrictEqual(polls, [2 * MINUTE], 'poll right after retryAt')
  await tick(t, MINUTE)
  await poll(CHARGING)
  assert.deepStrictEqual(calls, [['pause']], 'not before retryAt')
  await tick(t, MINUTE)
  await poll(CHARGING)
  assert.deepStrictEqual(calls, [['pause'], ['pause']])
  await tick(t, 2 * MINUTE)
  await poll(CHARGING)
  assert.deepStrictEqual(calls, [['pause'], ['pause']], 'once')
})

test('throttled Start: not retried', async t => {
  const { send, poll, api, calls } = await setup()
  api.resume = async () => { calls.push(['resume']); throw apiError(ERR.THROTTLED, { retryAt: Date.now() + 2 * MINUTE }) }
  await assert.rejects(send({ evcharger_charging: true }), { message: 'errors.busy {"minutes":2}' })
  api.resume = async () => { calls.push(['resume']) }
  await tick(t, 3 * MINUTE)
  await poll(PAUSED)
  assert.deepStrictEqual(calls, [['resume']])
})

test('throttled Stop: retry dropped after the session ended, or after RETRY_EXPIRE', async t => {
  const unplugged = await setup({ status: CHARGING })
  unplugged.api.pause = async () => { unplugged.calls.push(['pause']); throw apiError(ERR.THROTTLED, { retryAt: Date.now() + 2 * MINUTE }) }
  await assert.rejects(unplugged.send({ evcharger_charging: false }))
  unplugged.api.pause = async () => { unplugged.calls.push(['pause']) }
  await tick(t, MINUTE)
  await unplugged.poll(READY)
  await tick(t, 2 * MINUTE)
  await unplugged.poll(CHARGING)
  assert.deepStrictEqual(unplugged.calls, [['pause']], 'new session')

  const late = await setup({ status: CHARGING })
  late.api.pause = async () => { late.calls.push(['pause']); throw apiError(ERR.THROTTLED, { retryAt: Date.now() + 40 * MINUTE }) }
  await assert.rejects(late.send({ evcharger_charging: false }))
  late.api.pause = async () => { late.calls.push(['pause']) }
  await tick(t, 41 * MINUTE)
  await late.poll(CHARGING)
  assert.deepStrictEqual(late.calls, [['pause']], 'expired')
})

test('throttled Stop: kept through an offline poll, dropped by a Start', async t => {
  const offline = await setup({ status: CHARGING })
  offline.api.pause = async () => { offline.calls.push(['pause']); throw apiError(ERR.THROTTLED, { retryAt: Date.now() + 2 * MINUTE }) }
  await assert.rejects(offline.send({ evcharger_charging: false }))
  offline.api.pause = async () => { offline.calls.push(['pause']) }
  await tick(t, 3 * MINUTE)
  await offline.poll(OFFLINE)
  await tick(t, MINUTE)
  await offline.poll(CHARGING)
  assert.deepStrictEqual(offline.calls, [['pause'], ['pause']])

  const started = await setup({ status: CHARGING })
  started.api.pause = async () => { started.calls.push(['pause']); throw apiError(ERR.THROTTLED, { retryAt: Date.now() + 2 * MINUTE }) }
  await assert.rejects(started.send({ evcharger_charging: false }))
  await tick(t, 3 * MINUTE)
  await started.send({ evcharger_charging: true })
  await tick(t, TIMING.FOLLOW_DELAY)
  await started.poll(CHARGING)
  assert.deepStrictEqual(started.calls, [['pause'], ['resume']])
})

test('throttled card current: a lower one is retried, a higher one is not', async t => {
  const lower = await setup({ status: CHARGING, maxCurrent: 16 })
  lower.api.setCurrent = async () => { throw apiError(ERR.THROTTLED, { retryAt: Date.now() + 2 * MINUTE }) }
  await assert.rejects(lower.controller.setCurrent(10), { message: 'errors.busy {"minutes":2}' })
  lower.api.setCurrent = async (id, amps) => { lower.calls.push(['setCurrent', amps]); return amps }
  await tick(t, 2 * MINUTE)
  await lower.poll(CHARGING, { maxCurrent: 16 })
  assert.deepStrictEqual(lower.calls, [['setCurrent', 10]])

  const higher = await setup({ status: CHARGING, maxCurrent: 10 })
  higher.api.setCurrent = async () => { throw apiError(ERR.THROTTLED, { retryAt: Date.now() + 2 * MINUTE }) }
  await assert.rejects(higher.controller.setCurrent(16))
  higher.api.setCurrent = async (id, amps) => { higher.calls.push(['setCurrent', amps]); return amps }
  await tick(t, 2 * MINUTE)
  await higher.poll(CHARGING, { maxCurrent: 10 })
  assert.deepStrictEqual(higher.calls, [])
})

test('throttled target pause: target kept (no error), paused by the first poll after retryAt', async t => {
  const { send, poll, api, calls, polls, values } = await setup({ status: CHARGING, maxCurrent: 6, mode: MODE.HOMEY, target: 3680 })
  api.pause = async () => { calls.push(['pause']); throw apiError(ERR.THROTTLED, { retryAt: Date.now() + 2 * MINUTE }) }
  await send({ target_power: 0 })
  assert.strictEqual(values[CAP.TARGET_POWER], 0)
  assert.deepStrictEqual(polls, [2 * MINUTE])
  api.pause = async () => { calls.push(['pause']) }
  await tick(t, MINUTE)
  await poll(CHARGING)
  assert.deepStrictEqual(calls, [['pause']], 'poll work holds its writes until retryAt')
  await tick(t, MINUTE)
  await poll(CHARGING)
  assert.deepStrictEqual(calls, [['pause'], ['pause']])
})

test('target power: errors are only logged, never thrown (changed: Homey would drop the target; the next poll retries)', async () => {
  const timeout = await setup({ status: CHARGING, mode: MODE.HOMEY })
  timeout.api.setCurrent = async () => { throw apiError(ERR.TIMEOUT) }
  await timeout.send({ target_power: 3680 })

  const refused = await setup({ status: CHARGING, mode: MODE.HOMEY })
  refused.api.setCurrent = async () => { throw apiError(ERR.REFUSED, { status: 403 }) }
  await refused.send({ target_power: 3680 })
})

test('commands run one at a time, a failed one does not block the next', async () => {
  const { controller, api, calls } = await setup({ status: CHARGING })
  api.pause = async () => { calls.push(['pause']); throw apiError(ERR.REFUSED) }
  const stop = controller.command({ evcharger_charging: false })
  const start = controller.command({ evcharger_charging: true })
  await assert.rejects(stop, { message: 'errors.refused' })
  await start
  assert.deepStrictEqual(calls, [['pause'], ['resume']])
})

// Poll work

test('onPoll never throws: api, store and trigger errors are logged', async t => {
  const { controller, api, poll, logs, send } = await setup({ status: CHARGING, mode: MODE.HOMEY, target: 3680 })
  api.setCurrent = async () => { throw new Error('boom') }
  controller.store.set = async () => { throw new Error('disk full') }
  controller.onEvent = () => { throw new Error('trigger') }
  await poll(CHARGING)
  await send({ evcharger_charging: false })
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(CHARGING, { powerW: 3680, maxCurrent: 16 })
  await tick(t, MINUTE)
  await poll(CHARGING, { powerW: 3680, maxCurrent: 16 })
  await controller.onPoll(null)
  assert.ok(logs.some(message => message.includes('boom')))
  assert.ok(logs.some(message => message.includes('trigger')))
})

test('phases: stored when they change, once; phases and measuredPhases', async t => {
  const { controller, poll, saved } = await setup({ status: CHARGING, maxCurrent: 6, maxAvailable: 16 })
  assert.strictEqual(controller.phases, 1)
  await poll(CHARGING, { maxCurrent: 6, powerW: 4025.5 })
  await tick(t, 123000)
  await poll(CHARGING, { maxCurrent: 6, powerW: 4025.5 })
  await tick(t, 123000)
  await poll(CHARGING, { maxCurrent: 6, powerW: 4025.5 })
  assert.deepStrictEqual(saved, [['phases', 3]])
  assert.strictEqual(controller.phases, 3)
  assert.strictEqual(controller.measuredPhases, 3)
  assert.deepStrictEqual(controller.targetOptions(), { min: 0, max: 11040, step: 690, excludeMin: 0, excludeMax: 4140 })
  await poll(READY)
  assert.strictEqual(controller.phases, 3, 'last session')
  assert.strictEqual(controller.measuredPhases, 1, 'next car not measured yet')
})

test('lock and Eco-Smart: not sent when the latest poll already shows that value', async () => {
  const { controller, poll, calls, polls } = await setup()
  await poll(PAUSED, { locked: true, ecoSmart: 'eco' })
  await controller.setLocked(true)
  await controller.setEcoSmart('eco')
  assert.deepStrictEqual(calls, [])
  assert.deepStrictEqual(polls, [])
  await controller.setLocked(false)
  await controller.setEcoSmart('off')
  assert.deepStrictEqual(calls, [['setLocked', false], ['setEcoSmart', 'off']])
})

test('paused by Homey: only an own pause while the latest poll shows paused', async t => {
  const { controller, poll, values } = await setup({ status: CHARGING, mode: MODE.HOMEY, target: 3680, maxCurrent: 16 })
  assert.strictEqual(controller.pausedByHomey(), false)
  values[CAP.TARGET_POWER] = 1000
  await poll(CHARGING)
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(PAUSED)
  assert.strictEqual(controller.pausedByHomey(), true, 'own pause, confirmed')
  const user = await setup({ status: PAUSED })
  assert.strictEqual(user.controller.pausedByHomey(), false, 'a user pause')
})

test('lock and Eco-Smart: sent, then a poll soon', async () => {
  const { controller, calls, polls } = await setup()
  await controller.setLocked(true)
  await controller.setEcoSmart('full_solar')
  assert.deepStrictEqual(calls, [['setLocked', true], ['setEcoSmart', 'full_solar']])
  assert.deepStrictEqual(polls, [TIMING.FOLLOW_DELAY, TIMING.FOLLOW_DELAY])
})

test('minimum: a conclusive reading of the latest poll counts before the meter has measured', async () => {
  const { poll, calls, values } = await setup({ status: CHARGING, mode: MODE.HOMEY, target: 11040, maxCurrent: 16, phases: 3, measured: false })
  values[CAP.TARGET_POWER] = 2000
  await poll(CHARGING, { maxCurrent: 16, powerW: 11040 })
  assert.deepStrictEqual(calls, [['pause']], '2000 W is below 4140 W on 3 phases: pause, not 6 A on 3 phases')
})

test('minimum: an inconclusive reading falls back to 1 phase, so any car can start', async () => {
  const { controller, poll } = await setup({ status: CHARGING, phases: 3, measured: false })
  await poll(CHARGING, { maxCurrent: 16, powerW: 2000 })
  assert.strictEqual(controller.minimumPhases(), 1)
})

test('observe: a poll sent before our last PUT does not undo its response', async () => {
  const { controller, values } = await setup({ status: CHARGING, maxCurrent: 16 })
  values[CAP.TARGET_MODE] = MODE.DEVICE
  const before = Date.now() - 1
  assert.strictEqual((await controller.setCurrent(10)).result, 'sent')
  await controller.onPoll(view(CHARGING, { maxCurrent: 16, maxAvailable: 32, at: before }))
  assert.strictEqual(controller.observed, 10, 'older poll ignored')
  assert.strictEqual((await controller.setCurrent(10)).result, 'unchanged')
  await controller.onPoll(view(CHARGING, { maxCurrent: 16, maxAvailable: 32, at: Date.now() + 1 }))
  assert.strictEqual(controller.observed, 16, 'a newer poll is the truth')
})

test('flowing current: more power than fits on fewer phases counts as at least that many (no 40 A on a new device)', async () => {
  const { controller } = await setup({ status: CHARGING, maxCurrent: 16 })
  assert.strictEqual(controller.phasesFor(CHARGING, 16, 9.209), 3, '9.2 kW at 16 A cannot be 1 or 2 phases')
  assert.strictEqual(controller.phasesFor(CHARGING, 16, 3.5), 1)
  assert.strictEqual(controller.phasesFor(CHARGING, 16, 5), 2)
})

test('lock: a poll older than our last lock write does not skip the next one', async () => {
  const { controller, calls } = await setup()
  await controller.onPoll(view(PAUSED, { locked: true, maxCurrent: 13, maxAvailable: 32, at: Date.now() }))
  await controller.setLocked(false)
  await controller.setLocked(true)
  assert.deepStrictEqual(calls, [['setLocked', false], ['setLocked', true]], 'the poll showing locked was older than the unlock')
  await controller.onPoll(view(PAUSED, { locked: true, maxCurrent: 13, maxAvailable: 32, at: Date.now() + 1 }))
  await controller.setLocked(true)
  assert.strictEqual(calls.length, 2, 'a newer poll shows locked: skipped')
})

test('start right after our own resume (switch to Automatic) does not send a second resume', async t => {
  const { send, poll, calls, values } = await setup({ status: CHARGING, mode: MODE.HOMEY, target: 3680, maxCurrent: 16 })
  values[CAP.TARGET_POWER] = 1000
  await poll(CHARGING, { at: Date.now() })
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(PAUSED, { at: Date.now() })
  calls.length = 0
  await send({ target_power_mode: MODE.DEVICE })
  assert.deepStrictEqual(calls, [['resume']], 'own pause undone')
  await send({ evcharger_charging: true })
  assert.deepStrictEqual(calls, [['resume']], 'not sent twice before a poll')
  await tick(t, TIMING.FOLLOW_DELAY)
  await poll(PAUSED, { at: Date.now() })
  await send({ evcharger_charging: true })
  assert.deepStrictEqual(calls, [['resume'], ['resume']], 'after a newer poll a Start sends again')
})

test('onPoll: a poll older than the one we have (answered late) changes nothing', async () => {
  const { controller, calls, values } = await setup({ status: CHARGING, maxCurrent: 16 })
  values[CAP.TARGET_MODE] = MODE.HOMEY
  values[CAP.TARGET_POWER] = 1000
  await controller.onPoll(view(PAUSED, { maxCurrent: 16, maxAvailable: 32, at: Date.now() + 2000 }))
  await controller.onPoll(view(CHARGING, { maxCurrent: 10, maxAvailable: 32, at: Date.now() + 1000 }))
  assert.strictEqual(controller.view.status, PAUSED, 'the older charging poll was ignored')
  assert.strictEqual(controller.observed, 16)
  assert.deepStrictEqual(calls, [], 'no pause from the old charging view')
})

test('poll work waits behind a running command, and polls in the meantime queue only one run (newest view)', async () => {
  const { controller, api, calls, values } = await setup({ status: CHARGING, maxCurrent: 16 })
  values[CAP.TARGET_MODE] = MODE.DEVICE
  let release
  api.pause = () => new Promise(resolve => { release = () => { calls.push(['pause']); resolve() } })
  const reconcile = controller.reconcile.bind(controller)
  const seen = []
  controller.reconcile = (...args) => { seen.push(controller.view.at); return reconcile(...args) }
  const stop = controller.command({ evcharger_charging: false })
  await flush()
  let done = 0
  const polls = []
  const base = Date.now()
  for (let i = 1; i <= 3; i++)
    polls.push(controller.onPoll(view(CHARGING, { maxCurrent: 16, maxAvailable: 32, at: base + i })).then(() => done++))
  await flush()
  assert.strictEqual(done, 0, 'poll work waits for the command')
  assert.deepStrictEqual(seen, [])
  release()
  await stop
  await Promise.all(polls)
  assert.strictEqual(done, 3)
  assert.deepStrictEqual(seen, [base + 3], 'one run, on the newest poll')
})

test('follow check counts from when the poll was sent: a poll sent before the Stop and answered later is not a failed Stop', async t => {
  const { send, events, controller } = await setup({ status: CHARGING })
  const before = Date.now() - 1000
  await send({ evcharger_charging: false })
  await tick(t, TIMING.FOLLOW_DELAY)
  await controller.onPoll(view(CHARGING, { maxCurrent: 13, maxAvailable: 32, at: before }))
  assert.deepStrictEqual(events, [], 'old poll, no not_followed')
  await controller.onPoll(view(PAUSED, { maxCurrent: 13, maxAvailable: 32, at: Date.now() }))
  assert.deepStrictEqual(events, [])
})

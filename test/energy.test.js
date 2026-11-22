'use strict'

const test = require('node:test')
const assert = require('node:assert')
const energy = require('../lib/energy')
const { STATUS, STATUS_IDS, SESSION_STATE, TIMING } = require('../lib/contract')

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
const e = (kwh, green = 0) => ({ energy: kwh, green })
const DAY = 24 * 60 * 60
const MIN = 60 * 1000
const NOW = Date.UTC(2026, 10, 16, 12) // Default clock of setup()
const at = (y, m, d) => Date.UTC(y, m - 1, d) / 1000
const flush = () => new Promise(resolve => setImmediate(resolve))

// Status for a Wallbox status_id, like the snapshot parser: null is offline,
// an id not in the table null
function statusOf(id) {
  if (id == null) return STATUS.OFFLINE
  const entry = Object.entries(STATUS_IDS).find(([, ids]) => ids.includes(id))
  return entry ? entry[0] : null
}

// Snapshot fields the meter uses
const snapshot = (id, added, green = 0) => ({ statusId: id, status: statusOf(id), addedKwh: added, addedGreenKwh: green })

// Feed polls through the meter rules like EnergyMeter does.
// Each poll: [status_id, added_energy, finished kWh in the Wallbox list]
function replay(polls) {
  let meter = null
  for (const [id, session, finished] of polls) {
    const state = energy.sessionState(statusOf(id))
    if (state === null) continue
    meter = energy.update(meter || energy.initial(e(session), state === 'open', null), e(finished), e(session), state === 'open')
  }
  return meter
}

// Fake timers on a fake clock. advance(ms) moves the clock, firing due timers
// in time order and letting the code they wake run.
function fakeTimers(clock) {
  const pending = new Set()
  const due = end => [...pending].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0]
  return {
    pending,
    setTimeout: (fn, ms) => {
      const timer = { fn, at: clock.now + ms }
      pending.add(timer)
      return timer
    },
    clearTimeout: timer => pending.delete(timer),
    async advance(ms) {
      const end = clock.now + ms
      await flush()
      for (let timer = due(end); timer; timer = due(end)) {
        pending.delete(timer)
        clock.now = Math.max(clock.now, timer.at)
        timer.fn()
        await flush()
      }
      clock.now = end
    }
  }
}

// EnergyMeter with a fake clock, store and Wallbox list, and its own queue.
// No first delay and no spacing unless a test sets them.
// sessions: [end (s), kWh, green kWh], only finished ones
function setup(sessions, options = {}) {
  const store = options.store || {}
  const clock = options.clock || { now: options.now || NOW }
  const calls = []
  const times = options.times || [] // clock at each request
  const api = { fail: false, maxRows: Infinity }
  const fetchSessions = options.fetchSessions || (async (start, end) => {
    calls.push([start, end])
    times.push(clock.now)
    if (api.fail) throw new Error('403')
    const data = sessions.filter(([t]) => t >= start && t <= end)
      .map(([t, kwh, green]) => ({ attributes: { charger: 7, end: t, energy: kwh, green_energy: green || 0, energy_unit: 'kWh' } }))
    return energy.sumSessions({ meta: { count: data.length }, data: data.slice(0, api.maxRows) }, 7)
  })
  const meter = new energy.EnergyMeter({
    fetchSessions,
    store: { get: key => (key in store ? JSON.parse(JSON.stringify(store[key])) : null), set: async (key, value) => { store[key] = value } },
    now: () => clock.now,
    timers: options.timers,
    queue: options.queue || new energy.Queue(),
    firstDelay: 'firstDelay' in options ? options.firstDelay : 0,
    spacing: 'spacing' in options ? options.spacing : 0
  })
  const poll = async (id, added, green = 0) => meter.update(snapshot(id, added, green))
  const tick = minutes => { clock.now += minutes * MIN }
  return { meter, poll, tick, calls, times, api, store, clock }
}

test('sessionState: SESSION_STATE of the contract', () => {
  for (const id of [194, 196, 182, 177, 181, 183, 185, 189, 187, 188, 164]) assert.strictEqual(energy.sessionState(statusOf(id)), 'open', String(id))
  for (const id of [161, 209, 210]) assert.strictEqual(energy.sessionState(statusOf(id)), 'none', String(id))
  for (const id of [166, 14, null, 999]) assert.strictEqual(energy.sessionState(statusOf(id)), null, String(id))
  for (const status of Object.values(STATUS)) assert.strictEqual(energy.sessionState(status), SESSION_STATE[status], status)
  assert.strictEqual(energy.sessionState(undefined), null)
  assert.strictEqual(energy.sessionState('constructor'), null)
})

test('sumSessions: kWh, Wh, green, latest', () => {
  const sum = energy.sumSessions({
    meta: { count: 3 },
    data: [
      { attributes: { charger: 7, end: 100, energy: 39.296, green_energy: 10, energy_unit: 'kWh' } },
      { attributes: { charger: 7, end: 300, energy: 738, energy_unit: 'Wh' } },
      { attributes: { charger: 7, end: 200, energy: '1.5', green_energy: '0.5', energy_unit: 'kWh' } }
    ]
  }, 7)
  close(sum.energy, 41.534)
  close(sum.green, 10.5)
  assert.strictEqual(sum.count, 3)
  assert.strictEqual(sum.latest, 0.738) // exact, Wh divided by 1000
  assert.deepStrictEqual(energy.sumSessions({ meta: { count: 0 }, data: [] }, 7), { energy: 0, green: 0, count: 0, latest: null })
})

test('sumSessions: sessions of other chargers are dropped', () => {
  const sum = energy.sumSessions({ data: [{ attributes: { charger: 7, energy: 5 } }, { attributes: { charger: '7', energy: 1 } }, { attributes: { charger: 8, energy: 99 } }, { attributes: { energy: 2 } }] }, 7)
  close(sum.energy, 8)
  assert.strictEqual(sum.count, 3)
  // A year in which only another charger was used counts nothing
  assert.strictEqual(energy.sumSessions({ data: [{ attributes: { charger: 8, energy: 99 } }] }, 7).count, 0)
})

test('sumSessions rejects missing and cut off lists', () => {
  assert.throws(() => energy.sumSessions({}, 7), /missing/)
  assert.throws(() => energy.sumSessions({ error: true }, 7), /missing/)
  assert.throws(() => energy.sumSessions(null, 7), /missing/)
  assert.throws(() => energy.sumSessions({ meta: { count: 3 }, data: [{}, {}] }, 7), error => error.code === 'incomplete')
})

test('showGreen: Eco-Smart possible (also switched off) or green history', () => {
  assert.strictEqual(energy.showGreen(0, 'off'), true)
  assert.strictEqual(energy.showGreen(0, 'eco'), true)
  assert.strictEqual(energy.showGreen(0, 'full_solar'), true)
  assert.strictEqual(energy.showGreen(0, null), false)
  assert.strictEqual(energy.showGreen(0, undefined), false)
  assert.strictEqual(energy.showGreen(3.2, null), true)
})

test('first poll counts the open session, not a finished one', () => {
  close(energy.update(energy.initial(e(2), true, null), e(100), e(2), true).total, 102)
  close(energy.update(energy.initial(e(2), false, null), e(100), e(2), false).total, 100)
  // Waiting for a new session, added_energy still shows the last one (already in the list)
  close(energy.update(energy.initial(e(2), true, 2), e(100), e(2), true).total, 100)
})

test('no double count after unplug, at 210 or while waiting for a new session', () => {
  let meter = energy.initial(e(0), true, null)
  meter = energy.update(meter, e(100), e(5), true) // charging
  meter = energy.update(meter, e(105), e(5), false) // unplugged, session in list
  meter = energy.update(meter, e(105), e(5), false) // plugged in, locked (210)
  meter = energy.update(meter, e(105), e(5), true) // scheduled, old value still shown
  close(meter.total, 105)
})

test('new session counts from its start', () => {
  let meter = energy.initial(e(5), false, null)
  meter = energy.update(meter, e(100), e(5), false)
  meter = energy.update(meter, e(100), e(0), true)
  meter = energy.update(meter, e(100), e(2), true)
  close(meter.total, 102)
})

test('list not updated yet: holds, then catches up without double count', () => {
  let meter = energy.initial(e(0), true, null)
  meter = energy.update(meter, e(100), e(5), true)
  meter = energy.update(meter, e(100), e(5), false) // unplugged, list still without it
  close(meter.total, 105)
  meter = energy.update(meter, e(100), e(1), true) // next session, list still behind
  close(meter.total, 105) // holds, never goes down
  meter = energy.update(meter, e(105), e(1.5), true) // list refreshed
  close(meter.total, 106.5)
})

test('Homey off while one session ends and the next starts: nothing lost', () => {
  let meter = energy.initial(e(0), true, null)
  meter = energy.update(meter, e(100), e(3), true) // last poll before Homey goes off
  meter = energy.update(meter, e(108), e(2), true) // session ended at 8 kWh, next one at 2
  close(meter.total, 110)
})

test('lower list (sessions removed in the Wallbox cloud): holds', () => {
  let meter = energy.initial(e(0), false, null)
  meter = energy.update(meter, e(100), e(0), false)
  meter = energy.update(meter, e(90), e(0), false)
  close(meter.total, 100)
})

test('green energy follows the same rules', () => {
  let meter = energy.initial(e(1, 1), true, null)
  meter = energy.update(meter, e(100, 40), e(6, 4), true)
  meter = energy.update(meter, e(106, 44), e(6, 4), false) // unplugged, in list
  close(meter.total, 106)
  close(meter.green, 44)
})

test('replay of a real session (Commander 2, 15 s polls)', () => {
  // Paused, resumed, paused, resumed, stopped by car, unplugged,
  // plugged in on locked charger, unlocked by RFID, charging.
  // Wallbox listed the first session (0.738) after unplug.
  const meter = replay([
    [182, 0.062, 100], [181, 0.062, 100], [194, 0.132, 100], [194, 0.219, 100], [182, 0.296, 100],
    [194, 0.306, 100], [194, 0.464, 100], [194, 0.643, 100], [181, 0.738, 100], [209, 0.738, 100],
    [209, 0.738, 100.738], [210, 0.738, 100.738], [194, 0, 100.738], [194, 0.053, 100.738], [194, 0.237, 100.738]
  ])
  close(meter.total, 100.738 + 0.237)
})

test('refreshDue: first run, app start, gap, daily, session end and start only', () => {
  const now = 1e12
  const poll = now - 123000
  const history = { refreshed: now - 1000 }
  const open = { total: 1, green: 0, stale: null, open: true, last: 1 }
  const ended = { total: 1, green: 0, stale: 5, open: false, last: 5 }
  assert.strictEqual(energy.refreshDue(null, null, e(0), true, now, poll), true) // first run
  assert.strictEqual(energy.refreshDue(null, history, e(0), true, now, poll), false) // just loaded
  assert.strictEqual(energy.refreshDue(open, history, e(1), true, now, null), true) // app start
  assert.strictEqual(energy.refreshDue(open, history, e(1), true, now, now - 11 * MIN), true) // gap
  assert.strictEqual(energy.refreshDue(open, { refreshed: now - DAY * 1000 - 1 }, e(1), true, now, poll), true) // daily
  assert.strictEqual(energy.refreshDue(open, history, e(1), false, now, poll), true) // session ended
  assert.strictEqual(energy.refreshDue(ended, history, e(0), true, now, poll), true) // new session
  assert.strictEqual(energy.refreshDue(open, history, e(0.5), true, now, poll), true) // energy dropped
  assert.strictEqual(energy.refreshDue(open, history, e(2), true, now, poll), false) // charging
  assert.strictEqual(energy.refreshDue(ended, history, e(5), false, now, poll), false) // unplugged
  assert.strictEqual(energy.refreshDue(ended, history, e(5), true, now, poll), false) // waiting, old value
})

test('fetchAllowed: 15 minutes, doubling after repeated failures, up to a day', () => {
  const now = 1e12
  assert.strictEqual(energy.fetchAllowed(null, now), true)
  assert.strictEqual(energy.fetchAllowed(now - 14 * MIN, now), false)
  assert.strictEqual(energy.fetchAllowed(now - 15 * MIN, now), true)
  assert.strictEqual(energy.fetchAllowed(now - 15 * MIN, now, 1), true)
  assert.strictEqual(energy.fetchAllowed(now - 29 * MIN, now, 2), false)
  assert.strictEqual(energy.fetchAllowed(now - 30 * MIN, now, 2), true)
  assert.strictEqual(energy.fetchAllowed(now - 23 * 60 * MIN, now, 20), false)
  assert.strictEqual(energy.fetchAllowed(now - 24 * 60 * MIN, now, 20), true)
})

test('ranges split per year without gaps or overlap', () => {
  const from = at(2024, 6, 15)
  const to = at(2026, 3, 1)
  const ranges = energy.ranges(from, to)
  assert.strictEqual(ranges.length, 3)
  assert.strictEqual(ranges[0][0], from)
  assert.strictEqual(ranges[2][1], to - 1)
  for (let i = 1; i < ranges.length; i++) assert.strictEqual(ranges[i][0], ranges[i - 1][1] + 1)
  assert.deepStrictEqual(energy.ranges(to, to), [])
})

test('plan: full history once, then the last weeks only, again in full if the clock went back', () => {
  const now = at(2026, 11, 16)
  const first = energy.plan(null, now)
  assert.strictEqual(first.add.length, 12) // 2015 up to now - 30 days
  assert.strictEqual(first.cutoff, now - 30 * DAY)

  const history = { base: e(500, 20), cutoff: first.cutoff, recent: e(30), refreshed: 0 }
  assert.deepStrictEqual(energy.plan(history, now + 20 * DAY).add, [])

  const moved = energy.plan(history, now + 31 * DAY)
  assert.strictEqual(moved.cutoff, now + DAY)
  assert.deepStrictEqual(moved.base, e(500, 20))
  assert.strictEqual(moved.add[0][0], first.cutoff)
  assert.strictEqual(moved.add[moved.add.length - 1][1], moved.cutoff - 1)

  const back = energy.plan(history, first.cutoff - DAY)
  assert.deepStrictEqual(back.base, e(0))
  assert.strictEqual(back.add[0][0], at(2015, 1, 1))
})

test('EnergyMeter: first run in background, years before the charger in one request', async () => {
  const { meter, poll, calls } = setup([[at(2024, 7, 1), 30, 10], [at(2025, 3, 1), 12], [at(2026, 9, 1), 50]])
  assert.strictEqual(await poll(194, 2), null) // nothing yet, load started
  await meter.refreshing
  // 2026, 2025, 2024 have sessions, 2023 and 2022 empty, then 2015-2021 at once, then the recent window
  assert.strictEqual(calls.length, 7)
  assert.deepStrictEqual(calls[5], [at(2015, 1, 1), at(2022, 1, 1) - 1])
  const values = await poll(194, 2.5)
  close(values.total, 92 + 2.5)
  close(values.green, 10)
})

test('EnergyMeter: sessions after a gap of several years are still counted', async () => {
  const { meter, poll } = setup([[at(2018, 5, 1), 40], [at(2019, 5, 1), 20], [at(2025, 3, 1), 12]])
  await poll(161, 0)
  await meter.refreshing
  close((await poll(161, 0)).total, 72)
})

test('EnergyMeter: too many sessions for one request falls back to per year', async () => {
  const sessions = [[at(2025, 3, 1), 12]]
  for (let year = 2015; year <= 2020; year++) sessions.push([at(year, 6, 1), 1], [at(year, 7, 1), 1])
  const { meter, poll, api } = setup(sessions)
  api.maxRows = 2 // the 2015-2022 request returns 12 of 12... cut to 2
  await poll(161, 0)
  await meter.refreshing
  close((await poll(161, 0)).total, 12 + 12)
})

test('EnergyMeter: no fetches while charging, one at session end and start', async () => {
  const sessions = [[at(2025, 3, 1), 12]]
  const { meter, poll, tick, calls, clock } = setup(sessions)
  await poll(194, 0)
  await meter.refreshing
  const first = calls.length
  for (let i = 0; i < 30; i++) {
    tick(2)
    await poll(194, i * 0.3)
  }
  assert.strictEqual(calls.length, first, 'none while charging')
  sessions.push([clock.now / 1000 - 60, 8.7])
  tick(2)
  await poll(209, 8.7) // unplugged
  await meter.refreshing
  assert.strictEqual(calls.length, first + 1)
  tick(120)
  await poll(210, 8.7) // plugged in, locked
  await poll(194, 0) // new session
  await meter.refreshing
  assert.strictEqual(calls.length, first + 2)
  tick(2)
  close((await poll(194, 1)).total, 12 + 8.7 + 1)
})

test('EnergyMeter: first load still running is not a new trigger', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = []
  const { meter, poll, tick } = setup([], {
    fetchSessions: async (start, end) => {
      calls.push(start)
      await gate
      return { energy: 0, green: 0, count: 0, latest: null }
    }
  })
  await poll(161, 0) // load starts and waits
  tick(2)
  await poll(161, 0) // still loading
  release()
  await meter.refreshing
  const loaded = calls.length
  for (let i = 0; i < 15; i++) { // 30 minutes of polls, past the 15 minute cap
    tick(2)
    await poll(161, 0)
    await meter.refreshing
  }
  assert.strictEqual(calls.length, loaded, 'no second load')
})

test('EnergyMeter: trigger during a running fetch is not lost', async () => {
  const sessions = [[at(2025, 3, 1), 12]]
  const { meter, poll, tick, calls, clock } = setup(sessions)
  await poll(194, 0)
  await meter.refreshing
  tick(24 * 60 + 1)
  await poll(194, 3) // daily fetch starts
  const running = meter.refreshing
  sessions.push([clock.now / 1000 - 1, 3])
  await poll(209, 3) // session ends while that fetch runs
  await running
  const before = calls.length
  tick(16)
  await poll(209, 3) // pending trigger fetched now
  await meter.refreshing
  assert.strictEqual(calls.length, before + 1)
  close((await poll(209, 3)).total, 15)
})

test('EnergyMeter: overlapping polls never lower the total', async () => {
  const { meter, poll } = setup([[at(2025, 3, 1), 12]])
  await poll(194, 0)
  await meter.refreshing
  // A newer reading (1.1) and an older one (1.0) arrive together, the older one last
  const [newer, older] = await Promise.all([poll(194, 1.1), poll(194, 1.0)])
  close(newer.total, 13.1)
  close(older.total, 13.1)
  close((await poll(194, 1.2)).total, 13.2)
})

test('EnergyMeter: failing fetches back off up to a day', async () => {
  const { meter, poll, tick, calls, api } = setup([])
  api.fail = true
  await poll(161, 0)
  await meter.refreshing
  let attempts = calls.length
  const times = []
  for (let minute = 0; minute < 6 * 60; minute += 2) {
    tick(2)
    await poll(161, 0)
    await meter.refreshing
    if (calls.length > attempts) times.push(minute + 2)
    attempts = calls.length
  }
  // Waits of 15, 30, 60 and 120 minutes (polls every 2 minutes)
  assert.deepStrictEqual(times, [16, 46, 106, 226])
})

test('EnergyMeter: restart after Homey was off loses nothing', async () => {
  const sessions = [[at(2025, 3, 1), 12]]
  const first = setup(sessions)
  await first.poll(194, 0)
  await first.meter.refreshing
  await first.poll(194, 3)
  // Homey off: session ended at 8 kWh, next one charged 2 kWh so far
  sessions.push([first.clock.now / 1000 + 600, 8])
  const second = setup(sessions, { store: first.store, now: first.clock.now + 60 * MIN })
  close((await second.poll(194, 2)).total, 12 + 3) // holds until the list is fetched
  await second.meter.refreshing
  close((await second.poll(194, 2.1)).total, 12 + 8 + 2.1)
})

test('EnergyMeter: first run while waiting with an old session older than the window', async () => {
  // Last session ended six weeks ago at 9 kWh, car plugged in and scheduled
  const { meter, poll } = setup([[at(2026, 10, 1), 9], [at(2025, 3, 1), 12]])
  await poll(181, 9)
  await meter.refreshing
  close((await poll(181, 9)).total, 21) // not 30
})

test('EnergyMeter: clock not set yet after boot does nothing', async () => {
  const { meter, poll, calls } = setup([[at(2025, 3, 1), 12]], { now: Date.UTC(1970, 0, 2) })
  assert.strictEqual(await poll(194, 1), null)
  assert.strictEqual(meter.refreshing, null)
  assert.strictEqual(calls.length, 0)
})

test('EnergyMeter: a load that never settles times out and frees the queue', async () => {
  const clock = { now: NOW }
  const timers = fakeTimers(clock)
  const queue = new energy.Queue()
  const stuck = setup([], { clock, timers, queue, fetchSessions: () => new Promise(() => {}) })
  const other = setup([[at(2025, 3, 1), 12]], { clock, timers, queue })
  await stuck.poll(161, 0)
  await other.poll(161, 0)
  await timers.advance(TIMING.HISTORY_LOAD_TIMEOUT) // time out the stuck load
  await stuck.meter.refreshing
  await other.meter.refreshing
  close((await other.poll(161, 0)).total, 12)
})

test('EnergyMeter: loads of several chargers run one after another', async () => {
  let running = 0
  let overlap = false
  const queue = new energy.Queue()
  const make = () => setup([], {
    queue,
    fetchSessions: async () => {
      if (++running > 1) overlap = true
      await new Promise(resolve => setImmediate(resolve))
      running--
      return { energy: 0, green: 0, count: 0, latest: null }
    }
  })
  const meters = [make(), make(), make()]
  await Promise.all(meters.map(m => m.poll(161, 0)))
  await Promise.all(meters.map(m => m.meter.refreshing))
  assert.strictEqual(overlap, false)
})

test('EnergyMeter: snapshot without added energy, with an unknown, offline or updating status: skipped', async () => {
  const { meter, poll } = setup([[at(2025, 3, 1), 12]])
  await poll(161, 0)
  await meter.refreshing
  assert.strictEqual(await meter.update({ status: STATUS.READY, addedKwh: null, addedGreenKwh: 0 }), null)
  assert.strictEqual(await poll(999, 1), null) // id not in STATUS_IDS: status null
  assert.strictEqual(await poll(null, 1), null) // offline
  assert.strictEqual(await poll(166, 1), null) // updating
  const values = await meter.update({ status: STATUS.READY, addedKwh: 0 }) // green missing counts as 0
  close(values.total, 12)
  close(values.green, 0)
})

test('EnergyMeter: a new charger needs 4 requests (was 13: every year one by one)', async () => {
  // First session 5 days ago, none before the recent window: this year and
  // last year are empty, so 2015-2024 is asked in one request
  const cutoff = NOW / 1000 - 30 * DAY
  const { meter, poll, calls } = setup([[NOW / 1000 - 5 * DAY, 8, 2]])
  await poll(161, 8, 2)
  await meter.refreshing
  assert.deepStrictEqual(calls, [
    [at(2026, 1, 1), cutoff - 1],
    [at(2025, 1, 1), at(2026, 1, 1) - 1],
    [at(2015, 1, 1), at(2025, 1, 1) - 1],
    [cutoff, NOW / 1000 + 60]
  ])
  const values = await poll(161, 8, 2)
  close(values.total, 8)
  close(values.green, 2)
})

test('EnergyMeter: charger last used years ago: one request for the old years, its last session not counted twice', async () => {
  // Last session in 2019 at 9 kWh, added_energy still shows it while waiting
  const { meter, poll, calls } = setup([[at(2018, 5, 1), 40], [at(2019, 5, 1), 9]])
  await poll(181, 9)
  await meter.refreshing
  assert.strictEqual(calls.length, 4)
  close((await poll(181, 9)).total, 49) // not 58
})

test('EnergyMeter: cut off request for the old years, nothing found before it: per year', async () => {
  const sessions = []
  for (let year = 2015; year <= 2020; year++) sessions.push([at(year, 6, 1), 1], [at(year, 7, 1), 1])
  const { meter, poll, api } = setup(sessions)
  api.maxRows = 2
  await poll(161, 0)
  await meter.refreshing
  close((await poll(161, 0)).total, 12)
})

test('EnergyMeter: by default the first load starts after 3 minutes, requests a minute apart', async () => {
  const clock = { now: NOW }
  const timers = fakeTimers(clock)
  const { meter, poll, times } = setup([[NOW / 1000 - 5 * DAY, 8]], { clock, timers, firstDelay: undefined, spacing: undefined })
  assert.strictEqual(await poll(161, 8), null) // load requested, waits
  await timers.advance(2 * MIN)
  assert.strictEqual(await poll(161, 8), null) // no history yet
  assert.deepStrictEqual(times, [])
  await timers.advance(20 * MIN)
  await meter.refreshing
  const first = NOW + TIMING.HISTORY_FIRST_DELAY
  const space = TIMING.HISTORY_SPACING
  assert.deepStrictEqual(times, [first, first + space, first + 2 * space, first + 3 * space])
  close((await poll(161, 8)).total, 8)
})

test('EnergyMeter: no requests before firstDelay, stored history shown meanwhile', async () => {
  const sessions = [[at(2025, 3, 1), 12]]
  const first = setup(sessions)
  await first.poll(161, 0)
  await first.meter.refreshing
  // Restart an hour later: the history is reloaded, but not before the delay
  const clock = { now: first.clock.now + 60 * MIN }
  const start = clock.now
  const timers = fakeTimers(clock)
  const second = setup(sessions, { store: first.store, clock, timers, firstDelay: 3 * MIN })
  close((await second.poll(161, 0)).total, 12)
  await timers.advance(2 * MIN)
  close((await second.poll(161, 0)).total, 12)
  assert.strictEqual(second.calls.length, 0)
  await timers.advance(MIN)
  await second.meter.refreshing
  assert.deepStrictEqual(second.times, [start + 3 * MIN])

  // Created long before the first poll: no wait left
  const late = setup(sessions, { clock, timers, firstDelay: 3 * MIN })
  await timers.advance(10 * MIN)
  await late.poll(161, 0)
  await late.meter.refreshing
  assert.strictEqual(late.times[0], clock.now)
})

test('EnergyMeter: requests of all chargers at least `spacing` apart, no spacing without timers', async () => {
  const clock = { now: NOW }
  const timers = fakeTimers(clock)
  const queue = new energy.Queue()
  const times = []
  const a = setup([[at(2025, 3, 1), 12]], { clock, timers, queue, times, spacing: MIN })
  const b = setup([[NOW / 1000 - 5 * DAY, 8]], { clock, timers, queue, times, spacing: MIN })
  await Promise.all([a.poll(161, 0), b.poll(161, 8)])
  await timers.advance(30 * MIN)
  await Promise.all([a.meter.refreshing, b.meter.refreshing])
  // a: 2026, 2025, 2024, 2023, 2015-2022, recent; then b: 4 requests
  assert.deepStrictEqual(times, Array.from({ length: 6 + 4 }, (_, i) => NOW + i * MIN))
  close((await a.poll(161, 0)).total, 12)
  close((await b.poll(161, 8)).total, 8)

  const plain = setup([[at(2025, 3, 1), 12]], { spacing: MIN })
  await plain.poll(161, 0)
  await plain.meter.refreshing
  assert.strictEqual(plain.calls.length, 6)
  assert.ok(plain.times.every(time => time === NOW))
})

test('EnergyMeter: load timeout is TIMING.HISTORY_LOAD_TIMEOUT, a late answer never writes', async () => {
  const sessions = [[at(2025, 3, 1), 12]]
  const first = setup(sessions)
  await first.poll(161, 0)
  await first.meter.refreshing
  await first.poll(161, 0)
  // Restart a day later: the only request (the recent window) hangs
  const clock = { now: first.clock.now + DAY * 1000 }
  const timers = fakeTimers(clock)
  const calls = []
  let answer
  const second = setup(sessions, {
    store: first.store,
    clock,
    timers,
    fetchSessions: start => {
      calls.push(start)
      return new Promise(resolve => { answer = resolve })
    }
  })
  close((await second.poll(161, 0)).total, 12)
  const saved = JSON.stringify(first.store)
  await timers.advance(TIMING.HISTORY_LOAD_TIMEOUT - 1)
  assert.notStrictEqual(second.meter.refreshing, null, 'still loading')
  await timers.advance(1)
  assert.strictEqual(second.meter.refreshing, null, 'timed out')
  // The request answers after the timeout, with a new session in it
  answer({ energy: 8, green: 0, count: 1, latest: 8 })
  await flush()
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(JSON.stringify(first.store), saved, 'store unchanged')
})

test('EnergyMeter: a timed-out load stops before its next request', async () => {
  const clock = { now: NOW }
  const timers = fakeTimers(clock)
  const calls = []
  let answer
  const { meter, poll, store } = setup([], {
    clock,
    timers,
    fetchSessions: start => {
      calls.push(start)
      return new Promise(resolve => { answer = resolve })
    }
  })
  await poll(161, 0)
  await timers.advance(TIMING.HISTORY_LOAD_TIMEOUT)
  await meter.refreshing
  answer({ energy: 0, green: 0, count: 0, latest: null }) // first year answers late
  await flush()
  assert.strictEqual(calls.length, 1)
  assert.deepStrictEqual(store, {})
})

test('EnergyMeter: dispose stops a load before its next request, nothing written', async () => {
  const { meter, calls, store } = setup([[at(2026, 11, 1), 10]])
  const done = meter.update({ status: 'paused', addedKwh: 1, addedGreenKwh: 0 })
  meter.dispose()
  await done
  await meter.refreshing
  assert.strictEqual(store.energy_history, undefined)
  assert.ok(calls.length <= 1)
})

'use strict'

/**
 * Lifetime energy meter for Homey Energy.
 *
 * Homey Energy needs a meter that only goes up. The Wallbox API gives the
 * energy of the current session (added_energy, resets every session) and a
 * list of finished sessions (v4/sessions/stats). The meter is:
 *   total = finished sessions + open session
 * The finished list is fetched again regularly, so energy missed while Homey
 * was off is added at the next refresh. The total never goes down.
 * Green (solar) energy is counted the same way.
 *
 * Energy values are { energy, green } in kWh.
 *
 * Finished sessions (history): { base, cutoff, recent, latest, refreshed }
 *   base      - sessions before cutoff, fetched once
 *   cutoff    - seconds, sessions from here on are fetched on every refresh
 *   recent    - sessions from cutoff on, at the last refresh
 *   latest    - energy of the last finished session, or null
 *   refreshed - time of the last refresh in ms
 *
 * Meter: { total, green, stale, open, last }
 *   total - lifetime kWh
 *   green - lifetime green kWh
 *   stale - added_energy of a session that is no longer open (it is in the
 *           finished list, or soon will be), null while a new session is open
 *   open  - a session was open at the previous poll
 *   last  - added_energy at the previous poll
 *
 * History requests are gentle on the Wallbox API: the first load starts a
 * while after the meter is created (app start), requests of all chargers are
 * spaced, a new charger needs about four, and a load that timed out stops and
 * never writes.
 */

const { SESSION_STATE, TIMING } = require('./contract')

const DAY = 24 * 60 * 60
const FIRST_YEAR = 2015 // Oldest year to look for sessions
const MIN_TIME = Date.UTC(2026, 0, 1) // Clock before this is not set yet (Homey just booted)
const WINDOW = 30 * DAY // Recent part, fetched on every refresh
const MAX_WINDOW = 60 * DAY // Move the cutoff when the recent part gets this long
const REFRESH = DAY * 1000 // Refresh at least daily
const GAP = 2.5 * TIMING.POLL_MAX * 1000 // Refresh after this long without a poll (Homey off, no internet); above the longest poll interval
const MIN_INTERVAL = 15 * 60 * 1000 // At most one list fetch per 15 minutes, failed ones too
const MAX_INTERVAL = DAY * 1000 // Longest wait after repeated failures
const TIMED_OUT = 'History load timed out'
const BUDGET_RETRIES = 5 // a request refused by our own budget is tried this often
const BUDGET_WAIT_MAX = 5 * 60 * 1000 // longest wait for budget room

/**
 * Queue for history loads. All devices share one, so an app start with
 * several chargers does not send all requests at once. It also holds the time
 * of the last request, so the spacing between requests counts for all chargers.
 */
class Queue {

  constructor() {
    this.tail = Promise.resolve()
    this.lastFetch = null // Time of the last history request in ms, any charger
  }

  /**
   * Run a task after the ones before it, also when those failed
   *
   * @param {Function} task - returns a promise
   * @return {Promise} result of the task
   */
  run(task) {
    const result = this.tail.then(task, task)
    this.tail = result.catch(() => {})
    return result
  }

}
exports.Queue = Queue
const sharedQueue = new Queue()

/**
 * Session state for a status (SESSION_STATE in lib/contract.js)
 *
 * @param {String|null} status - STATUS id
 * @return {String|null} 'open', 'none' or null when unknown (skip update)
 */
exports.sessionState = function(status) {
  return Object.prototype.hasOwnProperty.call(SESSION_STATE, status) ? SESSION_STATE[status] : null
}

/**
 * Sum a v4/sessions/stats response
 *
 * @param {Object} result - parsed response
 * @param {number|string} chargerId - only count sessions of this charger
 * @return {Object} { energy, green, count, latest }: kWh, sessions, energy of the last one
 */
exports.sumSessions = function(result, chargerId) {
  // A missing or cut off list would make the total too low, fail so it is fetched again
  if (!result || !Array.isArray(result.data))
    throw new Error('Session list missing')
  if (result.meta && result.meta.count > result.data.length) {
    const error = new Error(`Session list incomplete: ${result.data.length} of ${result.meta.count}`)
    error.code = 'incomplete'
    throw error
  }

  // The list is asked for this charger; drop sessions of other chargers in case it holds them
  const mine = session => {
    const charger = (session.attributes || {}).charger
    return charger == null || String(charger) === String(chargerId)
  }

  let end = -1
  return result.data.filter(mine).reduce((sum, session) => {
    const attributes = session.attributes || {}
    const kwh = value => (attributes.energy_unit === 'Wh' ? (Number(value) || 0) / 1000 : Number(value) || 0)
    const energy = kwh(attributes.energy)
    if ((Number(attributes.end) || 0) > end) {
      end = Number(attributes.end) || 0
      sum.latest = energy
    }
    sum.energy += energy
    sum.green += kwh(attributes.green_energy)
    sum.count++
    return sum
  }, { energy: 0, green: 0, count: 0, latest: null })
}

/**
 * Add two energy values
 *
 * @param {Object} a - { energy, green }
 * @param {Object} b - { energy, green }
 * @return {Object} { energy, green }
 */
exports.add = function(a, b) {
  return { energy: a.energy + b.energy, green: a.green + b.green }
}

/**
 * Green meter should be shown: the charger can do Eco-Smart (also while it is
 * switched off), or it charged green energy before
 *
 * @param {number} green - lifetime green kWh
 * @param {String|null} ecoSmart - Snapshot ecoSmart: ECO_SMART id, null when the charger has no Eco-Smart
 * @return {boolean}
 */
exports.showGreen = function(green, ecoSmart) {
  return green > 0 || ecoSmart != null
}

/**
 * Meter state before the first update
 *
 * @param {Object} session - current session { energy, green }
 * @param {boolean} open - a session is open
 * @param {number|null} latest - energy of the last finished session
 * @return {Object} meter state
 */
exports.initial = function(session, open, latest) {
  // added_energy may still show the last finished session, which is counted in the list
  const stale = !open || session.energy === latest ? session.energy : null
  return { total: 0, green: 0, stale, open, last: session.energy }
}

/**
 * New meter state
 *
 * @param {Object} meter - meter state of the previous poll
 * @param {Object} finished - all finished sessions { energy, green }
 * @param {Object} session - current session now { energy, green }
 * @param {boolean} open - a session is open
 * @return {Object} meter state
 */
exports.update = function(meter, finished, session, open) {
  let stale = meter.stale
  if (!open)
    stale = session.energy
  else if (stale !== null && session.energy !== stale)
    stale = null // New session started

  // The session only counts while open and not in the finished list yet
  const live = open && stale === null
  return {
    total: Math.max(meter.total, finished.energy + (live ? session.energy : 0)),
    green: Math.max(meter.green, finished.green + (live ? session.green : 0)),
    stale,
    open,
    last: session.energy
  }
}

/**
 * Should the finished list be fetched again
 *
 * @param {Object|null} meter - meter state of the previous poll
 * @param {Object|null} history - finished sessions
 * @param {Object} session - current session now { energy, green }
 * @param {boolean} open - a session is open
 * @param {number} now - time in ms
 * @param {number|null} lastPoll - time of the previous poll in ms, null after app start
 * @return {boolean}
 */
exports.refreshDue = function(meter, history, session, open, now, lastPoll) {
  if (!history || !lastPoll) return true // First run or app start
  if (now - lastPoll > GAP) return true // Sessions may have ended unseen
  if (now - history.refreshed > REFRESH) return true
  if (!meter) return false // History just loaded, first meter update
  if (meter.open && !open) return true // Session ended
  if (open && meter.stale !== null && session.energy !== meter.stale) return true // New session started
  if (open && session.energy < meter.last) return true // New session, previous one ended unseen
  return false
}

/**
 * Is a list fetch allowed now. At most every 15 minutes, failed ones too,
 * and twice as long after each further failure, up to a day.
 *
 * @param {number|null} lastAttempt - time of the previous fetch attempt in ms
 * @param {number} now - time in ms
 * @param {number} failures - failed fetches in a row
 * @return {boolean}
 */
exports.fetchAllowed = function(lastAttempt, now, failures = 0) {
  const wait = Math.min(MIN_INTERVAL * 2 ** Math.max(0, failures - 1), MAX_INTERVAL)
  return !lastAttempt || now - lastAttempt >= wait
}

/**
 * Split a time range per calendar year, so no request covers more than a year
 *
 * @param {number} from - seconds
 * @param {number} to - seconds, exclusive
 * @return {Array} [start, end] pairs, end inclusive
 */
exports.ranges = function(from, to) {
  const ranges = []
  for (let start = from; start < to;) {
    const nextYear = Date.UTC(new Date(start * 1000).getUTCFullYear() + 1, 0, 1) / 1000
    const end = Math.min(nextYear, to)
    ranges.push([start, end - 1])
    start = end
  }
  return ranges
}

/**
 * What a refresh has to fetch
 *
 * @param {Object|null} history - finished sessions
 * @param {number} now - seconds
 * @return {Object} { base, add, cutoff }: energy to keep, ranges to add to it, new cutoff
 */
exports.plan = function(history, now) {
  // No history, or the clock went back before the cutoff: load everything again
  if (!history || now < history.cutoff)
    return { base: { energy: 0, green: 0 }, add: exports.ranges(Date.UTC(FIRST_YEAR, 0, 1) / 1000, now - WINDOW), cutoff: now - WINDOW }
  if (now - history.cutoff > MAX_WINDOW)
    return { base: history.base, add: exports.ranges(history.cutoff, now - WINDOW), cutoff: now - WINDOW }
  return { base: history.base, add: [], cutoff: history.cutoff }
}

/**
 * Lifetime meter of one charger
 */
exports.EnergyMeter = class EnergyMeter {

  /**
   * @param {Object} options
   * @param {Function} options.fetchSessions - (start, end) => Promise of sumSessions result
   * @param {Object} options.store - persistent { get(key), set(key, value) }
   * @param {Function} options.log - log function
   * @param {Function} options.now - clock in ms, Date.now by default
   * @param {Object} options.timers - { setTimeout, clearTimeout } for the first delay, spacing and load
   *   timeout; without timers there is no delay, spacing or timeout
   * @param {Queue} options.queue - load queue, shared by all chargers by default
   * @param {number} options.firstDelay - ms after creation before the first history load
   * @param {number} options.spacing - ms between history requests, all chargers on the queue
   */
  constructor({ fetchSessions, store, log, now, timers, queue, firstDelay = TIMING.HISTORY_FIRST_DELAY, spacing = TIMING.HISTORY_SPACING }) {
    this._fetchSessions = fetchSessions
    this._store = store
    this._log = log || (() => {})
    this._now = now || Date.now
    this._timers = timers
    this._queue = queue || sharedQueue
    this._spacing = spacing
    this._sleeps = new Set() // pending waits { timer, resolve }, cleared by dispose()
    // Wait after a restart (Homey boot, many apps), timer based so a clock set
    // late after boot can't skip it. A new device has no history yet: no wait
    this._ready = store.get('energy_history') ? this._sleep(firstDelay) : Promise.resolve()
    this._updating = Promise.resolve()
    this._lastPoll = null
    this._lastAttempt = null
    this._failures = 0
    this._pending = false
    this.refreshing = null
  }

  /**
   * Update from a status poll; a due history fetch runs in the background.
   * Updates run one at a time, so overlapping polls can't lower the total.
   *
   * @param {Object} snapshot - Snapshot of the poll (lib/contract.js): status, addedKwh, addedGreenKwh
   * @return {Promise} { total, green } in kWh, or null when nothing to show yet
   */
  update(snapshot) {
    const run = () => this._update(snapshot)
    const result = this._updating.then(run, run)
    this._updating = result.catch(() => {})
    return result
  }

  async _update(snapshot) {
    const green = snapshot.addedGreenKwh
    const session = { energy: snapshot.addedKwh, green: Number.isFinite(green) ? green : 0 }
    const state = exports.sessionState(snapshot.status)
    const now = this._now()
    if (!Number.isFinite(session.energy) || state === null || now < MIN_TIME)
      return null

    const open = state === 'open'
    const prev = this._store.get('energy_meter')
    const history = this._store.get('energy_history')

    // A trigger stays pending until a fetch that started after it succeeds.
    // A missing history during the first load is not a new trigger.
    if (exports.refreshDue(prev, history, session, open, now, this._lastPoll) && !(this.refreshing && !history))
      this._pending = true
    if (this._pending && !this.refreshing && exports.fetchAllowed(this._lastAttempt, now, this._failures))
      this.refresh(history)
    this._lastPoll = now

    // Nothing to show before the first history load
    if (!history)
      return null

    const meter = exports.update(prev || exports.initial(session, open, history.latest), exports.add(history.base, history.recent), session, open)
    // Never save a broken value; update() never goes below the saved one
    if (!Number.isFinite(meter.total) || !Number.isFinite(meter.green))
      throw new Error(`Invalid meter value: ${meter.total}, ${meter.green}`)
    if (JSON.stringify(meter) !== JSON.stringify(prev))
      await this._store.set('energy_meter', meter)
    return { total: meter.total, green: meter.green }
  }

  /**
   * Fetch finished sessions, after the first delay and queued behind other chargers
   *
   * @param {Object|null} history - finished sessions of the last refresh
   * @return {Promise} resolves when done, never rejects
   */
  refresh(history) {
    if (this._disposed)
      return Promise.resolve()
    this._pending = false
    this._lastAttempt = this._now()
    this.refreshing = this._ready
      .then(() => this._queue.run(() => this._withTimeout(token => this._load(history, token))))
      .then(() => {
        this._failures = 0
      }, error => {
        if (this._disposed)
          return
        this._pending = true
        this._failures++
        this._log(`Failed to load energy history: ${(error && error.message) || error}`)
      })
      .then(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  /**
   * Device removed: a running or later load stops before its next request
   * and never writes
   */
  dispose() {
    this._disposed = true
    for (const sleep of this._sleeps) {
      this._timers.clearTimeout(sleep.timer)
      sleep.resolve()
    }
    this._sleeps.clear()
  }

  // A load that never settles must not block the queue for other chargers.
  // After the timeout its token is aborted: it stops before its next request
  // and never writes, also when a request still answers later.
  _withTimeout(load) {
    const token = { aborted: false }
    if (!this._timers)
      return load(token)
    let timer
    const timeout = new Promise((resolve, reject) => {
      timer = this._timers.setTimeout(() => {
        token.aborted = true
        reject(new Error(TIMED_OUT))
      }, TIMING.HISTORY_LOAD_TIMEOUT)
    })
    return Promise.race([load(token), timeout]).finally(() => this._timers.clearTimeout(timer))
  }

  // Wait ms with the injected timers; no wait without timers
  _sleep(ms) {
    if (!this._timers || !(ms > 0) || this._disposed)
      return Promise.resolve()
    return new Promise(resolve => {
      const sleep = { resolve }
      sleep.timer = this._timers.setTimeout(() => {
        this._sleeps.delete(sleep)
        resolve()
      }, ms)
      this._sleeps.add(sleep)
    })
  }

  // One request, at least `spacing` after the previous one of any charger
  async _fetch(start, end, token) {
    const last = this._queue.lastFetch
    if (last != null)
      await this._sleep(Math.min(this._spacing, last + this._spacing - this._now())) // min: clock went back
    for (let attempt = 1; ; attempt++) {
      if (token.aborted || this._disposed)
        throw new Error(TIMED_OUT)
      this._queue.lastFetch = this._now()
      try {
        return await this._fetchSessions(start, end)
      } catch (error) {
        // Our own request budget was full (not sent): wait for room, don't fail the load
        const wait = error && error.code === 'throttled' && error.sent === false && error.retryAt ? error.retryAt - this._now() : null
        if (wait === null || attempt >= BUDGET_RETRIES || wait > BUDGET_WAIT_MAX)
          throw error
        await this._sleep(Math.max(1000, wait))
      }
    }
  }

  async _load(history, token) {
    const now = Math.floor(this._now() / 1000)
    const plan = exports.plan(history, now)
    const ranges = plan.add
    const fetch = (start, end) => this._fetch(start, end, token)
    let base = plan.base
    let latest = null
    let empty = 0

    // All years in one request (Wallbox returns every session of a long
    // range, checked on a real charger: 554 sessions, 840 kB). Only when the
    // list comes back incomplete, it is asked per year: newest year first,
    // and after two empty years the years before in one request.
    let perYear = false
    if (ranges.length > 0)
      try {
        const all = await fetch(ranges[0][0], ranges[ranges.length - 1][1])
        base = exports.add(base, all)
        latest = all.latest
      } catch (error) {
        if (error.code !== 'incomplete')
          throw error
        perYear = true
      }
    for (let i = perYear ? ranges.length - 1 : -1; i >= 0; i--) {
      if (empty >= 2)
        try {
          const older = await fetch(ranges[0][0], ranges[i][1])
          base = exports.add(base, older)
          if (latest === null) latest = older.latest
          break
        } catch (error) {
          if (error.code !== 'incomplete')
            throw error
          empty = 0 // Too many sessions for one request, continue per year
        }
      const part = await fetch(ranges[i][0], ranges[i][1])
      base = exports.add(base, part)
      if (latest === null) latest = part.latest
      empty = part.count > 0 ? 0 : empty + 1
    }
    const recent = await fetch(plan.cutoff, now + 60)

    // Timed out while the last request ran: other loads may run by now
    if (token.aborted || this._disposed)
      throw new Error(TIMED_OUT)
    await this._store.set('energy_history', {
      base,
      cutoff: plan.cutoff,
      recent: { energy: recent.energy, green: recent.green },
      // Newest finished session: in the recent part, else the newest year with sessions
      latest: recent.latest !== null ? recent.latest : (latest !== null ? latest : (history ? history.latest : null)),
      refreshed: this._now()
    })
  }

}

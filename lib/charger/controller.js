'use strict'

/**
 * Runs the charger decisions (decide.js) against the Wallbox api: capability
 * commands, the flow card current, the work after every poll and the retries
 * after a throttle. Homey-free: the clock, timers, store and api are injected.
 *
 * Core rule: others (the Wallbox app, website, other integrations) can change
 * the charger at any time. The latest poll is the truth, never our own last
 * write. Only a PUT response overrides the polled current, until the next poll.
 *
 * Writes run one at a time (commands, the card, poll work, the queued current).
 */

const { STATUS, CAR_CONNECTED, COMMAND, ERR, MSG, CAP, MODE, FLOW, TIMING, MIN_AMP } = require('../contract')
const decide = require('./decide')
const { PhaseMeter } = require('../phases')

// Translation key per error code; throttled and the rest are handled apart
const ERROR_MSG = Object.freeze({
  [ERR.REFUSED]: MSG.REFUSED,
  [ERR.AUTH_REJECTED]: MSG.LOGIN,
  [ERR.TIMEOUT]: MSG.TIMEOUT,
  [ERR.NETWORK]: MSG.NETWORK
})

const MINUTE = 60 * 1000
const PAUSE = 'pause'
const RESUME = 'resume'

/**
 * Stored targetPaused, also the boolean of app versions before the rebuild
 *
 * @param {*} value - store value
 * @param {number} now - ms
 * @return {Object|null} { at, confirmed } or null
 */
function storedPause(value, now) {
  if (value === true)
    return { at: now, confirmed: false } // the next paused poll confirms it, else it expires
  if (value && Number.isFinite(value.at) && typeof value.confirmed === 'boolean')
    return { at: value.at, confirmed: value.confirmed }
  return null
}

function samePause(a, b) {
  return a === b || Boolean(a && b && a.at === b.at && a.confirmed === b.confirmed)
}

class ChargerController {

  /**
   * @param {Object} options
   * @param {Object} options.api - WallboxApi: setCurrent, pause, resume, setLocked, setEcoSmart
   * @param {string} options.chargerId
   * @param {Function} options.now - time in ms
   * @param {Object} options.timers - { setTimeout(fn, ms), clearTimeout(handle) }
   * @param {Object} options.store - { get(key), set(key, value) → Promise }: 'phases', 'targetPaused'
   * @param {Function} options.log - (message)
   * @param {Function} options.t - (key, vars) translate
   * @param {Object} options.caps - { get(id) } capability values
   * @param {Function} options.requestPoll - (ms) poll sooner
   * @param {Function} options.onEvent - (trigger, tokens) fire a flow trigger
   */
  constructor({ api, chargerId, now, timers, store, log, t, caps, requestPoll, onEvent }) {
    this.api = api
    this.chargerId = chargerId
    this.now = now
    this.timers = timers
    this.store = store
    this.log = log || (() => {})
    this.t = t
    this.caps = caps
    this.requestPoll = requestPoll || (() => {})
    this.onEvent = onEvent || (() => {})

    this.view = null // latest View
    this.observed = null // set current: latest poll, or the PUT response after it
    this.lastIncreaseAt = null
    this.queued = null // increase waiting for the window's end { amps, at, homey }
    this.queueTimer = null
    this.meter = new PhaseMeter(store.get('phases'))
    this.targetPaused = storedPause(store.get('targetPaused'), now())
    this.follow = null // { command, at, seenWaiting }
    this.switched = null // our last pause/resume { action, at }, not repeated until a poll catches up
    this.retries = { stop: null, current: null } // throttled safety commands { at, retryAt[, amps] }
    this.blockedUntil = 0 // throttled: poll work writes nothing before this
    this.chain = Promise.resolve()
  }

  /**
   * Last known phases, for the amps and the slider maximum
   */
  get phases() {
    return this.meter.phases
  }

  /**
   * Phases measured this session, else 1, for the minimum
   */
  get measuredPhases() {
    return this.meter.measured
  }

  /**
   * Options for the target_power capability
   *
   * @return {Object} { min, max, step, excludeMin, excludeMax }
   */
  targetOptions() {
    return decide.targetOptions(this.view && this.view.maxAvailable, this.phases, this.measuredPhases)
  }

  /**
   * A batch of the multi-capability listener
   *
   * @param {Object} batch - subset of { target_power, target_power_mode, evcharger_charging }
   * @return {Promise} rejects with a translated Error
   */
  command(batch) {
    return this.serial(() => this.runCommand(batch || {}))
  }

  /**
   * Set the charging current (flow card), only outside Homey mode
   *
   * @param {number} amps - A
   * @return {Promise<Object>} { result: 'sent'|'queued'|'unchanged', amps, seconds }
   */
  setCurrent(amps) {
    return this.serial(async () => {
      if (this.caps.get(CAP.TARGET_MODE) === MODE.HOMEY)
        throw new Error(this.t(MSG.HOMEY_CONTROLS))
      const max = decide.maxAmps(this.view && this.view.maxAvailable)
      if (!(amps >= MIN_AMP && amps <= max))
        throw new Error(this.t(MSG.CURRENT_RANGE, { min: MIN_AMP, max }))

      const at = this.now()
      const lower = this.observed != null && amps < this.observed
      try {
        return await this.applyCurrent(amps, false)
      } catch (error) {
        const retryAt = this.throttled(error)
        if (retryAt && lower)
          this.retries.current = { amps, at, retryAt }
        throw this.fail(error, 'Set current')
      }
    })
  }

  /**
   * @param {boolean} locked
   * @return {Promise} rejects with a translated Error
   */
  setLocked(locked) {
    return this.serial(() => this.write('Lock', () => this.api.setLocked(this.chargerId, Boolean(locked))))
  }

  /**
   * @param {string} mode - ECO_SMART id
   * @return {Promise} rejects with a translated Error
   */
  setEcoSmart(mode) {
    return this.serial(() => this.write('Eco-Smart', () => this.api.setEcoSmart(this.chargerId, mode)))
  }

  /**
   * Work after a poll: phases, follow check, due retries, reconcile.
   * Never throws.
   *
   * @param {Object} view - View of this poll
   * @return {Promise}
   */
  async onPoll(view) {
    try {
      if (!view)
        return
      const now = this.now()
      this.view = view
      await this.updatePhases(view, now)
      this.checkFollow(view, now)
      if (this.switched && now - this.switched.at >= TIMING.FOLLOW_DELAY)
        this.switched = null
      this.observe(view)
      await this.serial(async () => {
        await this.runRetries(view, now)
        await this.reconcile(this.caps.get(CAP.TARGET_MODE), this.caps.get(CAP.TARGET_POWER), true)
      })
    } catch (error) {
      this.log(`Poll work failed: ${error && error.message}`)
    }
  }

  // Commands

  /**
   * One batch: Stop, else Start, else a switch to Automatic, else the target in Homey mode
   *
   * @param {Object} batch - changed capability values
   */
  async runCommand(batch) {
    const has = id => batch[id] !== undefined
    const mode = has(CAP.TARGET_MODE) ? batch[CAP.TARGET_MODE] : this.caps.get(CAP.TARGET_MODE)
    const target = has(CAP.TARGET_POWER) ? batch[CAP.TARGET_POWER] : this.caps.get(CAP.TARGET_POWER)
    if (batch[CAP.CHARGING] === false)
      return this.stop()
    if (batch[CAP.CHARGING] === true)
      return this.start(mode, target)
    if (batch[CAP.TARGET_MODE] === MODE.DEVICE)
      return this.resumeOwnPause()
    if (mode === MODE.HOMEY && (has(CAP.TARGET_POWER) || batch[CAP.TARGET_MODE] === MODE.HOMEY))
      return this.reconcile(mode, target, false)
  }

  /**
   * Stop: always pause, and forget our own pause (this one is the user's)
   */
  async stop() {
    const at = this.now()
    this.setTargetPaused(null)
    this.retries.stop = null
    try {
      await this.sendSwitch(PAUSE)
    } catch (error) {
      const retryAt = this.throttled(error)
      if (retryAt)
        this.retries.stop = { at, retryAt }
      throw this.fail(error, 'Stop')
    }
    this.arm(COMMAND.STOP, at)
  }

  /**
   * Start: always resume. In Homey mode the amps follow the target first, and
   * a target below the minimum fails: Homey Energy would pause it again.
   *
   * @param {string|null} mode - target_power_mode after this batch
   * @param {number|null} target - target_power after this batch
   */
  async start(mode, target) {
    const at = this.now()
    if (mode === MODE.HOMEY) {
      if (target == null || target < decide.minPower(this.measuredPhases))
        throw new Error(this.t(MSG.HOMEY_CONTROLS))
      const amps = decide.ampsForPower(target, this.phases, this.view && this.view.maxAvailable)
      try {
        await this.applyCurrent(amps, true)
      } catch (error) {
        this.throttled(error)
        throw this.fail(error, 'Start current')
      }
    }

    this.retries.stop = null
    try {
      await this.sendSwitch(RESUME)
    } catch (error) {
      this.throttled(error) // a Start is not retried
      throw this.fail(error, 'Start')
    }
    this.setTargetPaused(null)
    this.arm(COMMAND.START, at)
  }

  /**
   * Switch to Automatic: undo our own pause, only when a poll confirmed it
   * and the charger is still paused. Otherwise leave the charger as it is.
   */
  async resumeOwnPause() {
    const own = this.targetPaused
    if (!own || !own.confirmed || !this.view || this.view.status !== STATUS.PAUSED)
      return
    try {
      await this.sendSwitch(RESUME)
      this.setTargetPaused(null)
      this.requestPoll(TIMING.FOLLOW_DELAY)
    } catch (error) {
      this.throttled(error)
      this.log(`Could not resume own pause: ${error && error.message}`)
    }
  }

  /**
   * Make the charger follow the target power, against the latest poll
   *
   * @param {string|null} mode - target_power_mode
   * @param {number|null} target - target_power
   * @param {boolean} fromPoll - errors are logged instead of thrown
   */
  async reconcile(mode, target, fromPoll) {
    const now = this.now()
    const view = this.view && { ...this.view, maxCurrent: this.observed }
    this.setTargetPaused(decide.nextTargetPaused(this.targetPaused, view, now))
    if (mode !== MODE.HOMEY || (fromPoll && now < this.blockedUntil))
      return

    const result = decide.reconcile({
      view, mode, target, phases: this.phases, measuredPhases: this.measuredPhases, targetPaused: this.targetPaused, now
    })
    const errors = []
    if (result.amps == null)
      this.setQueue(null) // nothing newer to send
    else
      await this.applyCurrent(result.amps, true).catch(error => errors.push(error))

    // Our pause or resume is not repeated before a poll catches up with it
    const repeat = this.switched && this.switched.action === result.action
    if (result.action && !repeat)
      await this.sendSwitch(result.action).then(() => {
        this.setTargetPaused(result.targetPaused)
        this.requestPoll(TIMING.FOLLOW_DELAY)
      }, error => errors.push(error))
    this.report(errors, fromPoll)
  }

  /**
   * Errors of a reconcile, all logged. For a command the first one is thrown,
   * except a refusal (car just gone) and a throttle: the target is kept (a
   * thrown error would make Homey drop it) and the first poll after retryAt
   * reconciles again, so a target pause and a lower current are retried.
   */
  report(errors, fromPoll) {
    const throttled = errors.find(error => error && error.code === ERR.THROTTLED)
    if (throttled)
      this.throttled(throttled)
    const failures = errors.map(error => ({ code: error && error.code, failure: this.fail(error, 'Target power') }))
    const thrown = failures.find(({ code }) => code !== ERR.THROTTLED && code !== ERR.REFUSED)
    if (thrown && !fromPoll)
      throw thrown.failure
  }

  // Current

  /**
   * Set a current through the throttle
   *
   * @param {number} wanted - A
   * @param {boolean} homey - wanted by Homey Energy (dropped when Homey mode ends)
   * @return {Promise<Object>} { result, amps, seconds }; rejects with the api error
   */
  async applyCurrent(wanted, homey) {
    const now = this.now()
    const plan = decide.planCurrent({ wanted, observed: this.observed, lastIncreaseAt: this.lastIncreaseAt, queued: this.queued, now })
    this.retries.current = null // a newer current decision
    this.setQueue(plan.queue, homey)
    if (plan.queue)
      return { result: 'queued', amps: plan.queue.amps, seconds: Math.ceil((plan.queue.at - now) / 1000) }
    if (plan.send == null)
      return { result: 'unchanged', amps: wanted, seconds: 0 }

    const increase = this.observed == null || plan.send > this.observed
    const set = await this.api.setCurrent(this.chargerId, plan.send)
    this.observed = Number.isFinite(set) ? set : plan.send
    if (increase)
      this.lastIncreaseAt = now
    return { result: 'sent', amps: this.observed, seconds: 0 }
  }

  /**
   * Replace the queued increase, and its timer for the window's end
   *
   * @param {Object|null} queue - { amps, at } from planCurrent
   * @param {boolean} homey - wanted by Homey Energy
   */
  setQueue(queue, homey) {
    if (this.queueTimer)
      this.timers.clearTimeout(this.queueTimer)
    this.queueTimer = null
    this.queued = queue ? { amps: queue.amps, at: queue.at, homey } : null
    if (!queue)
      return

    const queued = this.queued
    this.queueTimer = this.timers.setTimeout(() => {
      this.queueTimer = null
      this.serial(() => this.flushQueue(queued)).catch(error => this.log(`Queued current failed: ${error.message}`))
    }, Math.max(0, queue.at - this.now()))
  }

  /**
   * The window ended: send the queued value, planned against the current now
   */
  async flushQueue(queued) {
    if (this.queued !== queued)
      return // replaced or dropped
    this.setQueue(null)
    if (queued.homey && this.caps.get(CAP.TARGET_MODE) !== MODE.HOMEY)
      return
    try {
      await this.applyCurrent(queued.amps, queued.homey)
    } catch (error) {
      this.throttled(error) // an increase is not retried
      this.fail(error, 'Queued current')
    }
  }

  /**
   * The poll is the truth for the set current
   *
   * @param {Object} view - View of this poll
   */
  observe(view) {
    const current = view.maxCurrent == null ? null : view.maxCurrent
    // Changed elsewhere: a queued card value is older than that change
    if (current !== this.observed && this.queued && !this.queued.homey)
      this.setQueue(null)
    this.observed = current
  }

  // Pause and resume

  /**
   * Pause or resume, remembered until a poll catches up with it
   *
   * @param {string} action - 'pause' or 'resume'
   */
  async sendSwitch(action) {
    if (action === PAUSE)
      await this.api.pause(this.chargerId)
    else
      await this.api.resume(this.chargerId)
    this.switched = { action, at: this.now() }
  }

  /**
   * Check at a later poll whether the charger followed a Start or Stop
   */
  arm(command, at) {
    this.requestPoll(TIMING.FOLLOW_DELAY)
    this.follow = { command, at, seenWaiting: false }
  }

  /**
   * Follow check at a poll; fires not_followed when the charger did not follow
   */
  checkFollow(view, now) {
    const follow = this.follow
    if (!follow)
      return
    if (now - follow.at >= TIMING.FOLLOW_EXPIRE) {
      this.follow = null
      this.log(`Follow check of ${follow.command} expired`)
      return
    }
    // Too early: the charger needs time, and the poll may predate the command
    if (now - follow.at < TIMING.FOLLOW_DELAY)
      return

    const result = decide.followCheck(follow.command, view, follow.seenWaiting)
    if (!result.done) {
      follow.seenWaiting = result.seenWaiting
      return
    }
    this.follow = null
    if (result.reason)
      this.emit(FLOW.TRIGGER.NOT_FOLLOWED, { command: follow.command, reason: result.reason })
  }

  /**
   * Fire a flow trigger, errors only logged
   */
  emit(trigger, tokens) {
    try {
      Promise.resolve(this.onEvent(trigger, tokens)).catch(error => this.log(`Trigger ${trigger} failed: ${error && error.message}`))
    } catch (error) {
      this.log(`Trigger ${trigger} failed: ${error && error.message}`)
    }
  }

  /**
   * Set our own pause { at, confirmed } or null, stored when it changes
   */
  setTargetPaused(value) {
    if (samePause(value, this.targetPaused))
      return
    this.targetPaused = value
    this.save('targetPaused', value)
  }

  // Retries

  /**
   * Note a throttle: poll work holds its writes until retryAt, and a poll is
   * asked for right after it
   *
   * @return {number|null} retryAt, null when the error is no throttle
   */
  throttled(error) {
    if (!(error && error.code === ERR.THROTTLED))
      return null
    const now = this.now()
    const retryAt = error.retryAt > now ? error.retryAt : now + TIMING.BACKOFF[0]
    this.blockedUntil = Math.max(this.blockedUntil, retryAt)
    this.requestPoll(retryAt - now)
    return retryAt
  }

  /**
   * Run throttled safety commands at the first poll after retryAt, only while
   * the same session is open and for at most TIMING.RETRY_EXPIRE. A target
   * pause and a lower current from the target are retried by the reconcile
   * of that poll, which decides with the latest target.
   */
  async runRetries(view, now) {
    const car = CAR_CONNECTED[view.status]
    for (const kind of ['stop', 'current']) {
      const intent = this.retries[kind]
      if (!intent)
        continue
      if (car === false || now - intent.at > TIMING.RETRY_EXPIRE) {
        this.retries[kind] = null
        this.log(`Retry of ${kind} dropped`)
        continue
      }
      if (now < intent.retryAt || car !== true)
        continue

      this.retries[kind] = null
      try {
        if (kind === 'stop') {
          await this.sendSwitch(PAUSE)
          this.setTargetPaused(null)
          this.requestPoll(TIMING.FOLLOW_DELAY)
        } else if (this.caps.get(CAP.TARGET_MODE) !== MODE.HOMEY && (this.observed == null || intent.amps < this.observed))
          await this.applyCurrent(intent.amps, false) // still lower than the charger has
      } catch (error) {
        const retryAt = this.throttled(error)
        if (retryAt)
          this.retries[kind] = { ...intent, retryAt }
        else
          this.fail(error, `Retry of ${kind}`)
      }
    }
  }

  // Helpers

  /**
   * Run after the writes before it, also when those failed
   *
   * @param {Function} task - returns a promise
   * @return {Promise} result of the task
   */
  serial(task) {
    const run = this.chain.then(() => task())
    this.chain = run.catch(() => {})
    return run
  }

  /**
   * A plain write (lock, Eco-Smart), then a poll soon
   */
  async write(what, request) {
    try {
      await request()
    } catch (error) {
      this.throttled(error)
      throw this.fail(error, what)
    }
    this.requestPoll(TIMING.FOLLOW_DELAY)
  }

  /**
   * Phase meter update, 'phases' stored when the last known value changes
   */
  async updatePhases(view, now) {
    const last = this.meter.last
    this.meter.update(view.status, view.maxCurrent, (view.powerW || 0) / 1000, now)
    if (this.meter.last !== last)
      await this.save('phases', this.meter.last)
  }

  /**
   * Store a value, errors only logged
   */
  async save(key, value) {
    try {
      await this.store.set(key, value)
    } catch (error) {
      this.log(`Could not store ${key}: ${error && error.message}`)
    }
  }

  /**
   * Translated Error for an api error (WallboxError)
   *
   * @param {Error} error - api error
   * @param {string} what - for the log
   * @return {Error} message from MSG, code of the api error
   */
  fail(error, what) {
    const code = (error && error.code) || null
    this.log(`${what} failed: ${code || 'error'} ${error && error.message}`)
    const result = new Error(this.message(error, code))
    result.code = code
    return result
  }

  /**
   * Translated message for an api error code
   */
  message(error, code) {
    if (code === ERR.THROTTLED)
      return this.t(MSG.BUSY, { minutes: Math.max(1, Math.ceil(((error.retryAt || 0) - this.now()) / MINUTE)) })
    if (ERROR_MSG[code])
      return this.t(ERROR_MSG[code])
    return this.t(MSG.FAILED, { status: error && error.status != null ? error.status : '-' })
  }

}

module.exports = { ChargerController }

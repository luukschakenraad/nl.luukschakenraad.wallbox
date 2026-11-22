'use strict'

/**
 * Poll timer for one charger
 *
 * Runs `run` every interval. Runs never overlap: a run that comes due while
 * one is busy starts right after it. soon() only moves the next run earlier,
 * and the interval restarts from every run.
 */
class Poller {

  /**
   * @param {Object} options
   * @param {Function} options.run - async, one poll
   * @param {Object} options.timers - { setTimeout(fn, ms), clearTimeout(handle) }
   * @param {Function} options.now - time in ms
   * @param {Function} options.log - (message)
   */
  constructor({ run, timers, now, log, timeout, onTimeout }) {
    this.run = run
    this.timeout = timeout || null // ms: a run busy longer no longer blocks the next runs
    this.onTimeout = onTimeout || (() => {})
    this.timers = timers
    this.now = now
    this.log = log || (() => {})
    this.interval = null
    this.stopped = true
    this.running = false
    this.again = false // came due while running
    this.timer = null
    this.nextAt = null
    this.early = false // nextAt was set by soon()
    this.lastStart = null
  }

  /**
   * @param {number} intervalMs - between runs
   * @param {number} offsetMs - first run after this (stagger chargers)
   */
  start(intervalMs, offsetMs = 0) {
    this.stop()
    this.stopped = false
    this.interval = intervalMs
    this.lastStart = null
    this.schedule(this.now() + Math.max(0, offsetMs || 0), false)
  }

  /**
   * Run within ms, unless a run is due sooner already
   *
   * @param {number} ms
   */
  soon(ms) {
    if (this.stopped)
      return
    const at = this.now() + Math.max(0, ms || 0)
    if (this.nextAt == null || at < this.nextAt)
      this.schedule(at, true)
  }

  /**
   * Change the interval, counted from the last run. A sooner run asked for
   * with soon() stays.
   *
   * @param {number} ms
   */
  setInterval(ms) {
    if (ms === this.interval)
      return
    this.interval = ms
    if (this.stopped || this.lastStart == null)
      return
    const regular = Math.max(this.now(), this.lastStart + ms)
    if (!(this.early && this.nextAt != null && this.nextAt <= regular))
      this.schedule(regular, false)
  }

  /**
   * Wait for a run, at most `timeout`: a run that hangs (a call that never
   * answers) must never stop polling
   *
   * @param {Promise} run
   * @return {Promise}
   */
  watch(run) {
    if (!this.timeout)
      return run
    let timer = null
    const late = new Promise(resolve => {
      timer = this.timers.setTimeout(() => {
        timer = null
        this.onTimeout()
        resolve()
      }, this.timeout)
    })
    return Promise.race([run, late]).finally(() => {
      if (timer)
        this.timers.clearTimeout(timer)
    })
  }

  stop() {
    this.stopped = true
    this.again = false
    this.clear()
  }

  clear() {
    if (this.timer)
      this.timers.clearTimeout(this.timer)
    this.timer = null
    this.nextAt = null
    this.early = false
  }

  schedule(at, early) {
    this.clear()
    this.nextAt = at
    this.early = early
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      this.nextAt = null
      this.tick()
    }, Math.max(0, at - this.now()))
  }

  async tick() {
    if (this.stopped)
      return
    if (this.running) {
      if (!this.again)
        this.log('Poll due while the previous one still runs')
      this.again = true
      return
    }

    this.running = true
    this.lastStart = this.now()
    this.schedule(this.lastStart + this.interval, false)
    const run = Promise.resolve().then(() => this.run()).catch(error => this.log(`Poll failed: ${error && error.message}`))
    await this.watch(run)
    this.running = false

    if (this.again && !this.stopped) {
      this.again = false
      return this.tick()
    }
    this.again = false
  }

}

module.exports = { Poller }

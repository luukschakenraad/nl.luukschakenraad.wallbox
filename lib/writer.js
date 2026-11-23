'use strict'

/**
 * Writes to Homey without ever making the caller wait; the newest value wins.
 *
 * Homey may answer a call (setCapabilityValue, setStoreValue, setUnavailable,
 * ...) late or never, and the SDK has no time limit of its own. A caller that
 * awaits such a call can hang forever, and so does every queue it sits in.
 * This writer takes the waiting out of the caller:
 *
 * - set() returns at once. Per key at most one write is in flight; while it
 *   is, only the newest value waits, so nothing piles up.
 * - get() returns the newest value at once, also before Homey answered.
 * - A write that takes longer than `timeout` is logged. With `moveOn` the next
 *   write starts anyway (for calls the SDK doesn't queue itself); without it
 *   the writer keeps waiting for the answer (the SDK queues these per key, so
 *   a new call would only line up behind the stuck one).
 * - `serial`: one write in flight over all keys. For the device store: every
 *   setStoreValue sends the whole store, so two at once could arrive in the
 *   wrong order and an older one would undo a newer one.
 *
 * Homey-free: the write and read functions and the timers are injected.
 */
class LatestWriter {

  /**
   * @param {Object} options
   * @param {Function} options.write - (key, value) → Promise, the Homey call
   * @param {Function} [options.read] - key → value Homey has now (without waiting)
   * @param {Object} options.timers - { setTimeout(fn, ms), clearTimeout(handle) }
   * @param {number} [options.timeout] - ms before a write counts as slow
   * @param {boolean} [options.moveOn] - start the next write after `timeout` anyway
   * @param {boolean} [options.serial] - one write in flight over all keys
   * @param {Function} [options.log] - (message)
   * @param {string} [options.name] - for the log
   */
  constructor({ write, read, timers, timeout = 30 * 1000, moveOn = false, serial = false, log, name = 'write' }) {
    this.write = write
    this.read = read || (() => undefined)
    this.timers = timers
    this.timeout = timeout
    this.moveOn = moveOn
    this.serial = serial
    this.log = log || (() => {})
    this.name = name
    this.waiting = new Map() // key → newest value not sent yet
    this.flight = new Map() // key → { value } of the write Homey hasn't answered
    this.busy = 0 // writes in flight that block the next one (serial)
    this.idlers = []
    this.disposed = false
  }

  /**
   * Write a value; returns at once
   *
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    if (this.disposed)
      return
    const flying = this.flight.get(key)
    if (flying && same(flying.value, value)) {
      this.waiting.delete(key) // the newest value is the one already on its way
      return
    }
    this.waiting.set(key, value)
    this.pump()
  }

  /**
   * The newest value: waiting, else in flight, else what Homey has
   *
   * @param {string} key
   * @return {*}
   */
  get(key) {
    if (this.waiting.has(key))
      return this.waiting.get(key)
    if (this.flight.has(key))
      return this.flight.get(key).value
    return this.read(key)
  }

  /**
   * @param {string} key
   * @return {boolean} a write for this key waits or is in flight
   */
  pending(key) {
    return this.waiting.has(key) || this.flight.has(key)
  }

  /**
   * @return {Promise} resolves once nothing waits and nothing is in flight
   *   (slow writes that were moved on from count as done)
   */
  idle() {
    if (this.isIdle())
      return Promise.resolve()
    return new Promise(resolve => this.idlers.push(resolve))
  }

  /**
   * No new writes, drop the waiting ones (device removed)
   */
  dispose() {
    this.disposed = true
    this.waiting.clear()
    this.wake()
  }

  isIdle() {
    return this.waiting.size === 0 && this.busy === 0
  }

  wake() {
    if (!this.isIdle())
      return
    const idlers = this.idlers
    this.idlers = []
    for (const resolve of idlers)
      resolve()
  }

  pump() {
    for (const key of [...this.waiting.keys()]) {
      if (this.disposed || (this.serial && this.busy > 0))
        return
      if (!this.flight.has(key))
        this.start(key)
    }
  }

  start(key) {
    const value = this.waiting.get(key)
    this.waiting.delete(key)
    const entry = { value, released: false }
    this.flight.set(key, entry)
    this.busy++

    const timer = this.timers.setTimeout(() => {
      this.log(`${this.name} ${key}: Homey hasn't answered in ${Math.round(this.timeout / 1000)} s${this.moveOn ? ', going on' : ', still waiting'}`)
      if (this.moveOn)
        this.release(key, entry)
    }, this.timeout)

    let call
    try {
      call = Promise.resolve(this.write(key, value)) // started right away
    } catch (error) {
      call = Promise.reject(error)
    }
    call
      .catch(error => this.log(`${this.name} ${key} failed: ${(error && error.message) || error}`))
      .then(() => {
        this.timers.clearTimeout(timer)
        this.release(key, entry)
      })
  }

  release(key, entry) {
    if (entry.released)
      return
    entry.released = true
    if (this.flight.get(key) === entry)
      this.flight.delete(key)
    this.busy--
    this.pump()
    this.wake()
  }

}

/**
 * Same value: equal primitives, or objects with the same JSON
 */
function same(a, b) {
  if (a === b)
    return true
  if (a && b && typeof a === 'object' && typeof b === 'object')
    return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/**
 * Wait for a promise at most `ms`; never rejects
 *
 * @param {Promise} promise
 * @param {number} ms
 * @param {Object} timers - { setTimeout, clearTimeout }
 * @return {Promise<Object>} { done: true, value } or { done: false } after ms, or { done: true, error }
 */
function bounded(promise, ms, timers) {
  let timer = null
  const late = new Promise(resolve => {
    timer = timers.setTimeout(() => resolve({ done: false }), ms)
  })
  const settled = Promise.resolve(promise).then(value => ({ done: true, value }), error => ({ done: true, error }))
  return Promise.race([settled, late]).then(result => {
    timers.clearTimeout(timer)
    return result
  })
}

module.exports = { LatestWriter, bounded, same }

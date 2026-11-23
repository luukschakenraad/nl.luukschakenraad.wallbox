'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { LatestWriter, bounded } = require('../lib/writer')

test.beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }))

const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) }
const flush = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise(resolve => setImmediate(resolve))
}

// A fake Homey call per key that answers only when told to
function homey() {
  const calls = []
  const values = {}
  const write = (key, value) => new Promise((resolve, reject) => {
    calls.push({ key, value, resolve: () => { values[key] = value; resolve() }, reject })
  })
  return { calls, values, write, read: key => values[key] }
}

test('writer: set returns at once, get gives the newest value before Homey answers', async () => {
  const h = homey()
  const writer = new LatestWriter({ write: h.write, read: h.read, timers })
  writer.set('status', 'charging')
  assert.strictEqual(writer.get('status'), 'charging')
  assert.strictEqual(h.calls.length, 1)
  h.calls[0].resolve()
  await writer.idle()
  assert.strictEqual(writer.get('status'), 'charging')
  assert.strictEqual(writer.pending('status'), false)
})

test('writer: one write per key in flight, only the newest waits, it is written last', async () => {
  const h = homey()
  const writer = new LatestWriter({ write: h.write, read: h.read, timers })
  writer.set('status', 'a')
  writer.set('status', 'b')
  writer.set('status', 'c')
  assert.strictEqual(h.calls.length, 1, 'no pile-up behind the first')
  assert.strictEqual(writer.get('status'), 'c')
  h.calls[0].resolve()
  await flush()
  assert.deepStrictEqual(h.calls.map(call => call.value), ['a', 'c'], 'b was replaced by c')
  h.calls[1].resolve()
  await writer.idle()
  assert.strictEqual(h.values.status, 'c')
})

test('writer: setting the value already in flight drops the waiting one', async () => {
  const h = homey()
  const writer = new LatestWriter({ write: h.write, read: h.read, timers })
  writer.set('locked', true)
  writer.set('locked', false)
  writer.set('locked', true)
  h.calls[0].resolve()
  await writer.idle()
  assert.deepStrictEqual(h.calls.map(call => call.value), [true])
})

test('writer: other keys go on while one key is stuck (capabilities)', async () => {
  const h = homey()
  const logs = []
  const writer = new LatestWriter({ write: h.write, read: h.read, timers, timeout: 30000, log: message => logs.push(message), name: 'capability' })
  writer.set('status', 'charging') // never answered
  writer.set('measure_power', 7000)
  h.calls[1].resolve()
  await flush()
  assert.strictEqual(h.values.measure_power, 7000)
  writer.set('status', 'paused')
  writer.set('status', 'ready')
  assert.strictEqual(h.calls.filter(call => call.key === 'status').length, 1, 'still one status write, the newest waits')
  tick(30000)
  await flush()
  assert.match(logs[0], /capability status: Homey hasn't answered in 30 s, still waiting/)
  h.calls[0].resolve()
  await flush()
  assert.deepStrictEqual(h.calls.filter(call => call.key === 'status').map(call => call.value), ['charging', 'ready'])
})

test('writer: serial store writes one at a time; moveOn goes on after the timeout', async () => {
  const h = homey()
  const logs = []
  const writer = new LatestWriter({ write: h.write, read: h.read, timers, timeout: 30000, moveOn: true, serial: true, log: message => logs.push(message), name: 'store' })
  writer.set('energy_meter', { total: 1 })
  writer.set('phases', 3)
  assert.strictEqual(h.calls.length, 1, 'one store write in flight over all keys')
  assert.strictEqual(writer.get('phases'), 3, 'read sees the waiting value')
  tick(30000)
  await flush()
  assert.strictEqual(h.calls.length, 2, 'the stuck write is left behind, the next one goes')
  assert.match(logs[0], /store energy_meter: Homey hasn't answered in 30 s, going on/)
  h.calls[1].resolve()
  await flush()
  assert.strictEqual(h.values.phases, 3)
})

test('writer: a failed write is logged and the next one still goes', async () => {
  const h = homey()
  const logs = []
  const writer = new LatestWriter({ write: h.write, read: h.read, timers, log: message => logs.push(message), name: 'capability' })
  writer.set('status', 'a')
  writer.set('status', 'b')
  h.calls[0].reject(new Error('device gone'))
  await flush()
  assert.match(logs[0], /capability status failed: device gone/)
  assert.strictEqual(h.calls[1].value, 'b')
})

test('writer: dispose drops waiting writes, takes no new ones', async () => {
  const h = homey()
  const writer = new LatestWriter({ write: h.write, read: h.read, timers })
  writer.set('status', 'a')
  writer.set('status', 'b')
  writer.dispose()
  writer.set('status', 'c')
  h.calls[0].resolve()
  await flush()
  assert.deepStrictEqual(h.calls.map(call => call.value), ['a'])
})

test('bounded: the value when in time, done false after the limit, never rejects', async () => {
  assert.deepStrictEqual(await bounded(Promise.resolve(5), 1000, timers), { done: true, value: 5 })
  const error = new Error('x')
  assert.deepStrictEqual(await bounded(Promise.reject(error), 1000, timers), { done: true, error })
  const late = bounded(new Promise(() => {}), 1000, timers)
  tick(1000)
  assert.deepStrictEqual(await late, { done: false })
})

let current = null
test.beforeEach(t => { current = t })
function tick(ms) {
  current.mock.timers.tick(ms)
}

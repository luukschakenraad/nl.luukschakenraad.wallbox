'use strict'

// Run with: node --test test/
const test = require('node:test')
const assert = require('node:assert')
const { Poller } = require('../lib/poller')

// Mock tick(ms) moves the clock first, then fires the timers due: tick in exact steps
test.beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }))

const flush = () => new Promise(resolve => setImmediate(resolve))

async function tick(t, ms) {
  t.mock.timers.tick(ms)
  await flush()
}

/**
 * Poller with a fake run that records its start times (s).
 * hold = true: every run waits for release().
 */
function setup({ hold = false } = {}) {
  const runs = []
  const logs = []
  const pending = []
  const poller = new Poller({
    run: async () => {
      runs.push(Date.now() / 1000)
      if (hold)
        await new Promise(resolve => pending.push(resolve))
    },
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) },
    now: () => Date.now(),
    log: message => logs.push(message)
  })
  const release = async () => {
    pending.shift()()
    await flush()
  }
  return { poller, runs, logs, release }
}

test('start: first run after the offset, then every interval', async t => {
  const { poller, runs } = setup()
  poller.start(100000, 10000)
  await tick(t, 9999)
  assert.deepStrictEqual(runs, [])
  await tick(t, 1)
  await tick(t, 100000)
  await tick(t, 100000)
  assert.deepStrictEqual(runs, [10, 110, 210])
})

test('start without offset: first run at once', async t => {
  const { poller, runs } = setup()
  poller.start(100000)
  await tick(t, 0)
  assert.deepStrictEqual(runs, [0])
})

test('runs never overlap: a run due while one is busy starts right after it, once', async t => {
  const { poller, runs, release } = setup({ hold: true })
  poller.start(100000)
  await tick(t, 0)
  poller.soon(1000)
  await tick(t, 1000)
  await tick(t, 100000)
  assert.deepStrictEqual(runs, [0], 'still busy')
  await release()
  assert.deepStrictEqual(runs, [0, 101], 'right after, once')
  await release()
  await tick(t, 100000)
  assert.deepStrictEqual(runs, [0, 101, 201], 'interval from the last run')
})

test('soon: only moves the next run earlier, the interval restarts from that run', async t => {
  const { poller, runs } = setup()
  poller.start(100000)
  await tick(t, 0)
  await tick(t, 10000)
  poller.soon(30000) // run at 40 s instead of 100 s
  poller.soon(50000) // later: ignored
  await tick(t, 30000)
  assert.deepStrictEqual(runs, [0, 40])
  poller.soon(200000) // after the next regular run: ignored
  await tick(t, 100000)
  assert.deepStrictEqual(runs, [0, 40, 140])
  await tick(t, 10000)
  poller.soon(0)
  await tick(t, 0)
  assert.deepStrictEqual(runs, [0, 40, 140, 150])
})

test('setInterval: counted from the last run, a sooner soon() stays', async t => {
  const { poller, runs } = setup()
  poller.start(100000)
  await tick(t, 0)
  await tick(t, 10000)
  poller.setInterval(50000) // next at 50 s instead of 100 s
  await tick(t, 40000)
  assert.deepStrictEqual(runs, [0, 50])
  poller.setInterval(200000)
  await tick(t, 199999)
  assert.deepStrictEqual(runs, [0, 50])
  await tick(t, 1)
  assert.deepStrictEqual(runs, [0, 50, 250])

  poller.soon(10000) // at 260 s
  poller.setInterval(120000) // regular at 370 s: the soon() run stays
  await tick(t, 10000)
  assert.deepStrictEqual(runs, [0, 50, 250, 260])
  await tick(t, 120000)
  assert.deepStrictEqual(runs, [0, 50, 250, 260, 380])
})

test('setInterval: shorter than the time since the last run runs at once; same value changes nothing', async t => {
  const { poller, runs } = setup()
  poller.start(100000)
  await tick(t, 0)
  await tick(t, 80000)
  poller.setInterval(100000)
  poller.setInterval(60000)
  await tick(t, 0)
  assert.deepStrictEqual(runs, [0, 80])
})

test('stop: no more runs, soon() ignored; start again works', async t => {
  const { poller, runs } = setup()
  poller.start(100000)
  await tick(t, 0)
  poller.stop()
  poller.soon(0)
  await tick(t, 500000)
  assert.deepStrictEqual(runs, [0])
  poller.start(100000, 5000)
  await tick(t, 5000)
  assert.deepStrictEqual(runs, [0, 505])
})

test('stop during a run: no run after it', async t => {
  const { poller, runs, release } = setup({ hold: true })
  poller.start(100000)
  await tick(t, 0)
  poller.soon(1000)
  await tick(t, 1000)
  poller.stop()
  await release()
  await tick(t, 500000)
  assert.deepStrictEqual(runs, [0])

  const restart = setup({ hold: true })
  restart.poller.start(100000)
  await tick(t, 0)
  restart.poller.soon(0)
  await tick(t, 0) // due while busy
  restart.poller.stop()
  restart.poller.start(100000, 50000)
  await restart.release()
  assert.deepStrictEqual(restart.runs, [501], 'restarted during a run: waits for the new offset')
  await tick(t, 50000)
  assert.deepStrictEqual(restart.runs, [501, 551])
})

test('a failed run is logged and polling goes on', async t => {
  const logs = []
  const runs = []
  const poller = new Poller({
    run: async () => {
      runs.push(Date.now() / 1000)
      throw new Error('boom')
    },
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) },
    now: () => Date.now(),
    log: message => logs.push(message)
  })
  poller.start(100000)
  await tick(t, 0)
  await tick(t, 100000)
  assert.deepStrictEqual(runs, [0, 100])
  assert.deepStrictEqual(logs, ['Poll failed: boom', 'Poll failed: boom'])
})

test('poller: a run that hangs does not stop polling (watchdog)', async t => {
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) }
  let runs = 0
  const late = []
  const poller = new Poller({
    run: () => { runs++; return runs === 1 ? new Promise(() => {}) : Promise.resolve() },
    timers,
    now: () => Date.now(),
    timeout: 90 * 1000,
    onTimeout: () => late.push(Date.now())
  })
  poller.start(120 * 1000, 0)
  t.mock.timers.tick(0)
  await flushAll()
  assert.strictEqual(runs, 1)
  t.mock.timers.tick(90 * 1000)
  await flushAll()
  assert.strictEqual(late.length, 1, 'the hung run was given up')
  t.mock.timers.tick(30 * 1000)
  await flushAll()
  assert.strictEqual(runs, 2, 'the next run came on time')
  poller.stop()
})

async function flushAll() {
  for (let i = 0; i < 5; i++)
    await new Promise(resolve => setImmediate(resolve))
}

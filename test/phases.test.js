'use strict'

// Run with: node --test test/
const test = require('node:test')
const assert = require('node:assert')
const { PhaseMeter } = require('../lib/phases')
const { STATUS } = require('../lib/contract')

const { CHARGING, DISCHARGING, PAUSED, READY, LOCKED, LOCKED_CAR, SCHEDULED, OFFLINE } = STATUS

// Feed polls: [status, set amps, kW, time in s]
function feed(meter, polls) {
  for (const [status, amps, kw, s] of polls) meter.update(status, amps, kw, s * 1000)
  return meter.phases
}

test('unknown: 1 phase (as before), else the last session', () => {
  assert.strictEqual(new PhaseMeter().phases, 1)
  assert.strictEqual(new PhaseMeter(null).phases, 1)
  assert.strictEqual(new PhaseMeter(7).phases, 1)
  assert.strictEqual(new PhaseMeter(3).phases, 3)
})

test('real 3-phase session: 4.66 kW (stale), then 4.03 kW at 6 A', () => {
  const meter = new PhaseMeter()
  assert.strictEqual(feed(meter, [[CHARGING, 6, 4.6598, 0], [CHARGING, 6, 4.0255, 10]]), 1, 'stale reading and first fit do not count')
  assert.strictEqual(feed(meter, [[CHARGING, 6, 4.0255, 133]]), 3)
  assert.strictEqual(meter.last, 3)
})

test('1-phase car: 1.37 kW at 6 A', () => {
  assert.strictEqual(feed(new PhaseMeter(3), [[CHARGING, 6, 1.37, 0], [CHARGING, 6, 1.37, 123]]), 1)
})

test('2-phase car: 2.7 kW at 6 A', () => {
  assert.strictEqual(feed(new PhaseMeter(), [[CHARGING, 6, 2.7, 0], [CHARGING, 6, 2.7, 123]]), 2)
})

test('two quick polls a second apart: no reading', () => {
  // Stale power after 16 A -> 6 A on a 1-phase car would look like 2.67 phases, here stale 4.14 kW
  assert.strictEqual(feed(new PhaseMeter(), [[CHARGING, 6, 4.14, 10], [CHARGING, 6, 4.14, 11]]), 1)
})

test('set current changed between polls: no reading', () => {
  assert.strictEqual(feed(new PhaseMeter(), [[CHARGING, 16, 3.68, 0], [CHARGING, 6, 4.14, 123]]), 1)
})

test('car draws less than the set current: no reading', () => {
  // 11 kW car (16 A x 3) on a 32 A setting: ratio 1.5
  assert.strictEqual(feed(new PhaseMeter(3), [[CHARGING, 32, 11.04, 0], [CHARGING, 32, 11.04, 123]]), 3)
  assert.strictEqual(feed(new PhaseMeter(3), [[CHARGING, 32, 10.9, 0], [CHARGING, 32, 10.9, 123]]), 3)
})

test('more than 3 phases (stale power): no reading', () => {
  assert.strictEqual(feed(new PhaseMeter(), [[CHARGING, 6, 6, 0], [CHARGING, 6, 6, 123]]), 1)
})

test('tapering and a switch to 1 phase keep the session value', () => {
  const meter = new PhaseMeter()
  feed(meter, [[CHARGING, 16, 11, 0], [CHARGING, 16, 11, 123]])
  assert.strictEqual(meter.phases, 3)
  assert.strictEqual(feed(meter, [[CHARGING, 16, 3.6, 246], [CHARGING, 16, 3.6, 369], [CHARGING, 16, 1.2, 492], [CHARGING, 16, 1.2, 615]]), 3)
})

test('unplug: back to the last session until the next car is measured', () => {
  const meter = new PhaseMeter()
  feed(meter, [[CHARGING, 6, 4.03, 0], [CHARGING, 6, 4.03, 123]])
  assert.strictEqual(feed(meter, [[READY, 6, 0, 246], [SCHEDULED, 6, 0, 369]]), 3, 'last session')
  assert.strictEqual(meter.session, null)
  assert.strictEqual(feed(meter, [[CHARGING, 6, 1.37, 492], [CHARGING, 6, 1.37, 615]]), 1, '1-phase car replaces it')
  assert.strictEqual(meter.last, 1)
})

test('paused between polls: needs two new readings', () => {
  const meter = new PhaseMeter()
  assert.strictEqual(feed(meter, [[CHARGING, 6, 4.03, 0], [PAUSED, 6, 0, 123], [CHARGING, 6, 4.03, 246]]), 1)
  assert.strictEqual(feed(meter, [[CHARGING, 6, 4.03, 369]]), 3)
})

test('ignored: below 6 A, below 1 kW, other statuses', () => {
  assert.strictEqual(feed(new PhaseMeter(), [[CHARGING, 3, 2.07, 0], [CHARGING, 3, 2.07, 123]]), 1)
  assert.strictEqual(feed(new PhaseMeter(), [[CHARGING, 6, 0.5, 0], [CHARGING, 6, 0.5, 123]]), 1)
  assert.strictEqual(feed(new PhaseMeter(), [[DISCHARGING, 6, 4.03, 0], [DISCHARGING, 6, 4.03, 123]]), 1)
})

test('session ends without a car (ready, locked), not while locked with a car or offline', () => {
  for (const status of [LOCKED_CAR, OFFLINE, PAUSED]) {
    const meter = new PhaseMeter()
    feed(meter, [[CHARGING, 6, 4.03, 0], [CHARGING, 6, 4.03, 123], [status, 6, 0, 246]])
    assert.strictEqual(meter.session, 3, status)
  }
  const meter = new PhaseMeter()
  feed(meter, [[CHARGING, 6, 4.03, 0], [CHARGING, 6, 4.03, 123], [LOCKED, 6, 0, 246]])
  assert.strictEqual(meter.session, null)
  assert.strictEqual(meter.phases, 3, 'last session')
})

test('measured: this session, else 1 (the last session only counts for amps and the slider)', () => {
  const meter = new PhaseMeter(3)
  assert.strictEqual(meter.measured, 1)
  feed(meter, [[CHARGING, 6, 2.7, 0], [CHARGING, 6, 2.7, 123]])
  assert.strictEqual(meter.measured, 2)
  assert.strictEqual(meter.phases, 2)
})

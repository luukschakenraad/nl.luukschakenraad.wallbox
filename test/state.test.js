'use strict';

// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const c = require('../lib/contract');
const view = require('../lib/charger/view');

const { STATUS, GROUP, ANY, CAP, FLOW } = c;
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const SYNC = '2026-11-22 11:58:30';
const OPTIONS = { phases: 1, timezone: 'Europe/Amsterdam', now: NOW };

/**
 * View for a raw poll, optionally after a previous View
 */
function viewOf(raw, prev = null, options = {}) {
  return view.toView(view.parseSnapshot(raw, NOW), prev, Object.assign({}, OPTIONS, options));
}

function raw(fields = {}, config = {}) {
  return Object.assign({
    status_id: 194,
    charging_power: 3.68,
    added_energy: 5.5,
    added_green_energy: 1.25,
    last_sync: SYNC,
    config_data: Object.assign({ locked: 0, max_charging_current: 16, max_available_current: 32 }, config)
  }, fields);
}

// status_id -> [status, car connected, evcharger_charging_state] without a previous View
const EXPECTED = {
  0: [STATUS.OFFLINE, null, null],
  163: [STATUS.OFFLINE, null, null],
  14: [STATUS.ERROR, null, null],
  15: [STATUS.ERROR, null, null],
  161: [STATUS.READY, false, 'plugged_out'],
  162: [STATUS.READY, false, 'plugged_out'],
  164: [STATUS.SESSION_FINISHED, true, 'plugged_in'],
  165: [STATUS.LOCKED, false, 'plugged_out'],
  166: [STATUS.UPDATING, null, null],
  177: [STATUS.SCHEDULED, true, 'plugged_in'],
  179: [STATUS.SCHEDULED, true, 'plugged_in'],
  178: [STATUS.PAUSED, true, 'plugged_in_paused'],
  182: [STATUS.PAUSED, true, 'plugged_in_paused'],
  180: [STATUS.CAR_FULL, true, 'plugged_in'],
  181: [STATUS.CAR_FULL, true, 'plugged_in'],
  183: [STATUS.POWER_SHARING, true, 'plugged_in'],
  184: [STATUS.POWER_SHARING, true, 'plugged_in'],
  185: [STATUS.POWER_BOOST, true, 'plugged_in'],
  186: [STATUS.POWER_BOOST, true, 'plugged_in'],
  187: [STATUS.MID_FAILED, true, 'plugged_in'],
  188: [STATUS.MID_MARGIN, true, 'plugged_in'],
  189: [STATUS.ECO_SMART, true, 'plugged_in'],
  193: [STATUS.CHARGING, true, 'plugged_in_charging'],
  194: [STATUS.CHARGING, true, 'plugged_in_charging'],
  195: [STATUS.CHARGING, true, 'plugged_in_charging'],
  196: [STATUS.DISCHARGING, true, 'plugged_in_discharging'],
  209: [STATUS.LOCKED, false, 'plugged_out'],
  210: [STATUS.LOCKED_CAR, true, 'plugged_in_paused']
};

for (const [statusId, [status, car, chargingState]] of Object.entries(EXPECTED))
  test(`status_id ${statusId} maps to ${status} / car ${car} / ${chargingState}`, () => {
    assert.strictEqual(view.statusOf(Number(statusId)), status);
    const v = viewOf(raw({ status_id: Number(statusId) }));
    assert.strictEqual(v.status, status);
    assert.strictEqual(v.carConnected, car);
    assert.strictEqual(v.chargingState, chargingState);
    assert.strictEqual(v.charging, status === STATUS.CHARGING);
  });

test('every Wallbox id in the contract is covered here', () => {
  const ids = Object.values(c.STATUS_IDS).flat().map(String).sort();
  assert.deepStrictEqual(Object.keys(EXPECTED).sort(), ids);
});

test('statusOf: missing id is offline, unlisted id null, string id accepted', () => {
  assert.strictEqual(view.statusOf(null), STATUS.OFFLINE);
  assert.strictEqual(view.statusOf(undefined), STATUS.OFFLINE);
  assert.strictEqual(view.statusOf(999), null);
  assert.strictEqual(view.statusOf('194'), STATUS.CHARGING);
});

test('parseSnapshot: all fields', () => {
  const snapshot = view.parseSnapshot(raw({
    status_id: '194',
    charging_power: '7.4',
    added_energy: '12.345',
    added_green_energy: '2.5'
  }, {
    locked: 1,
    max_charging_current: '16',
    max_available_current: 32,
    ecosmart: { enabled: true, mode: 1 }
  }), NOW);

  assert.deepStrictEqual(snapshot, {
    at: NOW,
    statusId: 194,
    status: STATUS.CHARGING,
    locked: true,
    maxCurrent: 16,
    maxAvailable: 32,
    powerKw: 7.4,
    addedKwh: 12.345,
    addedGreenKwh: 2.5,
    ecoSmart: c.ECO_SMART.FULL_SOLAR,
    lastSync: Date.UTC(2026, 10, 22, 11, 58, 30)
  });
});

test('parseSnapshot: missing values', () => {
  for (const input of [{}, null, undefined, { config_data: null }]) {
    const snapshot = view.parseSnapshot(input, NOW);
    assert.deepStrictEqual(snapshot, {
      at: NOW,
      statusId: null,
      status: STATUS.OFFLINE,
      locked: false,
      maxCurrent: null,
      maxAvailable: null,
      powerKw: 0,
      addedKwh: null,
      addedGreenKwh: 0,
      ecoSmart: null,
      lastSync: null
    }, JSON.stringify(input));
  }
});

test('parseSnapshot: not a number gives null, unlisted status id gives status null', () => {
  const snapshot = view.parseSnapshot({ status_id: 999, added_energy: 'n/a', config_data: { max_charging_current: '' } }, NOW);
  assert.strictEqual(snapshot.statusId, 999);
  assert.strictEqual(snapshot.status, null);
  assert.strictEqual(snapshot.addedKwh, null);
  assert.strictEqual(snapshot.maxCurrent, null);
});

test('parseSnapshot: eco-smart variants', () => {
  const cases = [
    [undefined, null],
    [null, null],
    [{ enabled: true }, null],
    [{ enabled: true, mode: null }, null],
    [{ enabled: false, mode: null }, null],
    [{ enabled: false, mode: 0 }, c.ECO_SMART.OFF],
    [{ enabled: 0, mode: 1 }, c.ECO_SMART.OFF],
    [{ enabled: true, mode: 0 }, c.ECO_SMART.ECO],
    [{ enabled: 1, mode: 1 }, c.ECO_SMART.FULL_SOLAR],
    [{ mode: 0 }, c.ECO_SMART.ECO]
  ];
  for (const [ecosmart, expected] of cases)
    assert.strictEqual(view.parseSnapshot(raw({}, { ecosmart }), NOW).ecoSmart, expected, JSON.stringify(ecosmart));
});

test('parseSnapshot: last_sync is read as UTC', () => {
  assert.strictEqual(view.parseSnapshot({ last_sync: '2026-01-05 23:59:01' }, NOW).lastSync, Date.UTC(2026, 0, 5, 23, 59, 1));
  assert.strictEqual(view.parseSnapshot({ last_sync: '2026-07-01 00:00:00' }, NOW).lastSync, Date.UTC(2026, 6, 1, 0, 0, 0));
  assert.strictEqual(view.parseSnapshot({ last_sync: 'yesterday' }, NOW).lastSync, null);
  assert.strictEqual(view.parseSnapshot({ last_sync: 1700000000 }, NOW).lastSync, null);
});

test('toView: unknown id keeps the previous status, car and charging state', () => {
  const prev = viewOf(raw({ status_id: 178 }));
  const v = viewOf(raw({ status_id: 999 }), prev);
  assert.strictEqual(v.status, STATUS.PAUSED);
  assert.strictEqual(v.statusCode, 999);
  assert.strictEqual(v.carConnected, true);
  assert.strictEqual(v.chargingState, 'plugged_in_paused');
});

test('toView: unknown id without a previous View is unknown', () => {
  const v = viewOf(raw({ status_id: 999 }));
  assert.strictEqual(v.status, STATUS.UNKNOWN);
  assert.strictEqual(v.carConnected, null);
  assert.strictEqual(v.chargingState, null);
  assert.strictEqual(v.charging, false);
  assert.strictEqual(v.powerW, 0);
});

for (const [name, statusId] of [['updating', 166], ['error', 14], ['offline', 0], ['missing status_id', undefined]])
  test(`toView: ${name} keeps the previous car and charging state`, () => {
    const charging = viewOf(raw({ status_id: 194 }));
    const v = viewOf(raw({ status_id: statusId }), charging);
    assert.notStrictEqual(v.status, STATUS.CHARGING);
    assert.strictEqual(v.carConnected, true);
    assert.strictEqual(v.chargingState, 'plugged_in_charging');
    assert.strictEqual(v.charging, true, 'kept, like the charging state (changed: was false)');
    assert.strictEqual(v.powerW, 0);
    assert.strictEqual(v.currentA, 0);

    const ready = viewOf(raw({ status_id: 161 }));
    const afterReady = viewOf(raw({ status_id: statusId }), ready);
    assert.strictEqual(afterReady.carConnected, false);
    assert.strictEqual(afterReady.chargingState, 'plugged_out');
  });

test('toView: current from power on 1 and 3 phases', () => {
  const one = viewOf(raw({ status_id: 194, charging_power: 3.68 }), null, { phases: 1 });
  assert.strictEqual(one.powerW, 3680);
  assert.strictEqual(one.currentA, 16);

  const three = viewOf(raw({ status_id: 194, charging_power: 11.04 }), null, { phases: 3 });
  assert.strictEqual(three.powerW, 11040);
  assert.strictEqual(three.currentA, 16);

  const odd = viewOf(raw({ status_id: 194, charging_power: 7.3456 }), null, { phases: 3 });
  assert.strictEqual(odd.powerW, 7346);
  assert.strictEqual(odd.currentA, 10.6);

  const discharging = viewOf(raw({ status_id: 196, charging_power: 2.3 }), null, { phases: 1 });
  assert.strictEqual(discharging.powerW, 2300);
  assert.strictEqual(discharging.currentA, 10);
  assert.strictEqual(discharging.charging, false);
});

test('toView: missing or bad phases count as 1', () => {
  for (const phases of [undefined, null, 0])
    assert.strictEqual(viewOf(raw({ charging_power: 2.3 }), null, { phases }).currentA, 10, String(phases));
});

test('toView: power and current 0 when not flowing (stale charging_power)', () => {
  for (const statusId of [178, 181, 189, 161, 164, 210]) {
    const v = viewOf(raw({ status_id: statusId, charging_power: 7.4 }), null, { phases: 3 });
    assert.strictEqual(v.powerW, 0, String(statusId));
    assert.strictEqual(v.currentA, 0, String(statusId));
  }
});

test('toView: sessionKwh follows added_energy while a car is connected, kept without', () => {
  const charging = viewOf(raw({ status_id: 194, added_energy: 8.2 }));
  assert.strictEqual(charging.sessionKwh, 8.2);

  const ready = viewOf(raw({ status_id: 161, added_energy: 0 }), charging);
  assert.strictEqual(ready.sessionKwh, 8.2);
  assert.strictEqual(ready.addedKwh, 0);

  // unknown car after Ready: still no car, still kept
  const offline = viewOf(raw({ status_id: 0, added_energy: 0 }), ready);
  assert.strictEqual(offline.carConnected, false);
  assert.strictEqual(offline.sessionKwh, 8.2);

  const nextCar = viewOf(raw({ status_id: 182, added_energy: 0.1 }), ready);
  assert.strictEqual(nextCar.sessionKwh, 0.1);

  assert.strictEqual(viewOf(raw({ status_id: 161 })).sessionKwh, null);
});

test('toView: copies the other fields', () => {
  const v = viewOf(raw({ status_id: 178, added_green_energy: 0.75 }, { locked: 1, ecosmart: { enabled: true, mode: 0 } }));
  assert.strictEqual(v.statusCode, 178);
  assert.strictEqual(v.locked, true);
  assert.strictEqual(v.maxCurrent, 16);
  assert.strictEqual(v.maxAvailable, 32);
  assert.strictEqual(v.ecoSmart, c.ECO_SMART.ECO);
  assert.strictEqual(v.addedKwh, 5.5);
  assert.strictEqual(v.addedGreenKwh, 0.75);
  assert.strictEqual(v.lastSync, Date.UTC(2026, 10, 22, 11, 58, 30));
});

test('toView: no stale flag, an old last_sync is normal for an idle charger', () => {
  const v = viewOf(raw({ last_sync: '2026-11-20 11:50:00' }));
  assert.ok(!('staleSync' in v));
  assert.strictEqual(v.lastSync, Date.UTC(2026, 10, 20, 11, 50, 0));
});

test('toView: lastUpdated in the time zone', () => {
  // 11:58:30 UTC is 12:58 in Amsterdam (CET, winter)
  assert.strictEqual(viewOf(raw(), null, { timezone: 'Europe/Amsterdam' }).lastUpdated, '2026-11-22 12:58');
  // summer time, and the date moves
  assert.strictEqual(viewOf(raw({ last_sync: '2026-07-01 22:30:00' }), null, { timezone: 'Europe/Amsterdam' }).lastUpdated, '2026-07-02 00:30');
  assert.strictEqual(viewOf(raw({ last_sync: '2026-07-01 03:05:00' }), null, { timezone: 'America/New_York' }).lastUpdated, '2026-06-30 23:05');
  assert.strictEqual(viewOf(raw(), null, { timezone: 'UTC' }).lastUpdated, '2026-11-22 11:58');
});

test('toView: lastUpdated falls back to UTC with a bad time zone', () => {
  assert.strictEqual(viewOf(raw(), null, { timezone: 'Not/AZone' }).lastUpdated, '2026-11-22 11:58');
  assert.strictEqual(viewOf(raw({ last_sync: null })).lastUpdated, null);
});

test('capabilityValues: every View-driven capability', () => {
  const v = viewOf(raw({ status_id: 194, charging_power: 3.68, added_energy: 4.2 }, { ecosmart: { enabled: false, mode: 0 } }));
  assert.deepStrictEqual(view.capabilityValues(v), {
    [CAP.STATUS]: STATUS.CHARGING,
    [CAP.STATUS_CODE]: 194,
    [CAP.CAR_CONNECTED]: true,
    [CAP.CHARGING_STATE]: 'plugged_in_charging',
    [CAP.CHARGING]: true,
    [CAP.LOCKED]: false,
    [CAP.POWER]: 3680,
    [CAP.CURRENT]: 16,
    [CAP.MAX_CURRENT]: 16,
    [CAP.ECO_SMART]: c.ECO_SMART.OFF,
    [CAP.LAST_UPDATED]: '2026-11-22 12:58',
    [CAP.SESSION_ENERGY]: 4.2
  });
});

test('capabilityValues: unknowns are null (don\'t set)', () => {
  const values = view.capabilityValues(viewOf({ status_id: 166 }));
  assert.strictEqual(values[CAP.STATUS], STATUS.UPDATING);
  assert.strictEqual(values[CAP.CAR_CONNECTED], null);
  assert.strictEqual(values[CAP.CHARGING_STATE], null);
  assert.strictEqual(values[CAP.MAX_CURRENT], null);
  assert.strictEqual(values[CAP.ECO_SMART], null);
  assert.strictEqual(values[CAP.LAST_UPDATED], null);
  assert.strictEqual(values[CAP.SESSION_ENERGY], null);
  assert.strictEqual(values[CAP.POWER], 0);
  assert.strictEqual(values[CAP.CHARGING], false);
});

test('transitions: none without a previous View', () => {
  assert.deepStrictEqual(view.transitions(null, viewOf(raw())), []);
});

test('transitions: none when nothing changed', () => {
  const prev = viewOf(raw());
  assert.deepStrictEqual(view.transitions(prev, viewOf(raw(), prev)), []);
});

test('transitions: car connected', () => {
  const ready = viewOf(raw({ status_id: 161 }));
  const paused = viewOf(raw({ status_id: 178 }), ready);
  assert.deepStrictEqual(view.transitions(ready, paused), [
    {
      trigger: FLOW.TRIGGER.STATUS_CHANGED,
      tokens: { old_status: STATUS.READY, new_status: STATUS.PAUSED },
      state: { old: STATUS.READY, new: STATUS.PAUSED }
    },
    { trigger: FLOW.TRIGGER.CAR_CONNECTED, tokens: {}, state: {} }
  ]);
});

test('transitions: car disconnected ends the session with energy from prev', () => {
  const charging = viewOf(raw({ status_id: 194, added_energy: 10.12345, added_green_energy: 3.5 }));
  const ready = viewOf(raw({ status_id: 161, added_energy: 0, added_green_energy: 0 }), charging);
  assert.deepStrictEqual(view.transitions(charging, ready), [
    {
      trigger: FLOW.TRIGGER.STATUS_CHANGED,
      tokens: { old_status: STATUS.CHARGING, new_status: STATUS.READY },
      state: { old: STATUS.CHARGING, new: STATUS.READY }
    },
    { trigger: FLOW.TRIGGER.CAR_DISCONNECTED, tokens: {}, state: {} },
    { trigger: FLOW.TRIGGER.SESSION_ENDED, tokens: { kwh: 10.123, green_kwh: 3.5 }, state: {} }
  ]);
});

test('transitions: session_ended tokens are numbers when energy is unknown', () => {
  const paused = viewOf({ status_id: 178 });
  const ready = viewOf({ status_id: 161 }, paused);
  const ended = view.transitions(paused, ready).find(event => event.trigger === FLOW.TRIGGER.SESSION_ENDED);
  assert.deepStrictEqual(ended.tokens, { kwh: 0, green_kwh: 0 });
});

test('transitions: no car events on unknown car (null)', () => {
  const charging = viewOf(raw({ status_id: 194 }));
  const offline = viewOf(raw({ status_id: 0 }), charging);
  const ready = viewOf(raw({ status_id: 161 }), offline);
  assert.deepStrictEqual(view.transitions(charging, offline).map(event => event.trigger), [FLOW.TRIGGER.STATUS_CHANGED]);
  // car kept true over the offline poll, so the disconnect still shows after it
  assert.deepStrictEqual(view.transitions(offline, ready).map(event => event.trigger),
    [FLOW.TRIGGER.STATUS_CHANGED, FLOW.TRIGGER.CAR_DISCONNECTED, FLOW.TRIGGER.SESSION_ENDED]);

  const unknownCar = viewOf(raw({ status_id: 14 }));
  const plugged = viewOf(raw({ status_id: 178 }), unknownCar);
  assert.deepStrictEqual(view.transitions(unknownCar, plugged).map(event => event.trigger), [FLOW.TRIGGER.STATUS_CHANGED]);
});

test('matches: statuses, groups and any', () => {
  assert.strictEqual(view.matches(STATUS.CHARGING, STATUS.CHARGING), true);
  assert.strictEqual(view.matches(STATUS.CHARGING, STATUS.DISCHARGING), false);
  assert.strictEqual(view.matches(GROUP.CHARGING, STATUS.DISCHARGING), true);
  assert.strictEqual(view.matches(GROUP.CHARGING, STATUS.PAUSED), false);
  assert.strictEqual(view.matches(GROUP.WAITING, STATUS.ECO_SMART), true);
  assert.strictEqual(view.matches(GROUP.WAITING, STATUS.PAUSED), false);
  assert.strictEqual(view.matches(GROUP.LOCKED, STATUS.LOCKED_CAR), true);
  assert.strictEqual(view.matches(GROUP.CAR_CONNECTED, STATUS.LOCKED_CAR), true);
  assert.strictEqual(view.matches(GROUP.CAR_CONNECTED, STATUS.OFFLINE), false);
  assert.strictEqual(view.matches(GROUP.NO_CAR, STATUS.READY), true);
  assert.strictEqual(view.matches(GROUP.NO_CAR, STATUS.UPDATING), false);
  assert.strictEqual(view.matches(ANY, STATUS.UNKNOWN), true);
  assert.strictEqual(view.matches('constructor', STATUS.CHARGING), false);
});

test('statusTriggerMatches: entering a group fires, moving inside it does not', () => {
  const change = (from, to) => ({ old: from, new: to });
  assert.strictEqual(view.statusTriggerMatches(GROUP.CHARGING, change(STATUS.PAUSED, STATUS.CHARGING)), true);
  assert.strictEqual(view.statusTriggerMatches(GROUP.CHARGING, change(STATUS.CHARGING, STATUS.DISCHARGING)), false);
  assert.strictEqual(view.statusTriggerMatches(GROUP.CHARGING, change(STATUS.CHARGING, STATUS.PAUSED)), false);
  assert.strictEqual(view.statusTriggerMatches(GROUP.WAITING, change(STATUS.SCHEDULED, STATUS.ECO_SMART)), false);
  assert.strictEqual(view.statusTriggerMatches(GROUP.CAR_CONNECTED, change(STATUS.READY, STATUS.PAUSED)), true);
  assert.strictEqual(view.statusTriggerMatches(GROUP.NO_CAR, change(STATUS.READY, STATUS.LOCKED)), false);
  assert.strictEqual(view.statusTriggerMatches(STATUS.PAUSED, change(STATUS.CHARGING, STATUS.PAUSED)), true);
  assert.strictEqual(view.statusTriggerMatches(STATUS.PAUSED, change(STATUS.PAUSED, STATUS.CHARGING)), false);
  assert.strictEqual(view.statusTriggerMatches(ANY, change(STATUS.CHARGING, STATUS.DISCHARGING)), true);
  assert.strictEqual(view.statusTriggerMatches(ANY, change(STATUS.READY, STATUS.LOCKED)), true);
});

test('statusTriggerMatches works on transitions() state', () => {
  const paused = viewOf(raw({ status_id: 178 }));
  const charging = viewOf(raw({ status_id: 194 }), paused);
  const [event] = view.transitions(paused, charging);
  assert.strictEqual(view.statusTriggerMatches(GROUP.CHARGING, event.state), true);
  assert.strictEqual(view.statusTriggerMatches(GROUP.CAR_CONNECTED, event.state), false);
});

test('transitions: Eco-Smart and set current changes fire, also when changed elsewhere', () => {
  const before = viewOf(raw({}, { max_charging_current: 16, ecosmart: { enabled: false, mode: 0 } }));
  const after = viewOf(raw({}, { max_charging_current: 10, ecosmart: { enabled: true, mode: 1 } }), before);
  assert.deepStrictEqual(view.transitions(before, after), [
    { trigger: FLOW.TRIGGER.ECO_SMART_CHANGED, tokens: { mode: 'full_solar' }, state: {} },
    { trigger: FLOW.TRIGGER.MAX_CURRENT_CHANGED, tokens: { amps: 10 }, state: {} }
  ]);
});

test('transitions: no Eco-Smart or current trigger from or to an unknown value', () => {
  const none = viewOf(raw({}, { max_charging_current: null }));
  const known = viewOf(raw({}, { max_charging_current: 16, ecosmart: { enabled: true, mode: 0 } }), none);
  assert.deepStrictEqual(view.transitions(none, known), []);
});

test('toView: a missing status_id gives status code 0 (Wallbox offline), not the old number', () => {
  const charging = viewOf(raw({ status_id: 194 }));
  assert.strictEqual(viewOf(raw({ status_id: null }), charging).statusCode, 0);
});

test('toView: the poll time is on the View', () => {
  assert.strictEqual(view.toView(view.parseSnapshot(raw(), 1234), null, { phases: 1, timezone: 'UTC', now: 1234 }).at, 1234);
});

test('210 (locked, car connected): the old session energy is not shown again, unplugging fires no session_ended', () => {
  const charging = viewOf(raw({ status_id: 194, added_energy: 12 }));
  const ready = viewOf(raw({ status_id: 161, added_energy: 12 }), charging);
  const locked = viewOf(raw({ status_id: 210, added_energy: 12 }), ready);
  assert.strictEqual(locked.sessionKwh, 12, 'kept from the last session');
  assert.strictEqual(locked.sessionOpen, false);
  const gone = viewOf(raw({ status_id: 209, added_energy: 12 }), locked);
  const triggers = view.transitions(locked, gone).map(event => event.trigger);
  assert.ok(triggers.includes(FLOW.TRIGGER.CAR_DISCONNECTED));
  assert.ok(!triggers.includes(FLOW.TRIGGER.SESSION_ENDED));
});

test('a new session at 210 after unlocking: energy counts from the open session', () => {
  const locked = viewOf(raw({ status_id: 210, added_energy: 12 }));
  const charging = viewOf(raw({ status_id: 194, added_energy: 0.5 }), locked);
  assert.strictEqual(charging.sessionKwh, 0.5);
  assert.strictEqual(charging.sessionOpen, true);
});

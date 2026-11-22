'use strict';

const test = require('node:test');
const assert = require('node:assert');
const c = require('../lib/contract');

const statuses = Object.values(c.STATUS);
const flowing = [c.STATUS.CHARGING, c.STATUS.DISCHARGING];

test('contract: every status in every per-status table', () => {
  for (const table of ['CAR_CONNECTED', 'CHARGING_STATE_BY_STATUS', 'SESSION_STATE', 'START_REASON'])
    for (const status of statuses.filter(s => table !== 'START_REASON' || !flowing.includes(s)))
      assert.ok(status in c[table], `${status} missing in ${table}`);
  for (const status of flowing)
    assert.ok(!(status in c.START_REASON), 'power flowing means a Start was followed');
});

test('contract: status ids unique, every listed status known', () => {
  const seen = new Map();
  for (const [status, ids] of Object.entries(c.STATUS_IDS)) {
    assert.ok(statuses.includes(status), status);
    for (const id of ids) {
      assert.ok(!seen.has(id), `${id} in ${seen.get(id)} and ${status}`);
      seen.set(id, status);
    }
  }
  assert.strictEqual(seen.get(210), c.STATUS.LOCKED_CAR);
});

test('contract: groups hold known statuses, prefixed ids', () => {
  for (const [group, members] of Object.entries(c.GROUP_MEMBERS)) {
    assert.ok(group.startsWith('group_'), group);
    assert.ok(members.length > 0, group);
    for (const status of members)
      assert.ok(statuses.includes(status), `${group}: ${status}`);
  }
  assert.ok(c.GROUP_MEMBERS[c.GROUP.CAR_CONNECTED].includes(c.STATUS.LOCKED_CAR));
  assert.deepStrictEqual(c.GROUP_MEMBERS[c.GROUP.NO_CAR].sort(), [c.STATUS.LOCKED, c.STATUS.READY]);
});

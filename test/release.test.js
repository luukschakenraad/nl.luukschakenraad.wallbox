'use strict';

// What released devices, flows and Insights depend on, as shipped in 1.0.0.
// Homey stores these ids: a rename or removal breaks the user's flows or devices.
// Adding is fine. Removing or renaming needs a migration first: change this list
// only together with one (see AGENTS.md, Releases and migrations).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));

const RELEASED = {
  app: 'nl.luukschakenraad.wallbox',
  driver: 'wallbox',
  capabilities: ['locked', 'evcharger_charging_state', 'evcharger_charging', 'measure_power', 'measure_current', 'max_charging_current', 'meter_power.charged', 'meter_power.total', 'target_power', 'target_power_mode', 'status', 'status_code', 'car_connected', 'eco_smart', 'last_updated', 'alarm_connectivity'],
  runtimeCapabilities: ['meter_power.green'],
  custom: {
    car_connected: 'boolean',
    eco_smart: ['off', 'eco', 'full_solar'],
    last_updated: 'string',
    max_charging_current: 'number',
    status: ['charging', 'discharging', 'paused', 'scheduled', 'car_full', 'power_sharing', 'power_boost', 'eco_smart', 'mid_failed', 'mid_margin', 'session_finished', 'ready', 'locked', 'locked_car', 'updating', 'error', 'offline', 'unknown'],
    status_code: 'number'
  },
  settings: ['polling', 'firmware', 'model'],
  triggers: [
    { id: 'charger_status_changed', args: [{ name: 'status', values: ['any', 'group_charging', 'group_paused', 'group_waiting', 'group_locked', 'group_car_connected', 'group_no_car', 'charging', 'discharging', 'paused', 'scheduled', 'car_full', 'power_sharing', 'power_boost', 'eco_smart', 'mid_failed', 'mid_margin', 'session_finished', 'ready', 'locked', 'locked_car', 'updating', 'error', 'offline', 'unknown'] }], tokens: ['old_status:string', 'new_status:string', 'old_status_id:string', 'new_status_id:string'] },
    { id: 'car_connected' },
    { id: 'car_disconnected' },
    { id: 'session_ended', tokens: ['kwh:number', 'green_kwh:number'] },
    { id: 'not_followed', tokens: ['command:string', 'reason:string', 'command_id:string', 'reason_id:string'] },
    { id: 'eco_smart_mode_changed', tokens: ['mode:string', 'mode_id:string'] },
    { id: 'max_current_changed', tokens: ['amps:number'] }
  ],
  conditions: [
    { id: 'status_is', args: [{ name: 'status', values: ['group_charging', 'group_paused', 'group_waiting', 'group_locked', 'group_car_connected', 'group_no_car', 'charging', 'discharging', 'paused', 'scheduled', 'car_full', 'power_sharing', 'power_boost', 'eco_smart', 'mid_failed', 'mid_margin', 'session_finished', 'ready', 'locked', 'locked_car', 'updating', 'error', 'offline', 'unknown'] }] },
    { id: 'car_is_connected' },
    { id: 'eco_smart_is', args: [{ name: 'mode', values: ['off', 'eco', 'full_solar'] }] },
    { id: 'paused_by_homey' }
  ],
  actions: [
    { id: 'change_ampere', args: ['ampere'], tokens: ['result:string', 'amps:number', 'seconds:number'] },
    { id: 'set_eco_smart', args: [{ name: 'mode', values: ['off', 'eco', 'full_solar'] }] }
  ],
  store: { 'drivers/wallbox/device.js': ['username', 'password'], 'lib/charger/controller.js': ['phases', 'targetPaused'], 'lib/energy.js': ['energy_meter', 'energy_history'] },
  appSettings: { 'app.js': ['tokens:'] }
};

const driver = app.drivers.find(item => item.id === RELEASED.driver);
const cardOf = (type, id) => (app.flow[type] || []).find(card => card.id === id);

test('released: app and driver id', () => {
  assert.strictEqual(app.id, RELEASED.app);
  assert.ok(driver, `driver ${RELEASED.driver}`);
});

test('released: every capability is still on the driver, or still added at runtime', () => {
  for (const id of RELEASED.capabilities)
    assert.ok(driver.capabilities.includes(id), id);
  for (const id of RELEASED.runtimeCapabilities)
    assert.ok(driver.capabilitiesOptions && driver.capabilitiesOptions[id], `${id}: options kept for the runtime add`);
});

test('released: custom capabilities keep their type and every value id', () => {
  for (const [id, released] of Object.entries(RELEASED.custom)) {
    const capability = app.capabilities[id];
    assert.ok(capability, id);
    if (Array.isArray(released)) {
      const values = (capability.values || []).map(value => value.id);
      for (const value of released)
        assert.ok(values.includes(value), `${id}: value ${value}`);
    } else
      assert.strictEqual(capability.type, released, `${id}: type`);
  }
});

test('released: setting ids', () => {
  const ids = (driver.settings || []).flatMap(setting => (setting.children ? setting.children.map(child => child.id) : [setting.id]));
  for (const id of RELEASED.settings)
    assert.ok(ids.includes(id), id);
});

test('released: flow cards keep their id, arguments, dropdown values and tokens', () => {
  for (const type of ['triggers', 'conditions', 'actions'])
    for (const released of RELEASED[type]) {
      const card = cardOf(type, released.id);
      assert.ok(card, `${type} ${released.id}`);
      for (const arg of released.args || []) {
        const name = typeof arg === 'string' ? arg : arg.name;
        const found = (card.args || []).find(item => item.name === name);
        assert.ok(found, `${released.id}: argument ${name}`);
        for (const value of arg.values || [])
          assert.ok((found.values || []).some(item => item.id === value), `${released.id}.${name}: value ${value}`);
      }
      for (const token of released.tokens || []) {
        const [name, kind] = token.split(':');
        assert.ok((card.tokens || []).some(item => item.name === name && item.type === kind), `${released.id}: token ${token}`);
      }
    }

});

test('released: store keys and app setting keys are still used', () => {
  for (const group of [RELEASED.store, RELEASED.appSettings])
    for (const [file, keys] of Object.entries(group)) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const key of keys)
        assert.ok(source.includes(`'${key}`) || source.includes(`\`${key}`), `${file}: ${key}`);
    }
});

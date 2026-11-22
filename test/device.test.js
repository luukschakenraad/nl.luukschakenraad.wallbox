'use strict';

// Homey adapter (app.js, driver.js, device.js) on a fake SDK and fake lib modules
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const { CAP, ERR, MSG, MODE, FLOW, STATUS, GROUP, GROUP_MEMBERS } = require('../lib/contract');

// Behaviour of the fake lib modules, reset before every test
const impl = {};
// Instances the code under test created
const made = {};

test.beforeEach(() => {
  Object.assign(made, { accounts: [], registries: [], apis: [], controllers: [], pollers: [], meters: [] });
  Object.assign(impl, {
    getStatus: async () => ({ status_id: 194 }),
    listChargers: async () => [{ id: 'c1', name: 'Garage' }],
    toView: () => ({ status: STATUS.CHARGING }),
    capabilityValues: view => ({ [CAP.STATUS]: view.status }),
    transitions: () => [],
    onPoll: async () => {},
    energyUpdate: async () => null,
    targetOptions: () => ({ min: 0, max: 7360, step: 230, excludeMin: 0, excludeMax: 1380 }),
    setCurrent: async amps => ({ result: 'sent', amps, seconds: 0 })
  });
});

// Fake SDK: in-memory device state in `sdk`, every change logged in sdk.events
class SdkDevice {

  getData() { return { id: this.sdk.id }; }
  getStoreValue(key) { return key in this.sdk.store ? this.sdk.store[key] : null; }
  async setStoreValue(key, value) { this.sdk.store[key] = value; }
  getSetting(key) { return key in this.sdk.settings ? this.sdk.settings[key] : null; }
  hasCapability(id) { return this.sdk.caps.has(id); }
  getCapabilityValue(id) { return this.sdk.caps.has(id) ? this.sdk.caps.get(id) : null; }
  async setCapabilityValue(id, value) {
    if (!this.sdk.caps.has(id))
      throw new Error(`no capability ${id}`);
    this.sdk.caps.set(id, value);
    this.sdk.events.push(`set ${id}=${value}`);
  }

  async addCapability(id) {
    this.sdk.caps.set(id, null);
    this.sdk.events.push(`add ${id}`);
  }

  async removeCapability(id) {
    this.sdk.caps.delete(id);
    this.sdk.events.push(`remove ${id}`);
  }

  async setCapabilityOptions(id, options) {
    this.sdk.options[id] = options;
    this.sdk.events.push(`options ${id}`);
  }

  async setWarning(message) {
    this.sdk.warning = message;
    this.sdk.events.push('warning');
  }

  async unsetWarning() {
    this.sdk.warning = null;
    this.sdk.events.push('unwarning');
  }

  getAvailable() { return this.sdk.available; }
  async setAvailable() {
    this.sdk.available = true;
    this.sdk.events.push('available');
  }

  async setUnavailable(message) {
    this.sdk.available = false;
    this.sdk.unavailable = message;
    this.sdk.events.push('unavailable');
  }

  registerCapabilityListener(id, listener) { this.sdk.listeners.push({ ids: [id], listener }); }
  registerMultipleCapabilityListener(ids, listener, timeout) { this.sdk.listeners.push({ ids, listener, timeout }); }
  log(...args) { this.sdk.logs.push(args.join(' ')); }

}

class SdkDriver {

  getDevices() { return this.devices || []; }
  log(...args) { this.logs.push(args.join(' ')); }

}

class SdkApp {

  log(...args) { this.logs.push(args.join(' ')); }

}

// Fake lib modules
const fakeLib = {
  '/lib/wallbox/account': {
    Account: class {

      constructor(options) {
        this.options = options;
        made.accounts.push(this);
      }

    },
    AccountRegistry: class {

      constructor(options) {
        this.options = options;
        made.registries.push(this);
      }

      key(username) { return String(username).trim().toLowerCase(); }

    }
  },
  '/lib/wallbox/api': {
    WallboxApi: class {

      constructor(account) {
        this.account = account;
        made.apis.push(this);
      }

      getStatus(id) { return impl.getStatus(id); }
      listChargers() { return impl.listChargers(this.account); }

    }
  },
  '/lib/charger/view': {
    parseSnapshot: (raw, now) => ({ ...raw, raw, at: now, ecoSmart: raw.ecoSmart === undefined ? null : raw.ecoSmart }),
    toView: (...args) => impl.toView(...args),
    capabilityValues: view => impl.capabilityValues(view),
    transitions: (prev, next) => impl.transitions(prev, next),
    matches: (selection, status) => selection === status || (GROUP_MEMBERS[selection] || []).includes(status),
    statusTriggerMatches: (selection, state) => selection === state.new
  },
  '/lib/charger/controller': {
    ChargerController: class {

      constructor(options) {
        this.options = options;
        this.measuredPhases = 1;
        this.phases = 1;
        this.phasesFor = (status, amps, kw) => require('../lib/phases').reading(status, amps, kw) || this.phases;
        this.calls = [];
        made.controllers.push(this);
      }

      async command(batch) { this.calls.push(['command', batch]); }
      async setLocked(locked) { this.calls.push(['setLocked', locked]); }
      async setEcoSmart(mode) { this.calls.push(['setEcoSmart', mode]); }
      setCurrent(amps) { return impl.setCurrent(amps); }
      onPoll(view) { return impl.onPoll(view); }
      targetOptions() { return impl.targetOptions(); }
      dispose() { this.calls.push(['dispose']); }

    }
  },
  '/lib/poller': {
    Poller: class {

      constructor(options) {
        this.options = options;
        this.calls = [];
        made.pollers.push(this);
      }

      start(interval, offset) { this.calls.push(['start', interval, offset]); }
      soon(ms) { this.calls.push(['soon', ms]); }
      setInterval(ms) { this.calls.push(['setInterval', ms]); }
      stop() { this.calls.push(['stop']); }

    }
  },
  '/lib/energy': {
    EnergyMeter: class {

      constructor(options) {
        this.options = options;
        made.meters.push(this);
      }

      update(snapshot) { return impl.energyUpdate(snapshot); }
      dispose() { this.disposed = (this.disposed || 0) + 1; }

    },
    sumSessions: () => ({ energy: 0, green: 0, count: 0, latest: null }),
    showGreen: (green, ecoSmart) => green > 0 || ecoSmart != null
  }
};

const load = Module._load;
Module._load = function(request, ...args) {
  if (request === 'homey')
    return { App: SdkApp, Driver: SdkDriver, Device: SdkDevice };
  const stub = Object.keys(fakeLib).find(path => request.endsWith(path));
  if (stub)
    return fakeLib[stub];
  return load.call(this, request, ...args);
};
const App = require('../app');
const Driver = require('../drivers/wallbox/driver');
const Device = require('../drivers/wallbox/device');
Module._load = load;

const MANIFEST_CAPS = [CAP.LOCKED, CAP.CHARGING_STATE, CAP.CHARGING, CAP.SESSION_ENERGY, CAP.TOTAL_ENERGY, CAP.POWER,
  CAP.CURRENT, CAP.TARGET_POWER, CAP.TARGET_MODE, CAP.STATUS, CAP.ALARM];
const STATUS_VALUES = [
  { id: STATUS.CHARGING, title: { en: 'Charging', nl: 'Laden' } },
  { id: STATUS.PAUSED, title: { en: 'Paused', nl: 'Gepauzeerd' } }
];
const EMAIL = 'Me@Example.com';
const PASSWORD = 'secret-pw';

// Flow manager: cards by id, with their run listener and triggers
function makeFlow() {
  const cards = {};
  const card = id => {
    cards[id] = cards[id] || {
      triggers: [],
      registerRunListener(listener) {
        this.run = listener;
        return this;
      },
      async trigger(device, tokens, state) {
        this.triggers.push({ tokens, state });
        device.sdk.events.push(`trigger ${id}`);
      }
    };
    return cards[id];
  };
  return { cards, getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card };
}

function makeAccount({ count = 1, slot = 0 } = {}) {
  return {
    chargerCount: count,
    rejected: false,
    calls: [],
    slot: () => slot,
    register(id) { this.calls.push(['register', id]); },
    unregister(id) { this.calls.push(['unregister', id]); },
    verifyError: null,
    setCredentials(username, password) { this.calls.push(['setCredentials', username, password]); },
    async verifyCredentials(username, password) {
      this.calls.push(['verifyCredentials', username, password]);
      if (this.verifyError)
        throw this.verifyError;
    }
  };
}

function makeHomey(account) {
  const settings = {};
  return {
    app: {
      registry: {
        gets: [],
        get(username, password) {
          this.gets.push([username, password]);
          return account;
        },
        key: username => String(username).trim().toLowerCase()
      }
    },
    __: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    clock: { getTimezone: () => 'Europe/Amsterdam' },
    i18n: { getLanguage: () => 'nl' },
    setTimeout: () => 1,
    clearTimeout: () => {},
    settings: {
      values: settings,
      get: key => (key in settings ? settings[key] : null),
      set: (key, value) => { settings[key] = value; },
      unset: key => { delete settings[key]; }
    },
    manifest: { id: 'nl.luukschakenraad.wallbox', version: '1.0.0', capabilities: { [CAP.STATUS]: { values: STATUS_VALUES } } },
    flow: makeFlow()
  };
}

/**
 * Device on the fake SDK, after onInit
 */
async function makeDevice({ caps, store, settings = { polling: 120 }, account = makeAccount(), available = true, init = true } = {}) {
  const homey = makeHomey(account);
  const device = new Device();
  device.homey = homey;
  device.sdk = {
    id: 'c1',
    caps: new Map(Object.entries(caps || Object.fromEntries(MANIFEST_CAPS.map(id => [id, null])))),
    store: store || { username: EMAIL, password: PASSWORD },
    settings,
    available,
    events: [],
    logs: [],
    listeners: [],
    options: {}
  };
  device.driver = {
    manifest: {
      capabilities: MANIFEST_CAPS,
      capabilitiesOptions: { [CAP.GREEN_ENERGY]: { title: { en: 'Green energy charged total' } } }
    },
    getDevices: () => [device]
  };
  if (init)
    await device.onInit();
  device.sdk.events.length = 0;
  return { device, homey, account, controller: made.controllers[0], poller: made.pollers[0] };
}

function multipleListener(device) {
  return device.sdk.listeners.find(entry => entry.ids.length > 1);
}

test('init: target_power_mode null becomes device, a set mode is kept', async () => {
  let { device } = await makeDevice();
  assert.strictEqual(device.getCapabilityValue(CAP.TARGET_MODE), MODE.DEVICE);

  const caps = Object.fromEntries(MANIFEST_CAPS.map(id => [id, null]));
  caps[CAP.TARGET_MODE] = MODE.HOMEY;
  ({ device } = await makeDevice({ caps }));
  assert.strictEqual(device.getCapabilityValue(CAP.TARGET_MODE), MODE.HOMEY);
});

test('init: onoff removed, missing manifest capabilities added', async () => {
  const caps = Object.fromEntries(MANIFEST_CAPS.filter(id => id !== CAP.ALARM).map(id => [id, null]));
  caps.onoff = true;
  const { device } = await makeDevice({ caps });
  assert.ok(!device.hasCapability('onoff'));
  assert.ok(device.hasCapability(CAP.ALARM));
  assert.ok(!device.hasCapability(CAP.GREEN_ENERGY), 'green only when there is green energy');
});

test('init: account from the store, charger registered, controller wired', async () => {
  const { device, homey, account, controller, poller } = await makeDevice();
  assert.deepStrictEqual(homey.app.registry.gets, [[EMAIL, PASSWORD]]);
  assert.deepStrictEqual(account.calls, [['register', 'c1']]);
  assert.strictEqual(made.apis[0].account, account);
  assert.strictEqual(controller.options.chargerId, 'c1');
  assert.strictEqual(controller.options.api, made.apis[0]);

  device.sdk.caps.set(CAP.STATUS, STATUS.PAUSED);
  assert.strictEqual(controller.options.caps.get(CAP.STATUS), STATUS.PAUSED);
  controller.options.requestPoll(30000);
  assert.deepStrictEqual(poller.calls.slice(-1), [['soon', 30000]]);
  assert.strictEqual(controller.options.t(MSG.BUSY, { minutes: 2 }), 'errors.busy {"minutes":2}');
});

test('init: listeners registered once, also after a restart', async () => {
  const { device } = await makeDevice();
  await device.restart();
  assert.deepStrictEqual(device.sdk.listeners.map(entry => [entry.ids, entry.timeout]), [
    [[CAP.LOCKED], undefined],
    [[CAP.TARGET_POWER, CAP.TARGET_MODE, CAP.CHARGING], 500]
  ]);
});

test('listeners: batch and lock go to the controller', async () => {
  const { device, controller } = await makeDevice();
  const batch = { target_power: 3680, evcharger_charging: true };
  await multipleListener(device).listener(batch, {});
  await device.sdk.listeners[0].listener(true, {});
  assert.deepStrictEqual(controller.calls, [['command', batch], ['setLocked', true]]);
});

test('poll: capability values, then triggers, then onPoll, then energy', async () => {
  const { device, homey, controller } = await makeDevice();
  const prev = { status: STATUS.PAUSED };
  const next = { status: STATUS.CHARGING };
  device.view = prev;
  let viewArgs;
  impl.getStatus = async id => ({ status_id: 194, id });
  impl.toView = (...args) => {
    viewArgs = args;
    return next;
  };
  impl.capabilityValues = () => ({ [CAP.STATUS]: STATUS.CHARGING, [CAP.CHARGING]: true, [CAP.POWER]: null });
  impl.transitions = (from, to) => {
    assert.strictEqual(from, prev);
    assert.strictEqual(to, next);
    return [{ trigger: FLOW.TRIGGER.STATUS_CHANGED, tokens: { old_status: STATUS.PAUSED, new_status: STATUS.CHARGING }, state: { old: STATUS.PAUSED, new: STATUS.CHARGING } }];
  };
  impl.onPoll = async view => {
    assert.strictEqual(view, next);
    device.sdk.events.push('onPoll');
  };
  impl.energyUpdate = async snapshot => {
    assert.strictEqual(snapshot.raw.id, 'c1');
    device.sdk.events.push('energy');
    return { total: 12.34567, green: 0 };
  };

  await device.poll();
  assert.deepStrictEqual(device.sdk.events, [
    `set ${CAP.STATUS}=charging`,
    `set ${CAP.CHARGING}=true`,
    `trigger ${FLOW.TRIGGER.STATUS_CHANGED}`,
    'onPoll',
    'energy',
    `set ${CAP.TOTAL_ENERGY}=12.346`,
    `options ${CAP.TARGET_POWER}`,
    `set ${CAP.ALARM}=false`
  ]);
  assert.strictEqual(viewArgs[1], prev);
  assert.deepStrictEqual({ ...viewArgs[2], now: 0 }, { phases: controller.measuredPhases, timezone: 'Europe/Amsterdam', now: 0 });
  assert.deepStrictEqual(homey.flow.cards[FLOW.TRIGGER.STATUS_CHANGED].triggers, [
    { tokens: { old_status: 'Gepauzeerd', new_status: 'Laden', old_status_id: STATUS.PAUSED, new_status_id: STATUS.CHARGING }, state: { old: STATUS.PAUSED, new: STATUS.CHARGING } }
  ]);
  assert.strictEqual(device.view, next);
});

test('poll: other triggers keep their tokens', async () => {
  const { device, homey } = await makeDevice();
  impl.transitions = () => [{ trigger: FLOW.TRIGGER.SESSION_ENDED, tokens: { kwh: 10.5, green_kwh: 2 }, state: {} }];
  await device.poll();
  assert.deepStrictEqual(homey.flow.cards[FLOW.TRIGGER.SESSION_ENDED].triggers[0].tokens, { kwh: 10.5, green_kwh: 2 });
});

test('poll: auth_rejected makes the device unavailable', async () => {
  const { device } = await makeDevice();
  impl.getStatus = async () => {
    throw Object.assign(new Error('Sign-in refused'), { code: ERR.AUTH_REJECTED });
  };
  await device.poll();
  assert.strictEqual(device.getAvailable(), false);
  assert.strictEqual(device.sdk.unavailable, MSG.LOGIN);
  assert.deepStrictEqual(device.sdk.logs.slice(-1), [`Poll failed: ${ERR.AUTH_REJECTED}`]);
});

test('poll: throttled keeps the device available, with the alarm', async () => {
  const { device } = await makeDevice();
  impl.getStatus = async () => {
    throw Object.assign(new Error('Too many requests'), { code: ERR.THROTTLED, retryAt: 1000 });
  };
  await device.poll();
  assert.strictEqual(device.getAvailable(), true);
  assert.strictEqual(device.getCapabilityValue(CAP.ALARM), true);
  assert.deepStrictEqual(device.sdk.events, [`set ${CAP.ALARM}=true`]);
});

test('poll: throttled asks for the next poll right at retryAt', async () => {
  const { device, poller } = await makeDevice();
  const retryAt = Date.now() + 120000;
  impl.getStatus = async () => {
    throw Object.assign(new Error('Too many requests'), { code: ERR.THROTTLED, retryAt });
  };
  await device.poll();
  const soon = poller.calls.filter(call => call[0] === 'soon');
  assert.strictEqual(soon.length, 1);
  assert.ok(Math.abs(soon[0][1] - 120000) < 1000, `soon(${soon[0][1]})`);
});

test('poll: the current uses the phases of this reading, the last known ones otherwise', async () => {
  const { device } = await makeDevice();
  const seen = [];
  impl.toView = (snapshot, prev, options) => { seen.push(options.phases); return { status: STATUS.CHARGING }; };
  made.controllers[0].phases = 2;
  impl.getStatus = async () => ({ status: STATUS.CHARGING, maxCurrent: 16, powerKw: 11.04 });
  await device.poll();
  impl.getStatus = async () => ({ status: STATUS.CHARGING, maxCurrent: 16, powerKw: 2 });
  await device.poll();
  assert.deepStrictEqual(seen, [3, 2], '11040 W at 16 A is 3 phases; 2 kW fits no whole number, so the last known 2');
});

test('poll: an old last_sync does not turn the alarm on (no heartbeat)', async () => {
  const { device } = await makeDevice({ available: false });
  impl.toView = () => ({ status: STATUS.CHARGING, lastSync: 0 });
  await device.poll();
  assert.strictEqual(device.getCapabilityValue(CAP.ALARM), false);
  assert.strictEqual(device.getAvailable(), true);
});

test('poll: offline turns the alarm on', async () => {
  const { device } = await makeDevice();
  impl.toView = () => ({ status: STATUS.OFFLINE });
  await device.poll();
  assert.strictEqual(device.getCapabilityValue(CAP.ALARM), true);
  assert.strictEqual(device.getAvailable(), true);
});

test('poll: a good poll clears the alarm and the login error', async () => {
  const { device } = await makeDevice();
  impl.getStatus = async () => {
    throw Object.assign(new Error('refused'), { code: ERR.AUTH_REJECTED });
  };
  await device.poll();
  impl.getStatus = async () => {
    throw Object.assign(new Error('timeout'), { code: ERR.TIMEOUT });
  };
  await device.poll();
  assert.strictEqual(device.getAvailable(), false, 'only a good poll makes it available');
  assert.strictEqual(device.getCapabilityValue(CAP.ALARM), true);

  impl.getStatus = async () => ({ status_id: 194 });
  await device.poll();
  assert.strictEqual(device.getAvailable(), true);
  assert.strictEqual(device.getCapabilityValue(CAP.ALARM), false);
});

test('poll: never throws, failing sets and triggers are only logged', async () => {
  const { device, homey } = await makeDevice();
  device.setCapabilityValue = async () => { throw new Error('busy'); };
  homey.flow.getDeviceTriggerCard = () => { throw new Error('no card'); };
  impl.transitions = () => [{ trigger: FLOW.TRIGGER.CAR_CONNECTED, tokens: {}, state: {} }];
  impl.energyUpdate = async () => { throw new Error('history'); };
  await device.poll();
  impl.toView = () => { throw new TypeError('bad view'); };
  await device.poll();
  assert.ok(device.sdk.logs.some(line => line.includes('Failed to set')));
  assert.ok(device.sdk.logs.some(line => line.includes('Failed to trigger')));
});

test('poll: meters never go down, green added with its title', async () => {
  const caps = Object.fromEntries(MANIFEST_CAPS.map(id => [id, null]));
  caps[CAP.TOTAL_ENERGY] = 20;
  const { device } = await makeDevice({ caps });
  impl.energyUpdate = async () => ({ total: 19, green: 1.5 });
  await device.poll();
  assert.strictEqual(device.getCapabilityValue(CAP.TOTAL_ENERGY), 20);
  assert.strictEqual(device.getCapabilityValue(CAP.GREEN_ENERGY), 1.5);
  assert.deepStrictEqual(device.sdk.options[CAP.GREEN_ENERGY], { title: { en: 'Green energy charged total' } });

  impl.energyUpdate = async () => ({ total: 21, green: 1 });
  await device.poll();
  assert.strictEqual(device.getCapabilityValue(CAP.TOTAL_ENERGY), 21);
  assert.strictEqual(device.getCapabilityValue(CAP.GREEN_ENERGY), 1.5);
});

test('poll: target_power options only set when they change', async () => {
  const { device } = await makeDevice();
  await device.poll();
  await device.poll();
  impl.targetOptions = () => ({ min: 0, max: 22080, step: 690, excludeMin: 0, excludeMax: 4140 });
  await device.poll();
  assert.strictEqual(device.sdk.events.filter(event => event === `options ${CAP.TARGET_POWER}`).length, 2);
  assert.strictEqual(device.sdk.options[CAP.TARGET_POWER].max, 22080);
});

test('settings: a changed polling interval goes to the poller', async () => {
  const { device, poller } = await makeDevice();
  await device.onSettings({ oldSettings: { polling: 120 }, newSettings: { polling: 300 }, changedKeys: ['polling'] });
  await device.onSettings({ oldSettings: {}, newSettings: { polling: 300 }, changedKeys: ['other'] });
  assert.deepStrictEqual(poller.calls.slice(1), [['setInterval', 300000]]);
});

test('interval: two chargers on the account, staggered by slot', async () => {
  const { poller } = await makeDevice({ settings: { polling: 90 }, account: makeAccount({ count: 2, slot: 1 }) });
  assert.deepStrictEqual(poller.calls, [['start', 120000, 60000]]);
  assert.strictEqual(await poller.options.run(), undefined, 'run is the poll');
});

test('interval: the first charger follows when a second one is added', async () => {
  const account = makeAccount();
  const first = (await makeDevice({ account })).device;
  account.chargerCount = 3;
  const second = new Device();
  Object.assign(second, { homey: first.homey, sdk: { ...first.sdk, id: 'c2', events: [], listeners: [] } });
  second.driver = { manifest: first.driver.manifest, getDevices: () => [first, second] };
  await second.onInit();
  assert.deepStrictEqual(made.pollers[0].calls.slice(-1), [['setInterval', 180000]]);
});

test('interval: the other charger polls faster again when one is removed', async () => {
  const account = makeAccount();
  const first = (await makeDevice({ account })).device;
  account.chargerCount = 3;
  const second = new Device();
  Object.assign(second, { homey: first.homey, sdk: { ...first.sdk, id: 'c2', events: [], listeners: [] } });
  second.driver = { manifest: first.driver.manifest, getDevices: () => [first, second] };
  await second.onInit();
  account.chargerCount = 1;
  await second.onDeleted();
  assert.deepStrictEqual(made.pollers[0].calls.slice(-1), [['setInterval', 120000]]);
});

test('restart: fresh poller, available again', async () => {
  const { device, poller, account } = await makeDevice({ available: false });
  await device.restart();
  assert.deepStrictEqual(poller.calls, [['start', 120000, 0], ['stop'], ['start', 120000, 0]]);
  assert.strictEqual(device.getAvailable(), true);
  assert.deepStrictEqual(account.calls, [['register', 'c1']], 'same account, no new registration');
  assert.strictEqual(made.controllers.length, 1);
});

test('init without credentials: unavailable, no polling', async () => {
  const { device, poller } = await makeDevice({ store: {} });
  assert.strictEqual(device.getAvailable(), false);
  assert.strictEqual(device.sdk.unavailable, MSG.LOGIN);
  assert.deepStrictEqual(poller.calls, []);
  await assert.rejects(multipleListener(device).listener({ evcharger_charging: true }, {}), new RegExp(MSG.LOGIN));
});

test('uninit and delete: poller stopped, controller and meter disposed, charger unregistered once', async () => {
  const { device, poller, account } = await makeDevice();
  await device.onDeleted();
  await device.onUninit();
  assert.deepStrictEqual(poller.calls.filter(call => call[0] === 'stop').length, 2);
  assert.ok(made.controllers[0].calls.some(call => call[0] === 'dispose'));
  assert.ok(made.meters[0].disposed >= 1);
  assert.deepStrictEqual(account.calls, [['register', 'c1'], ['unregister', 'c1']]);
});

// app.js

async function makeApp() {
  const app = new App();
  app.homey = makeHomey(makeAccount());
  app.logs = [];
  await app.onInit();
  return app;
}

test('app: one registry, accounts with tokens in settings per account key', async () => {
  const app = await makeApp();
  const registry = made.registries[0];
  assert.strictEqual(app.registry, registry);
  const account = registry.options.create(EMAIL, PASSWORD);
  const options = account.options;
  assert.strictEqual(options.username, EMAIL);
  assert.strictEqual(options.password, PASSWORD);
  assert.strictEqual(options.userAgent, 'Homey-WallboxEV (nl.luukschakenraad.wallbox/1.0.0)');
  assert.strictEqual(typeof options.fetch, 'function');
  assert.strictEqual(typeof options.now(), 'number');
  assert.strictEqual(typeof options.timers.setTimeout, 'function');

  assert.strictEqual(options.persist.load(), null);
  const tokens = { jwt: 'j', jwtTtl: 1, refresh: 'r', refreshTtl: 2 };
  options.persist.save(tokens);
  assert.deepStrictEqual(app.homey.settings.values, { 'tokens:me@example.com': tokens });
  assert.deepStrictEqual(options.persist.load(), tokens);
  options.persist.save(null);
  assert.deepStrictEqual(app.homey.settings.values, {});
});

test('app: change_ampere returns the controller tokens', async () => {
  const app = await makeApp();
  const { device } = await makeDevice();
  impl.setCurrent = async amps => ({ result: 'queued', amps, seconds: 42 });
  const tokens = await app.homey.flow.cards[FLOW.ACTION.CHANGE_AMPERE].run({ device, ampere: 10 });
  assert.deepStrictEqual(tokens, { result: 'queued', amps: 10, seconds: 42 });

  await app.homey.flow.cards[FLOW.ACTION.SET_ECO_SMART].run({ device, mode: 'full_solar' });
  assert.deepStrictEqual(made.controllers[0].calls, [['setEcoSmart', 'full_solar']]);
});

test('app: status_is with a group, conditions and status trigger', async () => {
  const app = await makeApp();
  const { device } = await makeDevice();
  const cards = app.homey.flow.cards;
  device.sdk.caps.set(CAP.STATUS, STATUS.DISCHARGING);
  device.sdk.caps.set(CAP.CAR_CONNECTED, true);
  device.sdk.caps.set(CAP.ECO_SMART, 'eco');

  assert.strictEqual(await cards[FLOW.CONDITION.STATUS_IS].run({ device, status: GROUP.CHARGING }), true);
  assert.strictEqual(await cards[FLOW.CONDITION.STATUS_IS].run({ device, status: GROUP.PAUSED }), false);
  assert.strictEqual(await cards[FLOW.CONDITION.CAR_IS_CONNECTED].run({ device }), true);
  assert.strictEqual(await cards[FLOW.CONDITION.ECO_SMART_IS].run({ device, mode: 'eco' }), true);
  assert.strictEqual(await cards[FLOW.CONDITION.ECO_SMART_IS].run({ device, mode: 'off' }), false);
  assert.strictEqual(await cards[FLOW.TRIGGER.STATUS_CHANGED].run({ status: STATUS.PAUSED }, { old: STATUS.CHARGING, new: STATUS.PAUSED }), true);
  made.controllers[0].pausedByHomey = () => true;
  assert.strictEqual(await cards[FLOW.CONDITION.PAUSED_BY_HOMEY].run({ device }), true);
});

// driver.js

function makeDriver(account = makeAccount(), devices = []) {
  const driver = new Driver();
  driver.homey = makeHomey(account);
  driver.logs = [];
  driver.devices = devices;
  return driver;
}

function makeSession() {
  return {
    handlers: {},
    setHandler(event, handler) {
      this.handlers[event] = handler;
      return this;
    }
  };
}

test('pair: list with credentials in the store, none in settings or logs', async () => {
  const account = makeAccount();
  const driver = makeDriver(account);
  const session = makeSession();
  impl.listChargers = async () => [{ id: 'c1', name: 'Garage' }, { id: 'c2', name: 'Street' }];
  await driver.onPair(session);
  assert.strictEqual(await session.handlers.login({ username: ` ${EMAIL} `, password: PASSWORD }), true);
  const devices = await session.handlers.list_devices();
  assert.deepStrictEqual(devices, [
    { name: 'Garage', data: { id: 'c1' }, store: { username: EMAIL, password: PASSWORD } },
    { name: 'Street', data: { id: 'c2' }, store: { username: EMAIL, password: PASSWORD } }
  ]);
  assert.deepStrictEqual(driver.homey.app.registry.gets, [[EMAIL, PASSWORD]]);
  assert.strictEqual(made.apis.length, 1, 'one api for the charger list');
  assert.deepStrictEqual(account.calls, [['verifyCredentials', EMAIL, PASSWORD]]);
  const logs = driver.logs.join('\n');
  for (const secret of [EMAIL, EMAIL.toLowerCase(), PASSWORD, 'Garage', 'c1'])
    assert.ok(!logs.includes(secret), `${secret} in the logs`);
  assert.match(logs, /2 charger/);
});

test('pair: rejected login shows the login message, the account keeps its credentials', async () => {
  const account = makeAccount();
  account.verifyError = Object.assign(new Error('refused'), { code: ERR.AUTH_REJECTED });
  const driver = makeDriver(account);
  const session = makeSession();
  impl.listChargers = async () => assert.fail('no list after a rejected login');
  await driver.onPair(session);
  await assert.rejects(session.handlers.login({ username: EMAIL, password: PASSWORD }), { message: MSG.LOGIN });
  assert.deepStrictEqual(account.calls, [['verifyCredentials', EMAIL, PASSWORD]], 'no setCredentials: a typo blocks nothing');
  assert.ok(!driver.logs.join('\n').includes(EMAIL));
});

test('repair: new credentials on the account, stores of its devices updated, device restarted', async () => {
  const account = makeAccount();
  const fake = (id, username) => ({
    id,
    restarts: 0,
    store: { username, password: 'old' },
    getData() { return { id }; },
    getStoreValue(key) { return this.store[key]; },
    async setStoreValue(key, value) { this.store[key] = value; },
    async restart() { this.restarts++; }
  });
  const repaired = fake('c1', EMAIL);
  const sibling = fake('c2', 'me@example.COM ');
  const stranger = fake('c3', 'other@example.com');
  const driver = makeDriver(account, [repaired, sibling, stranger]);
  const session = makeSession();
  await driver.onRepair(session, repaired);
  assert.strictEqual(await session.handlers.login({ username: EMAIL, password: 'new-pw' }), true);

  assert.deepStrictEqual(account.calls, [['verifyCredentials', EMAIL, 'new-pw']]);
  assert.deepStrictEqual(repaired.store, { username: EMAIL, password: 'new-pw' });
  assert.deepStrictEqual(sibling.store, { username: EMAIL, password: 'new-pw' });
  assert.deepStrictEqual(stranger.store, { username: 'other@example.com', password: 'old' });
  assert.deepStrictEqual([repaired.restarts, sibling.restarts, stranger.restarts], [1, 0, 0]);
  assert.ok(!driver.logs.join('\n').includes('new-pw'));
});

test('repair: charger not on the account fails, stores untouched', async () => {
  const repaired = { getData: () => ({ id: 'c9' }), restart: async () => assert.fail('no restart') };
  const driver = makeDriver(makeAccount(), [repaired]);
  const session = makeSession();
  await driver.onRepair(session, repaired);
  await assert.rejects(session.handlers.login({ username: EMAIL, password: PASSWORD }), { message: MSG.NOT_REACHABLE });
});

test('repair: wrong password fails, stores and account untouched', async () => {
  const account = makeAccount();
  account.verifyError = Object.assign(new Error('refused'), { code: ERR.AUTH_REJECTED });
  const repaired = { store: { username: EMAIL, password: 'old' }, getData: () => ({ id: 'c1' }), getStoreValue(key) { return this.store[key]; }, setStoreValue: async () => assert.fail('no store write'), restart: async () => assert.fail('no restart') };
  const driver = makeDriver(account, [repaired]);
  const session = makeSession();
  await driver.onRepair(session, repaired);
  await assert.rejects(session.handlers.login({ username: EMAIL, password: 'typo' }), { message: MSG.LOGIN });
  assert.deepStrictEqual(account.calls, [['verifyCredentials', EMAIL, 'typo']]);
});

test('poll: our own request budget full is no connection alarm', async () => {
  const { device, account } = await makeDevice();
  account.blockedUntil = 0;
  impl.getStatus = async () => {
    throw Object.assign(new Error('budget'), { code: ERR.THROTTLED, sent: false, retryAt: Date.now() + 20000 });
  };
  await device.poll();
  assert.notStrictEqual(device.getCapabilityValue(CAP.ALARM), true);
  account.blockedUntil = Date.now() + 60000;
  await device.poll();
  assert.strictEqual(device.getCapabilityValue(CAP.ALARM), true, 'blocked by Wallbox: alarm');
});

test('poll: status 403 four times in a row warns "not reachable", a good poll clears it', async () => {
  const { device } = await makeDevice();
  impl.getStatus = async () => {
    throw Object.assign(new Error('forbidden'), { code: ERR.THROTTLED, status: 403, retryAt: Date.now() + 1000 });
  };
  for (let i = 0; i < 5; i++)
    await device.poll();
  assert.strictEqual(device.sdk.warning, MSG.NOT_REACHABLE);
  assert.strictEqual(device.sdk.events.filter(event => event === 'warning').length, 1);
  impl.getStatus = async () => ({ status_id: 194 });
  await device.poll();
  assert.strictEqual(device.sdk.warning, null);
});

test('connect: a new account disposes the old controller', async () => {
  const { device } = await makeDevice();
  const old = made.controllers[0];
  device.sdk.store.username = 'other@example.com';
  device.homey.app.registry.get = () => makeAccount();
  device.connect();
  assert.ok(old.calls.some(call => call[0] === 'dispose'));
  assert.strictEqual(made.controllers.length, 2);
});

test('poll failures for over 10 minutes: power and current go to 0', async () => {
  const { device } = await makeDevice();
  device.sdk.caps.set(CAP.POWER, 7400);
  device.sdk.caps.set(CAP.CURRENT, 10.7);
  device.lastGoodPoll = Date.now() - 11 * 60 * 1000;
  impl.getStatus = async () => {
    throw Object.assign(new Error('timeout'), { code: ERR.TIMEOUT });
  };
  await device.poll();
  assert.strictEqual(device.getCapabilityValue(CAP.POWER), 0);
  assert.strictEqual(device.getCapabilityValue(CAP.CURRENT), 0);
});

test('a short poll failure keeps the last power', async () => {
  const { device } = await makeDevice();
  device.sdk.caps.set(CAP.POWER, 7400);
  device.lastGoodPoll = Date.now() - 60 * 1000;
  impl.getStatus = async () => {
    throw Object.assign(new Error('timeout'), { code: ERR.TIMEOUT });
  };
  await device.poll();
  assert.strictEqual(device.getCapabilityValue(CAP.POWER), 7400);
});

test('triggers: not followed and Eco-Smart changed give titles and ids', async () => {
  const { device, homey } = await makeDevice();
  await device.fire(FLOW.TRIGGER.NOT_FOLLOWED, { command: 'start', reason: 'car_full' });
  assert.deepStrictEqual(homey.flow.cards[FLOW.TRIGGER.NOT_FOLLOWED].triggers[0].tokens, { command: 'commands.start', reason: 'reasons.car_full', command_id: 'start', reason_id: 'car_full' });
  await device.fire(FLOW.TRIGGER.ECO_SMART_CHANGED, { mode: 'eco' });
  assert.strictEqual(homey.flow.cards[FLOW.TRIGGER.ECO_SMART_CHANGED].triggers[0].tokens.mode_id, 'eco');
});

test('poll: a trigger whose flow keeps running does not hold up the poll', async () => {
  const { device, homey } = await makeDevice();
  impl.transitions = () => [{ trigger: FLOW.TRIGGER.STATUS_CHANGED, tokens: { old_status: STATUS.CHARGING, new_status: STATUS.LOCKED_CAR }, state: {} }];
  homey.flow.cards[FLOW.TRIGGER.STATUS_CHANGED] = { trigger: () => new Promise(() => {}), registerRunListener: () => {} };
  let polled = false;
  impl.onPoll = async () => { polled = true; };
  await device.poll();
  assert.strictEqual(polled, true, 'the controller still got the poll');
});

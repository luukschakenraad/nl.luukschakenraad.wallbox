'use strict';

// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const c = require('../lib/contract');
const view = require('../lib/charger/view');

const ROOT = path.join(__dirname, '..');
const LANGUAGES = ['en', 'nl', 'fr'];
const CAPABILITY_DIR = path.join(ROOT, '.homeycompose', 'capabilities');

const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const driver = read('drivers/wallbox/driver.compose.json');
const flow = read('drivers/wallbox/driver.flow.compose.json');
const locales = Object.fromEntries(LANGUAGES.map(language => [language, read(`locales/${language}.json`)]));
const customCapabilities = fs.readdirSync(CAPABILITY_DIR)
  .filter(file => file.endsWith('.json'))
  .map(file => path.basename(file, '.json'));
const capability = id => read(`.homeycompose/capabilities/${id}.json`);

// Homey system capabilities this driver uses (homey-lib assets/capability/capabilities)
const SYSTEM_CAPABILITIES = [
  'locked',
  'evcharger_charging_state',
  'evcharger_charging',
  'measure_power',
  'measure_current',
  'meter_power',
  'target_power',
  'target_power_mode',
  'alarm_connectivity'
];

const baseId = id => id.split('.')[0];
const ids = values => values.map(value => value.id);
const card = (type, id) => (flow[type] || []).find(item => item.id === id);

function assertTitled(object, where) {
  for (const language of LANGUAGES)
    assert.ok(typeof object[language] === 'string' && object[language].length > 0, `${where}: no ${language}`);
}

function assertCard(type, id, args, tokens) {
  const found = card(type, id);
  assert.ok(found, `${type} ${id} missing`);
  assertTitled(found.title, `${id}.title`);
  assert.deepStrictEqual((found.args || []).map(arg => arg.name), args, `${id} args`);
  assert.deepStrictEqual((found.tokens || []).map(token => [token.name, token.type]), tokens, `${id} tokens`);
  for (const token of found.tokens || [])
    assertTitled(token.title, `${id}.tokens.${token.name}`);
  if (args.length > 0) {
    assert.ok(found.titleFormatted, `${id} has no titleFormatted`);
    for (const language of LANGUAGES)
      for (const arg of args)
        assert.ok(found.titleFormatted[language].includes(`[[${arg}]]`), `${id}.titleFormatted.${language} misses [[${arg}]]`);
  }
  return found;
}

test('status capability: values are the STATUS ids, titled en/nl/fr', () => {
  const status = capability('status');
  assert.strictEqual(status.type, 'enum');
  assert.deepStrictEqual(ids(status.values), Object.values(c.STATUS));
  for (const value of status.values)
    assertTitled(value.title, `status.${value.id}`);
  assert.strictEqual(status.insights, false);
  assert.strictEqual(status.units, undefined);
});

test('eco_smart capability: values are the ECO_SMART ids', () => {
  const ecoSmart = capability('eco_smart');
  assert.strictEqual(ecoSmart.type, 'enum');
  assert.deepStrictEqual(ids(ecoSmart.values), Object.values(c.ECO_SMART));
  for (const value of ecoSmart.values)
    assertTitled(value.title, `eco_smart.${value.id}`);
});

test('custom capabilities: getable, not setable, titled, with icon', () => {
  const types = {
    status: 'enum',
    status_code: 'number',
    car_connected: 'boolean',
    max_charging_current: 'number',
    eco_smart: 'enum',
    last_updated: 'string'
  };
  assert.deepStrictEqual(customCapabilities.sort(), Object.keys(types).sort());
  for (const id of customCapabilities) {
    const definition = capability(id);
    assert.strictEqual(definition.type, types[id], id);
    assert.strictEqual(definition.getable, true, id);
    assert.strictEqual(definition.setable, false, id);
    assert.ok(definition.icon && fs.existsSync(path.join(ROOT, definition.icon)), `${id} icon`);
    assertTitled(definition.title, id);
  }
  assert.strictEqual(capability('car_connected').insights, true);
  assert.strictEqual(capability('car_connected').title.en, 'Car connected');
  assert.strictEqual(capability('status_code').units, undefined);
  assert.strictEqual(capability('max_charging_current').units.en, 'A');
});

test('every FLOW id present with the right args and tokens', () => {
  const T = c.FLOW.TRIGGER;
  const C = c.FLOW.CONDITION;
  const A = c.FLOW.ACTION;
  assertCard('triggers', T.STATUS_CHANGED, ['status'], [['old_status', 'string'], ['new_status', 'string'], ['old_status_id', 'string'], ['new_status_id', 'string']]);
  assertCard('triggers', T.CAR_CONNECTED, [], []);
  assertCard('triggers', T.CAR_DISCONNECTED, [], []);
  assertCard('triggers', T.SESSION_ENDED, [], [['kwh', 'number'], ['green_kwh', 'number']]);
  assertCard('triggers', T.NOT_FOLLOWED, [], [['command', 'string'], ['reason', 'string'], ['command_id', 'string'], ['reason_id', 'string']]);
  assertCard('triggers', T.ECO_SMART_CHANGED, [], [['mode', 'string'], ['mode_id', 'string']]);
  assertCard('triggers', T.MAX_CURRENT_CHANGED, [], [['amps', 'number']]);
  assertCard('conditions', C.PAUSED_BY_HOMEY, [], []);
  assertCard('conditions', C.STATUS_IS, ['status'], []);
  assertCard('conditions', C.CAR_IS_CONNECTED, [], []);
  assertCard('conditions', C.ECO_SMART_IS, ['mode'], []);
  const ampere = assertCard('actions', A.CHANGE_AMPERE, ['ampere'], [['result', 'string'], ['amps', 'number'], ['seconds', 'number']]);
  assertCard('actions', A.SET_ECO_SMART, ['mode'], []);
  assertCard('actions', A.RESUME_AUTOMATIONS, [], []);

  const arg = ampere.args[0];
  assert.deepStrictEqual([arg.type, arg.min, arg.max, arg.step], ['number', c.MIN_AMP, c.MAX_AMP, 1]);

  const all = [].concat(Object.values(T), Object.values(C), Object.values(A)).sort();
  const listed = [].concat(...['triggers', 'conditions', 'actions'].map(type => ids(flow[type]))).sort();
  assert.deepStrictEqual(listed, all, 'only FLOW cards');
});

test('every flow card has a hint; Eco-Smart and green energy cards name the Wallbox Power Meter', () => {
  for (const type of ['triggers', 'conditions', 'actions'])
    for (const found of flow[type])
      assertTitled(found.hint || {}, `${found.id}.hint`);

  const F = c.FLOW;
  for (const [type, id] of [['triggers', F.TRIGGER.SESSION_ENDED], ['triggers', F.TRIGGER.ECO_SMART_CHANGED], ['conditions', F.CONDITION.ECO_SMART_IS], ['actions', F.ACTION.SET_ECO_SMART]])
    for (const language of LANGUAGES)
      assert.match(card(type, id).hint[language], /Wallbox Power Meter/, `${id}.hint.${language}`);
});

test('hints state the same limits as the README: the card current goes up to the charger maximum, not a fixed 32 A', () => {
  const hint = card('actions', c.FLOW.ACTION.CHANGE_AMPERE).hint
  for (const language of LANGUAGES)
    assert.ok(!/6-32 A/.test(hint[language]), `${language}: ${hint[language]}`)
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /6 A up to the charger's maximum/)
  assert.match(hint.en, /6 A up to the charger's maximum/)
});

test('conditions invert with !{{...|...}}', () => {
  for (const id of Object.values(c.FLOW.CONDITION)) {
    const found = card('conditions', id);
    for (const language of LANGUAGES) {
      const text = (found.titleFormatted || found.title)[language];
      assert.match(text, /!\{\{[^|}]+\|[^}]+\}\}/, `${id}.${language}`);
    }
  }
});

test('status dropdowns: ANY, GROUP and STATUS ids with the status titles', () => {
  const statusTitles = Object.fromEntries(capability('status').values.map(value => [value.id, value.title]));
  const trigger = card('triggers', c.FLOW.TRIGGER.STATUS_CHANGED).args[0];
  const condition = card('conditions', c.FLOW.CONDITION.STATUS_IS).args[0];
  const groups = Object.values(c.GROUP);
  const statuses = Object.values(c.STATUS);

  assert.strictEqual(trigger.type, 'dropdown');
  assert.deepStrictEqual(ids(trigger.values), [c.ANY, ...groups, ...statuses]);
  assert.strictEqual(condition.type, 'dropdown');
  assert.deepStrictEqual(ids(condition.values), [...groups, ...statuses]);

  for (const value of [...trigger.values, ...condition.values]) {
    assertTitled(value.title, `dropdown ${value.id}`);
    if (statuses.includes(value.id))
      assert.deepStrictEqual(value.title, statusTitles[value.id], `dropdown ${value.id} title`);
  }
});

test('eco-smart dropdowns: ECO_SMART ids', () => {
  for (const found of [card('conditions', c.FLOW.CONDITION.ECO_SMART_IS), card('actions', c.FLOW.ACTION.SET_ECO_SMART)]) {
    const arg = found.args.find(item => item.name === 'mode');
    assert.strictEqual(arg.type, 'dropdown');
    assert.deepStrictEqual(ids(arg.values), Object.values(c.ECO_SMART), found.id);
  }
});

test('every MSG key in every locale, same variables as English', () => {
  const lookup = (locale, key) => key.split('.').reduce((node, part) => (node ? node[part] : undefined), locale);
  const variables = text => (text.match(/__\w+__/g) || []).sort();
  for (const key of Object.values(c.MSG)) {
    const english = lookup(locales.en, key);
    assert.ok(typeof english === 'string' && english.length > 0, `en: ${key}`);
    for (const language of LANGUAGES) {
      const text = lookup(locales[language], key);
      assert.ok(typeof text === 'string' && text.length > 0, `${language}: ${key}`);
      assert.deepStrictEqual(variables(text), variables(english), `${language}: ${key} variables`);
    }
  }
  assert.deepStrictEqual(variables(lookup(locales.en, c.MSG.BUSY)), ['__minutes__']);
  assert.deepStrictEqual(variables(lookup(locales.en, c.MSG.CURRENT_RANGE)), ['__max__', '__min__']);
});

test('store texts: README.txt plus README.<language>.txt per locale, the names Homey reads (changed: were README_nl.txt and README_fr.txt, which Homey ignores)', () => {
  const files = fs.readdirSync(ROOT).filter(file => /^README.*\.txt$/.test(file)).sort();
  const expected = ['README.txt', ...LANGUAGES.filter(language => language !== 'en').map(language => `README.${language}.txt`)].sort();
  assert.deepStrictEqual(files, expected);
  for (const file of files)
    assert.ok(fs.readFileSync(path.join(ROOT, file), 'utf8').trim().length > 0, `${file} is empty`);
});

test('locales have the same keys', () => {
  const keys = (node, prefix = '') => Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'object' ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]).sort();
  for (const language of LANGUAGES)
    assert.deepStrictEqual(keys(locales[language]), keys(locales.en), language);
});

test('every driver capability exists (system or custom), none shadowed', () => {
  for (const id of driver.capabilities) {
    const base = baseId(id);
    const system = SYSTEM_CAPABILITIES.includes(base);
    const custom = customCapabilities.includes(base);
    assert.ok(system || custom, `unknown capability ${id}`);
    assert.ok(!(system && custom), `${id} is both system and custom`);
  }
});

test('system capability list matches homey-lib when it is installed', { skip: !hasHomeyLib() }, () => {
  const lib = require('homey-lib');
  for (const id of SYSTEM_CAPABILITIES)
    assert.ok(lib.Capability.hasCapability(id), id);
});

test('driver capabilities: every CAP id, capabilityValues keys among them', () => {
  for (const id of Object.values(c.CAP))
    if (id !== c.CAP.GREEN_ENERGY)
      assert.ok(driver.capabilities.includes(id), `${id} not in driver`);
  assert.ok(!driver.capabilities.includes(c.CAP.GREEN_ENERGY), 'green is added at runtime');
  assert.ok(driver.capabilitiesOptions[c.CAP.GREEN_ENERGY].title, 'green keeps its title');

  const values = view.capabilityValues(view.toView(view.parseSnapshot({ status_id: 194 }, 0), null, { phases: 1, timezone: 'UTC' }));
  for (const id of Object.keys(values))
    assert.ok(driver.capabilities.includes(id), `${id} not in driver`);
});

test('capabilitiesOptions: only for listed capabilities, titles kept (changed: measure_current was "Charging current (flowing)")', () => {
  for (const id of Object.keys(driver.capabilitiesOptions))
    assert.ok(driver.capabilities.includes(id) || id === c.CAP.GREEN_ENERGY, id);
  assert.strictEqual(driver.capabilitiesOptions.measure_current.title.en, 'Charging current');
  assert.strictEqual(driver.capabilitiesOptions.alarm_connectivity.title.en, 'Wallbox connection');
  for (const id of ['meter_power.charged', 'meter_power.total', 'meter_power.green', 'measure_current', 'alarm_connectivity'])
    assertTitled(driver.capabilitiesOptions[id].title, id);
});

test('every custom capability file is used by the driver', () => {
  const used = driver.capabilities.map(baseId);
  for (const id of customCapabilities)
    assert.ok(used.includes(id), `${id}.json not used`);
});

test('polling setting matches TIMING', () => {
  const polling = driver.settings.find(setting => setting.id === 'polling');
  assert.ok(polling, 'polling setting missing');
  assert.strictEqual(polling.type, 'number');
  assert.strictEqual(polling.value, c.TIMING.POLL_DEFAULT);
  assert.strictEqual(polling.min, c.TIMING.POLL_MIN);
  assert.strictEqual(polling.max, c.TIMING.POLL_MAX);
  assert.strictEqual(polling.units.en, 's');
  assertTitled(polling.label, 'polling.label');
  assertTitled(polling.hint, 'polling.hint');
});

test('pair and repair use the login_credentials template', () => {
  assert.deepStrictEqual(driver.pair.map(step => step.template), ['login_credentials', 'list_devices', 'add_devices']);
  assert.deepStrictEqual(driver.repair.map(step => step.template), ['login_credentials']);
  assert.deepStrictEqual(driver.repair[0].options, driver.pair[0].options);
  assert.ok(fs.existsSync(path.join(ROOT, 'drivers/wallbox/pair', driver.pair[0].options.logo)), 'logo');
  assert.strictEqual(driver.class, 'evcharger');
  assert.strictEqual(driver.energy.meterPowerImportedCapability, c.CAP.TOTAL_ENERGY);
});

function hasHomeyLib() {
  try {
    require.resolve('homey-lib');
    return true;
  } catch (error) {
    return false;
  }
}

test('target power range is fixed (changed: was set per phase at runtime): 0 to 22080 W, step 230, nothing between 0 and 1380 W', () => {
  const driver = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'drivers', 'wallbox', 'driver.compose.json'), 'utf8'));
  assert.deepStrictEqual(driver.capabilitiesOptions.target_power, { min: 0, max: 22080, step: 230, excludeMin: 0, excludeMax: 1380 });
});

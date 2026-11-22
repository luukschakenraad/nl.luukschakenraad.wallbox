'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ECO_SMART, ERR } = require('../lib/contract');
const { Account } = require('../lib/wallbox/account');
const { WallboxApi } = require('../lib/wallbox/api');

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

// Account stand-in: records request(method, path, options), answers with `reply`
function fakeAccount(reply = null) {
  const account = {
    calls: [],
    reply,
    async request(method, path, options) {
      account.calls.push({ method, path, body: options ? options.body : undefined, host: options ? options.host : undefined });
      return typeof account.reply === 'function' ? account.reply(method, path) : account.reply;
    }
  };
  return account;
}

function reply(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => text };
}

// Real Account with valid persisted tokens and a fake fetch
function realApi(answer = () => reply(200, {})) {
  const calls = [];
  const account = new Account({
    username: 'someone@example.org',
    password: 'secret',
    fetch: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      return answer(url, options);
    },
    now: () => T0,
    timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    persist: { load: () => ({ jwt: 'tok', jwtTtl: T0 + DAY, refresh: 'rft', refreshTtl: T0 + 30 * DAY }), save: () => {} }
  });
  return { api: new WallboxApi(account), calls };
}

test('api: listChargers maps groups[].chargers[] to { id, name }', async () => {
  const account = fakeAccount({
    result: {
      groups: [
        { id: 1, chargers: [{ id: 101, name: 'Garage', serialNumber: 'X' }, { id: 102, name: '' }] },
        { id: 2, chargers: [{ id: 101, name: 'Garage again' }, { id: 'abc', name: 'Drive' }, null] },
        { id: 3 }
      ]
    }
  });
  const chargers = await new WallboxApi(account).listChargers();
  assert.deepStrictEqual(chargers, [{ id: 101, name: 'Garage' }, { id: 102, name: '102' }, { id: 'abc', name: 'Drive' }]);
  assert.deepStrictEqual(account.calls, [{ method: 'GET', path: 'v3/chargers/groups', body: undefined, host: undefined }]);

  for (const empty of [null, {}, { result: {} }, { result: { groups: null } }])
    assert.deepStrictEqual(await new WallboxApi(fakeAccount(empty)).listChargers(), []);
});

test('api: getStatus returns the raw status', async () => {
  const raw = { status_id: 194, config_data: { max_charging_current: 16 } };
  const account = fakeAccount(raw);
  assert.strictEqual(await new WallboxApi(account).getStatus(123), raw);
  assert.deepStrictEqual(account.calls[0], { method: 'GET', path: 'chargers/status/123', body: undefined, host: undefined });
});

test('api: setCurrent PUTs maxChargingCurrent and returns the value Wallbox reports', async () => {
  const account = fakeAccount({ data: { chargerData: { maxChargingCurrent: 13 } } });
  const api = new WallboxApi(account);
  assert.strictEqual(await api.setCurrent(123, 16), 13);
  assert.deepStrictEqual(account.calls, [{ method: 'PUT', path: 'v2/charger/123', body: { maxChargingCurrent: 16 }, host: undefined }]);

  for (const answer of [null, {}, { data: { chargerData: {} } }, { data: { chargerData: { maxChargingCurrent: '13' } } },
    { data: { chargerData: { maxChargingCurrent: null } } }]) {
    account.reply = answer;
    assert.strictEqual(await api.setCurrent(123, 10), 10, JSON.stringify(answer));
  }
  assert.strictEqual(await new WallboxApi(fakeAccount({ data: { chargerData: { maxChargingCurrent: 0 } } })).setCurrent(1, 6), 0);
});

test('api: setLocked PUTs locked 1 or 0', async () => {
  const account = fakeAccount({});
  const api = new WallboxApi(account);
  await api.setLocked(123, true);
  await api.setLocked(123, false);
  assert.deepStrictEqual(account.calls.map(call => [call.method, call.path, call.body]), [
    ['PUT', 'v2/charger/123', { locked: 1 }],
    ['PUT', 'v2/charger/123', { locked: 0 }]
  ]);
});

test('api: pause and resume POST remote-action 2 and 1', async () => {
  const account = fakeAccount({});
  const api = new WallboxApi(account);
  await api.pause(123);
  await api.resume(123);
  assert.deepStrictEqual(account.calls.map(call => [call.method, call.path, call.body]), [
    ['POST', 'v3/chargers/123/remote-action', { action: 2 }],
    ['POST', 'v3/chargers/123/remote-action', { action: 1 }]
  ]);
});

test('api: setEcoSmart PUTs enabled and mode per ECO_SMART id', async () => {
  const account = fakeAccount(null);
  const api = new WallboxApi(account);
  const expected = { [ECO_SMART.OFF]: [0, 0], [ECO_SMART.ECO]: [1, 0], [ECO_SMART.FULL_SOLAR]: [1, 1] };
  for (const [mode, [enabled, solar]] of Object.entries(expected)) {
    account.calls.length = 0;
    await api.setEcoSmart(123, mode);
    assert.deepStrictEqual(account.calls, [{
      method: 'PUT',
      path: 'v4/chargers/123/eco-smart',
      body: { data: { attributes: { enabled, mode: solar }, type: 'eco_smart' } },
      host: undefined
    }], mode);
  }
  account.calls.length = 0;
  await assert.rejects(api.setEcoSmart(123, 'solar'), TypeError);
  await assert.rejects(api.setEcoSmart(123, 'toString'), TypeError);
  assert.strictEqual(account.calls.length, 0);
});

test('api: sessions GETs v4/sessions/stats with charger, start and end in seconds', async () => {
  const raw = { data: [], meta: { count: 0 } };
  const account = fakeAccount(raw);
  assert.strictEqual(await new WallboxApi(account).sessions(123, 1700000000, 1700086400.7), raw);
  assert.deepStrictEqual(account.calls[0], {
    method: 'GET', path: 'v4/sessions/stats?charger=123&start_date=1700000000&end_date=1700086400', body: undefined, host: undefined
  });
});

test('api: ids are escaped in paths', async () => {
  const account = fakeAccount(null);
  await new WallboxApi(account).getStatus('1/2?x');
  assert.strictEqual(account.calls[0].path, 'chargers/status/1%2F2%3Fx');
});

test('api: through a real Account, each endpoint sends one fetch with the right method, URL and body', async () => {
  const cases = [
    [api => api.listChargers(), 'GET', 'https://api.wall-box.com/v3/chargers/groups', undefined],
    [api => api.getStatus(7), 'GET', 'https://api.wall-box.com/chargers/status/7', undefined],
    [api => api.setCurrent(7, 16), 'PUT', 'https://api.wall-box.com/v2/charger/7', '{"maxChargingCurrent":16}'],
    [api => api.setLocked(7, true), 'PUT', 'https://api.wall-box.com/v2/charger/7', '{"locked":1}'],
    [api => api.pause(7), 'POST', 'https://api.wall-box.com/v3/chargers/7/remote-action', '{"action":2}'],
    [api => api.resume(7), 'POST', 'https://api.wall-box.com/v3/chargers/7/remote-action', '{"action":1}'],
    [api => api.setEcoSmart(7, ECO_SMART.FULL_SOLAR), 'PUT', 'https://api.wall-box.com/v4/chargers/7/eco-smart',
      '{"data":{"attributes":{"enabled":1,"mode":1},"type":"eco_smart"}}'],
    [api => api.sessions(7, 100, 200), 'GET', 'https://api.wall-box.com/v4/sessions/stats?charger=7&start_date=100&end_date=200', undefined]
  ];
  for (const [run, method, url, body] of cases) {
    const { api, calls } = realApi();
    await run(api);
    assert.deepStrictEqual(calls, [{ url, method, body }], url);
  }
});

test('api: setCurrent sends no GET before the PUT and reads the PUT response', async () => {
  const { api, calls } = realApi(() => reply(200, { data: { chargerData: { maxChargingCurrent: 12 } } }));
  assert.strictEqual(await api.setCurrent(7, 14), 12);
  assert.deepStrictEqual(calls.map(call => call.method), ['PUT']);

  const empty = realApi(() => reply(200));
  assert.strictEqual(await empty.api.setCurrent(7, 14), 14);
  assert.deepStrictEqual(empty.calls.map(call => call.method), ['PUT']);
});

test('api: Account errors pass through', async () => {
  const { api } = realApi(() => reply(403));
  await assert.rejects(api.pause(7), err => err.code === ERR.REFUSED);
});

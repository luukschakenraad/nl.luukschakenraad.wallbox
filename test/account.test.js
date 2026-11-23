'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { ERR, MSG, TIMING } = require('../lib/contract');
const { WallboxError, errorMessage } = require('../lib/wallbox/errors');
const { Account, AccountRegistry } = require('../lib/wallbox/account');

const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const TIMERS = Object.freeze({ setTimeout: () => ({}), clearTimeout: () => {} }); // never fire: none of these tests waits

const EMAIL = 'Secret.Person@example.org';
const PASS = 'hunter2-Pa55word';
const EMAIL2 = 'other.person@example.net';
const PASS2 = 'n3w-Passphrase';
const SECRETS = [EMAIL, EMAIL.toLowerCase(), 'secret.person', PASS, EMAIL2, PASS2,
  Buffer.from(`${EMAIL}:${PASS}`).toString('base64'), 'tok-', 'rft-', 'http', 'wall-box', 'example.'];

const allLogs = [];
const allErrors = [];

const flush = () => new Promise(resolve => setImmediate(resolve));

// Fake clock and timers: advance() runs due timers in time order
function fakeClock() {
  const state = { t: T0, list: [], seq: 0 };
  const timers = {
    setTimeout(fn, ms) {
      const handle = { id: ++state.seq, at: state.t + ms, ms, fn };
      state.list.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      state.list = state.list.filter(other => other !== handle);
    }
  };
  async function advance(ms) {
    const end = state.t + ms;
    await flush();
    for (;;) {
      state.list.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = state.list[0];
      if (!next || next.at > end) break;
      state.list.shift();
      state.t = Math.max(state.t, next.at);
      next.fn();
      await flush();
    }
    state.t = end;
    await flush();
  }
  return { now: () => state.t, timers, advance, pending: () => state.list.length };
}

function reply(status, body, headers = {}) {
  const text = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const lower = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
    text: async () => text
  };
}

const tokenBody = (jwt, refresh, attributes = {}) => ({ data: { attributes: { token: jwt, refresh_token: refresh, ...attributes } } });

const kindOf = url => {
  if (url === 'https://user-api.wall-box.com/users/signin') return 'signin';
  if (url === 'https://user-api.wall-box.com/users/refresh-token') return 'refresh';
  return 'api';
};

// Account with a fake fetch, clock, timers and persist. handlers.<kind>(call)
// answers sign-in, refresh and API calls.
function setup({ stored = null } = {}) {
  const clock = fakeClock();
  const calls = [];
  const logs = [];
  const saves = [];
  let n = 0;
  const handlers = {
    signin: () => {
      n++;
      return reply(200, tokenBody(`tok-${n}`, `rft-${n}`, { ttl: clock.now() + 15 * MIN, refresh_token_ttl: clock.now() + 30 * DAY }));
    },
    refresh: () => {
      n++;
      return reply(200, tokenBody(`tok-${n}`, `rft-${n}`, { ttl: clock.now() + 15 * MIN, refresh_token_ttl: clock.now() + 30 * DAY }));
    },
    api: () => reply(200, { ok: true })
  };
  const fetch = async (url, options) => {
    const call = { url, ...options, kind: kindOf(url), auth: options.headers.Authorization, at: clock.now() };
    calls.push(call);
    return handlers[call.kind](call);
  };
  const h = { clock, calls, logs, saves, handlers, stored, loads: 0 };
  const persist = {
    load: async () => {
      h.loads++;
      return h.stored;
    },
    save: async tokens => {
      saves.push(tokens);
      h.stored = tokens;
    }
  };
  h.account = new Account({
    username: EMAIL, password: PASS, fetch, now: clock.now, timers: clock.timers, persist, log: line => logs.push(line), userAgent: 'Wallbox-Test/1.0'
  });
  h.count = kind => calls.filter(call => call.kind === kind).length;
  allLogs.push(logs);
  return h;
}

const valid = (extra = {}) => ({ jwt: 'tok-old', jwtTtl: T0 + DAY, refresh: 'rft-old', refreshTtl: T0 + 30 * DAY, ...extra });

async function fails(promise, code) {
  const err = await promise.then(() => assert.fail(`expected ${code}`), e => e);
  allErrors.push(err);
  assert.ok(err instanceof WallboxError, String(err && err.stack));
  assert.strictEqual(err.code, code, err.message);
  return err;
}

test('account: signs in on first use with basic auth and the fixed headers, persists the tokens', async () => {
  const h = setup();
  assert.deepStrictEqual(await h.account.request('GET', 'chargers/status/1'), { ok: true });
  assert.deepStrictEqual(h.calls.map(call => call.kind), ['signin', 'api']);
  const [signin, call] = h.calls;
  assert.strictEqual(signin.method, 'GET');
  assert.strictEqual(signin.auth, `Basic ${Buffer.from(`${EMAIL}:${PASS}`).toString('base64')}`);
  assert.strictEqual(call.url, 'https://api.wall-box.com/chargers/status/1');
  assert.strictEqual(call.method, 'GET');
  assert.strictEqual(call.auth, 'Bearer tok-1');
  assert.strictEqual(call.body, undefined);
  for (const c of h.calls) {
    assert.strictEqual(c.headers.Accept, 'application/json');
    assert.strictEqual(c.headers.Partner, 'wallbox');
    assert.strictEqual(c.headers['Content-Type'], 'application/json;charset=UTF-8');
    assert.strictEqual(c.headers['User-Agent'], 'Wallbox-Test/1.0');
    assert.ok(c.signal && typeof c.signal.aborted === 'boolean');
  }
  assert.deepStrictEqual(h.stored, { jwt: 'tok-1', jwtTtl: T0 + 15 * MIN, refresh: 'rft-1', refreshTtl: T0 + 30 * DAY });
  assert.ok(h.logs.includes('signed in'));
  assert.strictEqual(h.clock.pending(), 0, 'timeout timers cleared');
});

test('account: user host, JSON body, empty and 204 bodies give null', async () => {
  const h = setup({ stored: valid() });
  h.handlers.api = () => reply(204);
  assert.strictEqual(await h.account.request('PUT', 'v2/charger/1', { body: { locked: 1 } }), null);
  h.handlers.api = () => reply(200, '');
  assert.strictEqual(await h.account.request('POST', 'x', { host: 'user', body: { action: 1 } }), null);
  assert.strictEqual(h.calls[0].body, '{"locked":1}');
  assert.strictEqual(h.calls[1].url, 'https://user-api.wall-box.com/x');
  await assert.rejects(h.account.request('GET', 'x', { host: 'elsewhere' }), TypeError);
});

test('account: tokens from persist are reused after a restart, loaded once and lazily', async () => {
  const h = setup({ stored: valid({ jwtTtl: T0 + 10 * MIN }) });
  assert.strictEqual(h.loads, 0);
  await Promise.all([h.account.request('GET', 'a'), h.account.request('PUT', 'b')]);
  await h.account.request('GET', 'c');
  assert.strictEqual(h.loads, 1);
  assert.deepStrictEqual(h.calls.map(call => call.auth), ['Bearer tok-old', 'Bearer tok-old', 'Bearer tok-old']);
  assert.strictEqual(h.count('signin') + h.count('refresh'), 0);
});

test('account: TTLs in epoch seconds are read as ms', async () => {
  const h = setup();
  h.handlers.signin = () => reply(200, tokenBody('tok-s', 'rft-s', {
    ttl: Math.floor((T0 + 15 * MIN) / 1000), refresh_token_ttl: Math.floor((T0 + 30 * DAY) / 1000)
  }));
  await h.account.request('GET', 'a');
  assert.strictEqual(h.stored.jwtTtl, T0 + 15 * MIN);
  assert.strictEqual(h.stored.refreshTtl, T0 + 30 * DAY);
  await h.clock.advance(10 * MIN);
  await h.account.request('GET', 'b');
  assert.strictEqual(h.count('signin'), 1);
  assert.strictEqual(h.count('refresh'), 0);
});

test('account: a token valid for less than 60 s is refreshed, 61 s is used', async () => {
  const h = setup({ stored: valid({ jwtTtl: T0 + 59 * SEC }) });
  await h.account.request('GET', 'a');
  assert.deepStrictEqual(h.calls.map(call => call.kind), ['refresh', 'api']);
  assert.strictEqual(h.calls[0].auth, 'Bearer rft-old');
  assert.strictEqual(h.calls[0].method, 'GET');
  assert.strictEqual(h.calls[1].auth, 'Bearer tok-1');
  assert.strictEqual(h.stored.jwt, 'tok-1');
  assert.strictEqual(h.stored.refresh, 'rft-1');
  assert.ok(!h.logs.includes('token refreshed'), 'every 15 min: no log line (changed: was logged, about 100 lines a day)');

  const fresh = setup({ stored: valid({ jwtTtl: T0 + 61 * SEC }) });
  await fresh.account.request('GET', 'a');
  assert.deepStrictEqual(fresh.calls.map(call => call.kind), ['api']);
});

test('account: a refresh without a refresh token keeps the old one', async () => {
  const h = setup({ stored: valid({ jwtTtl: T0 - MIN }) });
  h.handlers.refresh = () => reply(200, { data: { attributes: { token: 'tok-r', ttl: T0 + 15 * MIN } } });
  await h.account.request('GET', 'a');
  assert.deepStrictEqual(h.stored, { jwt: 'tok-r', jwtTtl: T0 + 15 * MIN, refresh: 'rft-old', refreshTtl: T0 + 30 * DAY });
});

test('account: an expired refresh token means a sign-in', async () => {
  const h = setup({ stored: valid({ jwtTtl: T0 - MIN, refreshTtl: T0 + 30 * SEC }) });
  await h.account.request('GET', 'a');
  assert.deepStrictEqual(h.calls.map(call => call.kind), ['signin', 'api']);
});

test('account: a refresh rejected with 401 or 403 falls back to sign-in', async () => {
  for (const status of [401, 403]) {
    const h = setup({ stored: valid({ jwtTtl: T0 - MIN }) });
    h.handlers.refresh = () => reply(status);
    assert.deepStrictEqual(await h.account.request('GET', 'a'), { ok: true });
    assert.deepStrictEqual(h.calls.map(call => call.kind), ['refresh', 'signin', 'api']);
    assert.strictEqual(h.calls[2].auth, 'Bearer tok-1');
    assert.strictEqual(h.account.blockedUntil, 0);
    assert.strictEqual(h.account.rejected, false);
  }
});

test('account: a refresh failing otherwise does not sign in; a 5xx backs off (changed: a 5xx was http, every poll tried again)', async () => {
  const h = setup({ stored: valid({ jwtTtl: T0 - MIN }) });
  h.handlers.refresh = () => reply(404);
  const err = await fails(h.account.request('GET', 'a'), ERR.HTTP);
  assert.strictEqual(err.status, 404);
  assert.strictEqual(err.sent, false, 'the request itself never went out');
  assert.deepStrictEqual(h.calls.map(call => call.kind), ['refresh']);

  const busy = setup({ stored: valid({ jwtTtl: T0 - MIN }) });
  busy.handlers.refresh = () => reply(503);
  const throttled = await fails(busy.account.request('GET', 'a'), ERR.THROTTLED);
  assert.strictEqual(throttled.retryAt, T0 + 2 * MIN);
  await fails(busy.account.request('GET', 'a'), ERR.THROTTLED);
  assert.deepStrictEqual(busy.calls.map(call => call.kind), ['refresh'], 'no new try while backing off, and no sign-in');
});

test('account: a sign-in answered with a 5xx backs off, in the background and in pairing (changed: was http, the next poll signed in again)', async () => {
  const h = setup();
  h.handlers.signin = () => reply(500);
  await fails(h.account.request('GET', 'a'), ERR.THROTTLED);
  await fails(h.account.request('GET', 'a'), ERR.THROTTLED);
  assert.strictEqual(h.count('signin'), 1, 'no second sign-in while backing off');

  const pairing = setup();
  pairing.handlers.signin = () => reply(502);
  await fails(pairing.account.verifyCredentials(EMAIL, PASS), ERR.THROTTLED);
  assert.ok(pairing.account.blockedUntil > T0);
  assert.strictEqual(pairing.account.rejected, false, 'not a wrong password');
});

test('account: a deadline (pairing) never waits for budget past it, and ends the fetch timeout there', async () => {
  const h = setup();
  await h.account.request('GET', 'a'); // sign-in + GET
  await h.account.request('GET', 'b');
  const before = h.calls.length;
  let result = null;
  h.account.verifyCredentials(EMAIL, PASS, { deadline: T0 + 25 * SEC }).then(() => assert.fail('expected throttled'), err => { result = err; });
  await h.clock.advance(0);
  assert.ok(result && result.code === ERR.THROTTLED && result.sent === false, 'at once, no 30 s budget wait');
  assert.strictEqual(h.calls.length, before);

  const slow = setup({ stored: valid() });
  slow.handlers.api = call => new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  let timeout = null;
  slow.account.request('GET', 'v3/chargers/groups', { deadline: T0 + 5 * SEC }).then(() => assert.fail('expected timeout'), err => { timeout = err; });
  await slow.clock.advance(5 * SEC - 1);
  assert.strictEqual(timeout, null);
  await slow.clock.advance(1);
  assert.strictEqual(timeout && timeout.code, ERR.TIMEOUT, 'at the deadline, not after FETCH_TIMEOUT');
});

test('account: a 401 on a call renews the token and retries once', async () => {
  const h = setup({ stored: valid() });
  let first = true;
  h.handlers.api = () => {
    const status = first ? 401 : 200;
    first = false;
    return reply(status, { ok: status });
  };
  assert.deepStrictEqual(await h.account.request('PUT', 'v2/charger/1', { body: { locked: 0 } }), { ok: 200 });
  assert.deepStrictEqual(h.calls.map(call => `${call.kind} ${call.auth}`), ['api Bearer tok-old', 'refresh Bearer rft-old', 'api Bearer tok-1']);
  assert.strictEqual(h.calls[2].body, '{"locked":0}');

  const again = setup({ stored: valid() });
  again.handlers.api = () => reply(401);
  const err = await fails(again.account.request('GET', 'a'), ERR.HTTP);
  assert.strictEqual(err.status, 401);
  assert.deepStrictEqual(again.calls.map(call => call.kind), ['api', 'refresh', 'api']);
});

test('account: concurrent calls share one sign-in', async () => {
  const h = setup();
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const signin = h.handlers.signin;
  h.handlers.signin = async call => {
    await gate;
    return signin(call);
  };
  const all = Promise.all([h.account.request('GET', 'a'), h.account.request('PUT', 'b'), h.account.request('POST', 'c')]);
  await flush();
  assert.strictEqual(h.count('signin'), 1);
  open();
  await all;
  assert.strictEqual(h.count('signin'), 1);
  assert.deepStrictEqual(h.calls.filter(call => call.kind === 'api').map(call => call.auth), ['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-1']);
  assert.strictEqual(h.saves.length, 1);
});

test('account: a rejected login (401) gives auth_rejected, no sign-ins until verifyCredentials (repair)', async () => {
  for (const status of [401]) {
    const h = setup();
    h.handlers.signin = () => reply(status);
    const err = await fails(h.account.request('GET', 'a'), ERR.AUTH_REJECTED);
    assert.strictEqual(err.status, status);
    assert.strictEqual(h.account.rejected, true);
    assert.strictEqual(h.account.blockedUntil, 0);
    assert.ok(h.logs.includes('login rejected'));

    const again = await fails(h.account.request('PUT', 'b'), ERR.AUTH_REJECTED);
    assert.strictEqual(again.sent, false);
    await h.clock.advance(DAY);
    await fails(h.account.request('GET', 'c'), ERR.AUTH_REJECTED);
    assert.strictEqual(h.calls.length, 1);

    h.handlers.signin = () => reply(200, tokenBody('tok-new', 'rft-new', { ttl: h.clock.now() + 15 * MIN, refresh_token_ttl: h.clock.now() + DAY }));
    await h.account.verifyCredentials(EMAIL2, PASS2);
    assert.strictEqual(h.account.rejected, false);
    await h.account.request('GET', 'd');
    assert.deepStrictEqual(h.calls.map(call => call.kind), ['signin', 'signin', 'api']);
    assert.strictEqual(h.calls[1].auth, `Basic ${Buffer.from(`${EMAIL2}:${PASS2}`).toString('base64')}`);
  }
});

test('account: a sign-in in flight during verifyCredentials does not block the new credentials', async () => {
  const h = setup();
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  let signins = 0;
  h.handlers.signin = async () => {
    if (signins++ > 0)
      return reply(200, tokenBody('tok-new', 'rft-new', { ttl: h.clock.now() + 15 * MIN, refresh_token_ttl: h.clock.now() + DAY }));
    await gate;
    return reply(401);
  };
  const old = h.account.request('GET', 'a');
  await flush();
  await h.account.verifyCredentials(EMAIL2, PASS2);
  open();
  await fails(old, ERR.AUTH_REJECTED);
  assert.strictEqual(h.account.rejected, false);
});

test('account: back-off 2/4/8/15/15 min, reset after a success', async () => {
  const h = setup({ stored: valid({ jwtTtl: T0 + 30 * DAY }) });
  let throttle = true;
  h.handlers.api = () => (throttle ? reply(429) : reply(200, { ok: true }));
  for (const minutes of [2, 4, 8, 15, 15]) {
    const err = await fails(h.account.request('GET', 'a'), ERR.THROTTLED);
    assert.strictEqual(err.status, 429);
    assert.strictEqual(err.sent, true);
    assert.strictEqual(h.account.blockedUntil, h.clock.now() + minutes * MIN, `${minutes} min`);
    assert.strictEqual(err.retryAt, h.account.blockedUntil);
    await h.clock.advance(minutes * MIN);
  }
  assert.ok(h.logs.includes('throttled (429) until 2026-11-22T12:02:00.000Z'));
  throttle = false;
  await h.account.request('GET', 'a');
  throttle = true;
  await h.clock.advance(MIN);
  await fails(h.account.request('PUT', 'b'), ERR.THROTTLED);
  assert.strictEqual(h.account.blockedUntil, h.clock.now() + 2 * MIN);
});

test('account: Retry-After in seconds and as an HTTP date; unreadable falls back to the back-off', async () => {
  const seconds = setup({ stored: valid() });
  seconds.handlers.api = () => reply(429, undefined, { 'Retry-After': '120' });
  const err = await fails(seconds.account.request('GET', 'a'), ERR.THROTTLED);
  assert.strictEqual(seconds.account.blockedUntil, T0 + 120 * SEC);
  assert.strictEqual(err.retryAt, T0 + 120 * SEC);

  const date = setup({ stored: valid() });
  date.handlers.api = () => reply(429, undefined, { 'retry-after': new Date(T0 + 5 * MIN).toUTCString() });
  await fails(date.account.request('GET', 'a'), ERR.THROTTLED);
  assert.strictEqual(date.account.blockedUntil, T0 + 5 * MIN);

  const junk = setup({ stored: valid() });
  junk.handlers.api = () => reply(429, undefined, { 'Retry-After': 'soon' });
  await fails(junk.account.request('GET', 'a'), ERR.THROTTLED);
  assert.strictEqual(junk.account.blockedUntil, T0 + TIMING.BACKOFF[0]);
});

test('account: 403 on a GET is throttled, 403 on a write is refused', async () => {
  const get = setup({ stored: valid() });
  get.handlers.api = () => reply(403);
  const err = await fails(get.account.request('GET', 'a'), ERR.THROTTLED);
  assert.strictEqual(err.status, 403);
  assert.strictEqual(get.account.blockedUntil, T0 + 2 * MIN);

  for (const method of ['PUT', 'POST']) {
    const write = setup({ stored: valid() });
    write.handlers.api = () => reply(403);
    const refused = await fails(write.account.request(method, 'b', { body: {} }), ERR.REFUSED);
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(write.account.blockedUntil, 0);
    await write.account.request(method, 'b', { body: {} }).catch(() => null);
    assert.strictEqual(write.calls.length, 2, 'not blocked after a refusal');
  }
});

test('account: no fetch while blocked', async () => {
  const h = setup({ stored: valid() });
  h.handlers.api = () => reply(429);
  await fails(h.account.request('GET', 'a'), ERR.THROTTLED);
  const blockedUntil = h.account.blockedUntil;
  await h.clock.advance(MIN);
  for (const method of ['GET', 'PUT', 'POST']) {
    const err = await fails(h.account.request(method, 'b'), ERR.THROTTLED);
    assert.strictEqual(err.sent, false);
    assert.strictEqual(err.retryAt, blockedUntil);
    assert.strictEqual(err.status, null);
  }
  assert.strictEqual(h.calls.length, 1);

  // a throttled sign-in blocks too; the request itself was never sent
  const login = setup();
  login.handlers.signin = () => reply(429);
  const err = await fails(login.account.request('PUT', 'a'), ERR.THROTTLED);
  assert.strictEqual(err.sent, false);
  await fails(login.account.request('GET', 'b'), ERR.THROTTLED);
  assert.strictEqual(login.calls.length, 1);
  assert.strictEqual(login.account.rejected, false);
});

test('account: GET budget of 3 per minute counts the sign-in; waits up to 30 s, else throttled', async () => {
  const h = setup();
  await h.account.request('GET', 'a'); // sign-in + GET
  await h.account.request('GET', 'b');
  const err = await fails(h.account.request('GET', 'c'), ERR.THROTTLED);
  assert.strictEqual(err.sent, false);
  assert.strictEqual(err.retryAt, T0 + MIN);
  assert.strictEqual(h.account.blockedUntil, 0, 'own budget does not block');
  assert.strictEqual(h.calls.length, 3);
  assert.ok(h.logs.includes('budget used up, retry in 60 s'));

  // a write has its own window
  await h.account.request('PUT', 'd');
  assert.strictEqual(h.calls.length, 4);

  await h.clock.advance(35 * SEC);
  let done = false;
  const waiting = h.account.request('GET', 'c').then(json => {
    done = true;
    return json;
  });
  await h.clock.advance(24 * SEC);
  assert.strictEqual(done, false);
  assert.strictEqual(h.calls.length, 4);
  await h.clock.advance(1 * SEC);
  assert.deepStrictEqual(await waiting, { ok: true });
  assert.strictEqual(h.calls[4].at, T0 + MIN);
  assert.ok(h.logs.includes('budget wait 25 s'));
});

test('account: write budget of 5 per minute', async () => {
  const h = setup({ stored: valid() });
  for (let i = 0; i < 5; i++) await h.account.request(i % 2 ? 'PUT' : 'POST', 'w');
  const err = await fails(h.account.request('PUT', 'w'), ERR.THROTTLED);
  assert.strictEqual(err.sent, false);
  assert.strictEqual(err.retryAt, T0 + MIN);
  await h.account.request('GET', 'g');
  assert.strictEqual(h.calls.length, 6);

  await h.clock.advance(30 * SEC);
  const waiting = h.account.request('PUT', 'w');
  await h.clock.advance(30 * SEC);
  await waiting;
  assert.strictEqual(h.calls.length, 7);
  assert.strictEqual(h.calls[6].at, T0 + MIN);
});

test('account: a fetch that hangs times out after FETCH_TIMEOUT and is aborted', async () => {
  const h = setup({ stored: valid() });
  let signal = null;
  h.handlers.api = call => {
    signal = call.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  let result = null;
  h.account.request('GET', 'a').then(() => assert.fail('expected timeout'), err => { result = err; });
  await h.clock.advance(TIMING.FETCH_TIMEOUT - 1);
  assert.strictEqual(result, null);
  assert.strictEqual(signal.aborted, false);
  await h.clock.advance(1);
  allErrors.push(result);
  assert.ok(result instanceof WallboxError);
  assert.strictEqual(result.code, ERR.TIMEOUT);
  assert.strictEqual(result.sent, true);
  assert.strictEqual(signal.aborted, true);
  assert.strictEqual(h.clock.pending(), 0);
});

test('account: a body that never arrives also times out', async () => {
  const h = setup({ stored: valid() });
  h.handlers.api = () => ({ status: 200, ok: true, headers: { get: () => null }, text: () => new Promise(() => {}) });
  let result = null;
  h.account.request('GET', 'a').then(() => assert.fail('expected timeout'), err => { result = err; });
  await h.clock.advance(TIMING.FETCH_TIMEOUT);
  allErrors.push(result);
  assert.strictEqual(result && result.code, ERR.TIMEOUT);
});

test('account: network errors give network', async () => {
  const h = setup({ stored: valid() });
  h.handlers.api = () => { throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND api.wall-box.com ${EMAIL}`); };
  const err = await fails(h.account.request('GET', 'a'), ERR.NETWORK);
  assert.strictEqual(err.message, 'Wallbox cloud not reachable');
  assert.strictEqual(err.status, null);

  const login = setup();
  login.handlers.signin = async () => { throw new Error('socket hang up'); };
  const failed = await fails(login.account.request('GET', 'a'), ERR.NETWORK);
  assert.strictEqual(failed.sent, false);
});

test('account: other statuses give http, unparseable 2xx gives bad_response', async () => {
  const h = setup({ stored: valid() });
  h.handlers.api = () => reply(500, { error: 'boom' });
  const err = await fails(h.account.request('GET', 'a'), ERR.HTTP);
  assert.strictEqual(err.status, 500);
  assert.strictEqual(err.message, 'Wallbox request failed (500)');
  assert.strictEqual(String(err), 'WallboxError: Wallbox request failed (500)');
  assert.strictEqual(h.account.blockedUntil, 0);

  h.handlers.api = () => reply(404);
  assert.strictEqual((await fails(h.account.request('PUT', 'b'), ERR.HTTP)).status, 404);

  h.handlers.api = () => reply(200, '<html>maintenance</html>');
  const bad = await fails(h.account.request('GET', 'c'), ERR.BAD_RESPONSE);
  assert.strictEqual(bad.status, 200);

  const login = setup();
  login.handlers.signin = () => reply(200, { data: { attributes: {} } });
  await fails(login.account.request('GET', 'a'), ERR.BAD_RESPONSE);
  assert.strictEqual(login.stored, null);
});

test('errors: WallboxError fields and messages', () => {
  const err = new WallboxError(ERR.HTTP, { status: 500 });
  assert.ok(err instanceof Error);
  assert.strictEqual(err.name, 'WallboxError');
  assert.strictEqual(err.message, 'Wallbox request failed (500)');
  assert.strictEqual(err.code, 'http');
  assert.strictEqual(err.status, 500);
  assert.strictEqual(err.retryAt, null);
  assert.strictEqual(err.sent, true);
  const throttled = new WallboxError(ERR.THROTTLED, { retryAt: 5, sent: false });
  assert.strictEqual(throttled.message, 'Wallbox is busy (too many requests)');
  assert.strictEqual(throttled.status, null);
  assert.strictEqual(throttled.retryAt, 5);
  assert.strictEqual(throttled.sent, false);
  assert.strictEqual(new WallboxError(ERR.TIMEOUT, { message: 'custom' }).message, 'custom');
  for (const code of Object.values(ERR)) {
    const message = new WallboxError(code).message;
    assert.ok(message.startsWith('Wallbox '), code);
    assert.ok(!/error:/i.test(message), code);
  }
});

test('registry: one Account per e-mail, case and space insensitive', () => {
  let created = 0;
  const registry = new AccountRegistry({
    create: (username, password) => {
      created++;
      return new Account({ username, password, fetch: async () => reply(200), now: () => T0, timers: TIMERS });
    }
  });
  const a = registry.get(' Secret.Person@Example.ORG ', PASS);
  const b = registry.get(EMAIL.toLowerCase(), 'other');
  assert.ok(a instanceof Account);
  assert.strictEqual(a, b);
  assert.strictEqual(created, 1);
  assert.strictEqual(registry.key(EMAIL), crypto.createHash('sha256').update(EMAIL.toLowerCase()).digest('hex'));
  assert.strictEqual(registry.key(` ${EMAIL.toUpperCase()}\t`), registry.key(EMAIL));
  assert.ok(!registry.key(EMAIL).includes('secret'));
  const c = registry.get(EMAIL2, PASS2);
  assert.notStrictEqual(c, a);
  assert.strictEqual(registry.get(EMAIL2, PASS2), c);
  assert.strictEqual(created, 2);
});

test('account: charger slots are the index in the sorted registered ids', () => {
  const account = new Account({ username: EMAIL, password: PASS, fetch: async () => reply(200), now: () => T0, timers: TIMERS });
  assert.strictEqual(account.chargerCount, 0);
  for (const id of ['b', 'a', 'c', 'a']) account.register(id);
  assert.strictEqual(account.chargerCount, 3);
  assert.deepStrictEqual(['a', 'b', 'c'].map(id => account.slot(id)), [0, 1, 2]);
  account.unregister('a');
  assert.strictEqual(account.chargerCount, 2);
  assert.strictEqual(account.slot('b'), 0);
  assert.strictEqual(account.slot('a'), -1);

  const numeric = new Account({ username: EMAIL, password: PASS, fetch: async () => reply(200), now: () => T0, timers: TIMERS });
  numeric.register(100);
  numeric.register(20);
  numeric.register('20');
  numeric.register(3);
  assert.strictEqual(numeric.chargerCount, 3);
  assert.deepStrictEqual([3, 20, 100].map(id => numeric.slot(id)), [0, 1, 2]);
  assert.strictEqual(numeric.slot('100'), 2);
});

test('account: no secrets in any error message or log line', async () => {
  // one more round of everything that logs
  const h = setup({ stored: valid({ jwtTtl: T0 - MIN }) });
  h.handlers.refresh = () => reply(401);
  await h.account.request('GET', 'a');
  h.handlers.api = () => reply(429);
  await h.account.request('GET', 'a').catch(err => allErrors.push(err));
  await h.account.request('GET', 'a').catch(err => allErrors.push(err));

  const lines = allLogs.flat();
  assert.ok(lines.length > 20, `${lines.length} log lines`);
  assert.ok(allErrors.length > 20, `${allErrors.length} errors`);
  for (const line of lines) {
    assert.strictEqual(typeof line, 'string');
    for (const secret of SECRETS) assert.ok(!line.toLowerCase().includes(secret.toLowerCase()), `log line "${line}" holds "${secret}"`);
  }
  for (const err of allErrors)
    for (const text of [err.message, String(err)])
      for (const secret of SECRETS) assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `error "${text}" holds "${secret}"`);
});

test('account: sign-in 403 is a throttle at first, the third in a row means a rejected login', async () => {
  const h = setup();
  h.handlers.signin = () => reply(403);
  const first = await fails(h.account.request('GET', 'a'), ERR.THROTTLED);
  assert.strictEqual(h.account.rejected, false);
  await h.clock.advance(first.retryAt - h.clock.now());
  await fails(h.account.request('GET', 'b'), ERR.THROTTLED);
  assert.strictEqual(h.account.rejected, false);
  await h.clock.advance(h.account.blockedUntil - h.clock.now());
  await fails(h.account.request('GET', 'c'), ERR.AUTH_REJECTED);
  assert.strictEqual(h.account.rejected, true);
});

test('account: a sign-in 403 count is reset by a good sign-in', async () => {
  const h = setup();
  h.handlers.signin = () => reply(403);
  const first = await fails(h.account.request('GET', 'a'), ERR.THROTTLED);
  await h.clock.advance(first.retryAt - h.clock.now());
  h.handlers.signin = () => reply(200, tokenBody('tok-1', 'rft-1', { ttl: h.clock.now() + 60 * 1000 + 1, refresh_token_ttl: h.clock.now() + 1 }));
  await h.account.request('GET', 'b');
  await h.clock.advance(2 * 60 * 1000);
  h.handlers.signin = () => reply(403);
  for (let i = 0; i < 2; i++) {
    const err = await fails(h.account.request('GET', `c${i}`), ERR.THROTTLED);
    await h.clock.advance(err.retryAt - h.clock.now());
  }
  assert.strictEqual(h.account.rejected, false);
});

test('account: Retry-After is capped at an hour', async () => {
  const h = setup({ stored: valid() });
  h.handlers.api = () => reply(429, null, { 'retry-after': String(24 * 3600) });
  await fails(h.account.request('GET', 'a'), ERR.THROTTLED);
  assert.strictEqual(h.account.blockedUntil - h.clock.now(), 60 * MIN);
});

test('account: verifyCredentials with a wrong password changes nothing', async () => {
  const h = setup({ stored: valid() });
  h.handlers.signin = () => reply(401);
  await fails(h.account.verifyCredentials(EMAIL2, 'typo'), ERR.AUTH_REJECTED);
  assert.strictEqual(h.account.rejected, false);
  await h.account.request('GET', 'a');
  assert.strictEqual(h.calls[h.calls.length - 1].auth, 'Bearer tok-old');
});

test('account: verifyCredentials with the right password takes the new login and tokens', async () => {
  const h = setup();
  h.handlers.signin = () => reply(401);
  await fails(h.account.request('GET', 'a'), ERR.AUTH_REJECTED);
  assert.strictEqual(h.account.rejected, true);
  h.handlers.signin = () => reply(200, tokenBody('tok-new', 'rft-new', { ttl: h.clock.now() + 15 * MIN, refresh_token_ttl: h.clock.now() + DAY }));
  await h.account.verifyCredentials(EMAIL2, PASS2);
  assert.strictEqual(h.account.rejected, false);
  const signins = h.calls.filter(call => call.kind === 'signin').length;
  await h.account.request('GET', 'b');
  assert.strictEqual(h.calls.filter(call => call.kind === 'signin').length, signins, 'no extra sign-in');
  assert.strictEqual(h.calls[h.calls.length - 1].auth, 'Bearer tok-new');
});

test('errorMessage: one text for cards and pairing (changed: a card showed "-" without an HTTP status, now the code)', () => {
  const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
  assert.strictEqual(errorMessage(new WallboxError(ERR.THROTTLED, { retryAt: T0 + 90 * SEC }), t, T0), `${MSG.BUSY} {"minutes":2}`);
  assert.strictEqual(errorMessage(new WallboxError(ERR.THROTTLED), t, T0), `${MSG.BUSY} {"minutes":1}`);
  assert.strictEqual(errorMessage(new WallboxError(ERR.AUTH_REJECTED, { status: 401 }), t, T0), MSG.LOGIN);
  assert.strictEqual(errorMessage(new WallboxError(ERR.REFUSED, { status: 403 }), t, T0), MSG.REFUSED);
  assert.strictEqual(errorMessage(new WallboxError(ERR.TIMEOUT), t, T0), MSG.TIMEOUT);
  assert.strictEqual(errorMessage(new WallboxError(ERR.NETWORK), t, T0), MSG.NETWORK);
  assert.strictEqual(errorMessage(new WallboxError(ERR.HTTP, { status: 500 }), t, T0), `${MSG.FAILED} {"status":500}`);
  assert.strictEqual(errorMessage(new WallboxError(ERR.BAD_RESPONSE), t, T0), `${MSG.FAILED} {"status":"${ERR.BAD_RESPONSE}"}`);
  assert.strictEqual(errorMessage(new TypeError('x'), t, T0), `${MSG.FAILED} {"status":"-"}`);
});

test('registry: release drops an account without chargers, and its stored tokens (changed: tokens stayed after the last device was deleted)', async () => {
  const saved = [];
  const registry = new AccountRegistry({
    create: (username, password) => new Account({
      username,
      password,
      fetch: async () => reply(200),
      now: () => T0,
      timers: TIMERS,
      persist: { load: () => null, save: tokens => saved.push(tokens) }
    })
  });
  const account = registry.get(EMAIL, PASS);
  account.register('1');
  assert.strictEqual(await registry.release(account), false, 'a charger left: kept');
  assert.deepStrictEqual(saved, []);
  account.unregister('1');
  assert.strictEqual(await registry.release(account), true);
  assert.deepStrictEqual(saved, [null], 'stored tokens removed');
  assert.notStrictEqual(registry.get(EMAIL, PASS), account, 'a new pairing gets a fresh Account');
});

test('account: a 403 on a status GET backs off that charger only, the account goes on (changed: blocked the whole account)', async () => {
  const h = setup({ stored: valid() });
  h.handlers.api = call => (call.url.endsWith('status/2') ? reply(403) : reply(200, { status_id: 194 }));
  const err = await fails(h.account.request('GET', 'chargers/status/2', { charger: 2 }), ERR.THROTTLED);
  assert.deepStrictEqual([err.status, err.charger, err.retryAt], [403, true, T0 + 2 * MIN]);
  assert.strictEqual(h.account.blockedUntil, 0, 'account not blocked');
  await h.account.request('GET', 'chargers/status/1', { charger: 1 });
  await h.account.request('PUT', 'v2/charger/1', { body: { locked: 1 } });
  const before = h.calls.length;
  const blocked = await fails(h.account.request('GET', 'chargers/status/2', { charger: 2 }), ERR.THROTTLED);
  assert.deepStrictEqual([blocked.sent, blocked.charger], [false, true]);
  assert.strictEqual(h.calls.length, before, 'no fetch for that charger while it backs off');
  await h.clock.advance(2 * MIN);
  const again = await fails(h.account.request('GET', 'chargers/status/2', { charger: 2 }), ERR.THROTTLED);
  assert.strictEqual(again.retryAt, h.clock.now() + 4 * MIN, 'its own back-off rises');
  h.handlers.api = () => reply(200, { status_id: 194 });
  await h.clock.advance(4 * MIN);
  await h.account.request('GET', 'chargers/status/2', { charger: 2 });
  h.handlers.api = call => (call.url.endsWith('status/2') ? reply(403) : reply(200, {}));
  const reset = await fails(h.account.request('GET', 'chargers/status/2', { charger: 2 }), ERR.THROTTLED);
  assert.strictEqual(reset.retryAt, h.clock.now() + 2 * MIN, 'a good answer resets it');
});

test('account: verifyCredentials takes a first sign-in 403 as a throttle, like a background sign-in (changed: was a wrong password at once)', async () => {
  const h = setup();
  h.handlers.signin = () => reply(403);
  await fails(h.account.verifyCredentials(EMAIL, PASS), ERR.THROTTLED);
  assert.ok(h.account.blockedUntil > T0, 'backs off');
  await h.clock.advance(15 * MIN);
  await fails(h.account.verifyCredentials(EMAIL, PASS), ERR.THROTTLED);
  await h.clock.advance(15 * MIN);
  await fails(h.account.verifyCredentials(EMAIL, PASS), ERR.AUTH_REJECTED);
});

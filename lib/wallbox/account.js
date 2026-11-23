'use strict';

const crypto = require('crypto');
const { ERR, TIMING } = require('../contract');
const { WallboxError } = require('./errors');

/**
 * Base URLs per `host` option of Account.request
 */
const HOSTS = Object.freeze({
  api: 'https://api.wall-box.com/',
  user: 'https://user-api.wall-box.com/'
});

const SIGN_IN = 'users/signin';
const REFRESH = 'users/refresh-token';

/**
 * A token is used while it is valid for at least this long, else renewed
 */
const TOKEN_MARGIN = 60 * 1000;
const SIGN_IN_FORBIDDEN_LIMIT = 3; // sign-in 403s in a row before the login counts as rejected
const MAX_RETRY_AFTER = 60 * 60 * 1000; // cap on Retry-After

const BASE_HEADERS = Object.freeze({
  Accept: 'application/json',
  Partner: 'wallbox',
  'Content-Type': 'application/json;charset=UTF-8'
});

/**
 * Epoch ms from a TTL in epoch ms or epoch s (a value under 1e12); 0 when missing
 *
 * @param {*} value
 * @returns {number}
 */
function epochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Delay in ms from a Retry-After header (seconds or an HTTP date), null when missing or unreadable
 *
 * @param {string|null} value
 * @param {number} now - ms
 * @returns {number|null}
 */
function retryAfterMs(value, now) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '') return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Parsed JSON body; null for an empty body
 *
 * @param {string} text
 * @param {number} status
 * @returns {*}
 */
function parseBody(text, status) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new WallboxError(ERR.BAD_RESPONSE, { status });
  }
}

/**
 * Tokens from a sign-in or refresh response. A response without a refresh
 * token keeps the previous one.
 *
 * @param {*} json
 * @param {Object|null} prev - current tokens
 * @returns {Object|null} { jwt, jwtTtl, refresh, refreshTtl }, null when there is no token
 */
function tokensFrom(json, prev) {
  const a = json && json.data && json.data.attributes;
  if (!a || typeof a.token !== 'string' || a.token === '') return null;
  const hasRefresh = typeof a.refresh_token === 'string' && a.refresh_token !== '';
  return {
    jwt: a.token,
    jwtTtl: epochMs(a.ttl),
    refresh: hasRefresh ? a.refresh_token : (prev ? prev.refresh : null),
    refreshTtl: hasRefresh ? epochMs(a.refresh_token_ttl) : (prev ? prev.refreshTtl : 0)
  };
}

/**
 * Stored tokens checked for shape; null when unusable
 *
 * @param {*} raw
 * @returns {Object|null}
 */
function storedTokens(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.jwt !== 'string' || raw.jwt === '') return null;
  return {
    jwt: raw.jwt,
    jwtTtl: epochMs(raw.jwtTtl),
    refresh: typeof raw.refresh === 'string' && raw.refresh !== '' ? raw.refresh : null,
    refreshTtl: epochMs(raw.refreshTtl)
  };
}

/**
 * Charger id order: numeric ids by value, else as text
 */
function compareIds(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * One client per Wallbox account: tokens, request budget, back-off and
 * timeouts. All Wallbox traffic of the account goes through `request`.
 */
class Account {

  /**
   * @param {Object} options
   * @param {string} options.username - e-mail
   * @param {string} options.password
   * @param {Function} [options.fetch] - fetch(url, { method, headers, body, signal }) → { status, ok, headers.get(name), text() }
   * @param {Function} [options.now] - time in ms
   * @param {Object} [options.timers] - { setTimeout(fn, ms), clearTimeout(handle) }
   * @param {Object} [options.persist] - { load() → tokens|null, save(tokens|null) }, may return promises
   * @param {Function} [options.log] - log(message)
   * @param {string} [options.userAgent]
   */
  constructor({ username, password, fetch, now, timers, persist, log, userAgent } = {}) {
    this._fetch = fetch || globalThis.fetch;
    if (typeof this._fetch !== 'function') throw new TypeError('fetch is required');
    this._now = now || Date.now;
    this._timers = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle) };
    this._persist = persist || null;
    this._log = log || (() => {});
    this._userAgent = userAgent || 'Homey-Wallbox';
    this._setUser(username, password);

    /** true after a sign-in was rejected; no sign-ins until verifyCredentials (repair) */
    this.rejected = false;
    /** ms; requests are not sent before this time (0 when free) */
    this.blockedUntil = 0;

    this._tokens = null;
    this._loading = null;
    this._renewing = null;
    this._generation = 0;
    this._level = 0;
    this._signInForbidden = 0; // sign-in 403s in a row
    this._windows = { get: [], write: [] };
    this._chargers = new Set();
  }

  /**
   * Signs in with these credentials and only then uses them, with the new
   * tokens. A wrong password changes nothing, so a typo during pairing or
   * repair can't block the chargers of the account.
   *
   * @param {string} username
   * @param {string} password
   * @throws {WallboxError} auth_rejected, throttled, timeout, network, http
   */
  async verifyCredentials(username, password) {
    const user = String(username || '').trim();
    const basic = Buffer.from(`${user}:${String(password || '')}`, 'utf8').toString('base64');
    const res = await this._send('GET', HOSTS.user + SIGN_IN, `Basic ${basic}`);
    if (res.status === 401 || res.status === 403) {
      this._log('login rejected');
      throw new WallboxError(ERR.AUTH_REJECTED, { status: res.status });
    }
    if (!res.ok) throw new WallboxError(ERR.HTTP, { status: res.status });
    const tokens = tokensFrom(parseBody(res.text, res.status), null);
    if (!tokens) throw new WallboxError(ERR.BAD_RESPONSE, { status: res.status });

    this._setUser(user, password);
    this._generation++;
    this._loading = Promise.resolve();
    this._renewing = null;
    this.rejected = false;
    this._signInForbidden = 0;
    this._tokens = tokens;
    await this._save(tokens);
    this._log('signed in');
  }

  /**
   * Sends a request to Wallbox. Signs in, refreshes and persists tokens by
   * itself; on a 401 it renews the token once and retries once.
   *
   * @param {string} method - GET, PUT or POST
   * @param {string} path - relative to the host, e.g. 'v2/charger/123'
   * @param {Object} [options]
   * @param {*} [options.body] - sent as JSON
   * @param {string} [options.host] - 'api' (default) or 'user'
   * @returns {Promise<*>} the parsed JSON, null for an empty body
   * @throws {WallboxError} `sent: false` when the request never reached fetch
   */
  async request(method, path, { body, host = 'api' } = {}) {
    if (!Object.prototype.hasOwnProperty.call(HOSTS, host)) throw new TypeError('unknown host');
    const base = HOSTS[host];
    const verb = String(method).toUpperCase();
    const url = base + path;

    let jwt;
    try {
      jwt = await this._token(null);
    } catch (err) {
      if (err instanceof WallboxError) err.sent = false;
      throw err;
    }
    let res = await this._send(verb, url, `Bearer ${jwt}`, body);
    if (res.status === 401) {
      this._log('token rejected, renewing');
      jwt = await this._token(jwt);
      res = await this._send(verb, url, `Bearer ${jwt}`, body);
    }

    if (res.ok) return parseBody(res.text, res.status);
    if (res.status === 403) {
      if (verb === 'GET') throw this._throttle(res);
      throw new WallboxError(ERR.REFUSED, { status: 403 });
    }
    throw new WallboxError(ERR.HTTP, { status: res.status });
  }

  /**
   * Adds a charger of this account (for chargerCount and slot)
   *
   * @param {string|number} chargerId
   */
  register(chargerId) {
    this._chargers.add(String(chargerId));
  }

  /**
   * Removes a charger of this account
   *
   * @param {string|number} chargerId
   */
  unregister(chargerId) {
    this._chargers.delete(String(chargerId));
  }

  /**
   * Number of registered chargers
   *
   * @returns {number}
   */
  get chargerCount() {
    return this._chargers.size;
  }

  /**
   * Index of the charger in the sorted registered ids, to stagger polls
   *
   * @param {string|number} chargerId
   * @returns {number} -1 when not registered
   */
  slot(chargerId) {
    return [...this._chargers].sort(compareIds).indexOf(String(chargerId));
  }

  _setUser(username, password) {
    this._username = String(username || '').trim();
    this._password = String(password || '');
  }

  /**
   * Loads the persisted tokens once, on first use
   */
  _load() {
    if (!this._loading) {
      const generation = this._generation;
      this._loading = (async () => {
        let raw = null;
        try {
          raw = this._persist ? await this._persist.load() : null;
        } catch (err) {
          this._log('token load failed');
        }
        if (generation === this._generation && !this._tokens) this._tokens = storedTokens(raw);
      })();
    }
    return this._loading;
  }

  async _save(tokens) {
    if (!this._persist) return;
    try {
      await this._persist.save(tokens ? { ...tokens } : null);
    } catch (err) {
      this._log('token save failed');
    }
  }

  /**
   * A usable token. One sign-in or refresh at a time: concurrent callers
   * share the same promise.
   *
   * @param {string|null} stale - token Wallbox just rejected
   * @returns {Promise<string>}
   */
  async _token(stale) {
    await this._load();
    if (this._renewing) return this._renewing;
    const tokens = this._tokens;
    if (tokens && tokens.jwt !== stale && tokens.jwtTtl - this._now() >= TOKEN_MARGIN) return tokens.jwt;
    const renewing = this._renew().finally(() => {
      if (this._renewing === renewing) this._renewing = null;
    });
    this._renewing = renewing;
    return renewing;
  }

  /**
   * Refreshes the token while the refresh token is valid, else signs in
   *
   * @returns {Promise<string>} the new token
   */
  async _renew() {
    const generation = this._generation;
    if (this.rejected) throw new WallboxError(ERR.AUTH_REJECTED, { sent: false });

    const old = this._tokens;
    if (old && old.refresh && old.refreshTtl - this._now() >= TOKEN_MARGIN) {
      const res = await this._send('GET', HOSTS.user + REFRESH, `Bearer ${old.refresh}`);
      if (res.ok) return this._keep(generation, tokensFrom(parseBody(res.text, res.status), old), res.status, 'token refreshed');
      if (res.status !== 401 && res.status !== 403) throw new WallboxError(ERR.HTTP, { status: res.status });
      this._log('refresh rejected, signing in');
    }

    const basic = Buffer.from(`${this._username}:${this._password}`, 'utf8').toString('base64');
    const res = await this._send('GET', HOSTS.user + SIGN_IN, `Basic ${basic}`);
    if (res.ok) {
      this._signInForbidden = 0;
      return this._keep(generation, tokensFrom(parseBody(res.text, res.status), null), res.status, 'signed in');
    }
    // Wallbox also throttles with 403: only a 401, or 403s in a row, mean a wrong password
    if (res.status === 403 && ++this._signInForbidden < SIGN_IN_FORBIDDEN_LIMIT)
      throw this._throttle(res);
    if (res.status === 401 || res.status === 403) {
      this._log('login rejected');
      // credentials changed meanwhile: don't block the new ones
      if (generation === this._generation) {
        this.rejected = true;
        this._tokens = null;
        await this._save(null);
      }
      throw new WallboxError(ERR.AUTH_REJECTED, { status: res.status });
    }
    throw new WallboxError(ERR.HTTP, { status: res.status });
  }

  async _keep(generation, tokens, status, message) {
    if (!tokens) throw new WallboxError(ERR.BAD_RESPONSE, { status });
    this._log(message);
    if (generation === this._generation) {
      this._tokens = tokens;
      await this._save(tokens);
    }
    return tokens.jwt;
  }

  /**
   * Waits for budget, then fetches with a timeout. A 429 throws `throttled`.
   *
   * @returns {Promise<Object>} { status, ok, headers, text }
   */
  async _send(method, url, authorization, body) {
    await this._gate(method);

    const options = {
      method,
      headers: { ...BASE_HEADERS, 'User-Agent': this._userAgent, Authorization: authorization }
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const Abort = globalThis.AbortController;
    const controller = typeof Abort === 'function' ? new Abort() : null;
    if (controller) options.signal = controller.signal;

    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = this._timers.setTimeout(() => {
        timer = null;
        if (controller) controller.abort();
        reject(new WallboxError(ERR.TIMEOUT));
      }, TIMING.FETCH_TIMEOUT);
    });

    let res;
    try {
      res = await Promise.race([this._fetch(url, options), timeout]);
      const status = Number(res.status);
      const ok = status >= 200 && status < 300;
      const text = await Promise.race([res.text(), timeout]).catch(err => {
        if (ok) throw err;
        return '';
      });
      res = { status, ok, headers: res.headers, text };
    } catch (err) {
      if (err instanceof WallboxError) throw err;
      throw new WallboxError(ERR.NETWORK);
    } finally {
      if (timer !== null) this._timers.clearTimeout(timer);
    }

    if (res.ok) this._level = 0;
    if (res.status === 429) throw this._throttle(res);
    return res;
  }

  /**
   * Throws while blocked; takes a slot in the budget window, waiting up to
   * TIMING.BUDGET_WAIT for one
   */
  async _gate(method) {
    const kind = method === 'GET' ? 'get' : 'write';
    const budget = kind === 'get' ? TIMING.GET_BUDGET : TIMING.WRITE_BUDGET;
    const window = this._windows[kind];
    const deadline = this._now() + TIMING.BUDGET_WAIT;
    for (;;) {
      const now = this._now();
      if (now < this.blockedUntil) throw new WallboxError(ERR.THROTTLED, { retryAt: this.blockedUntil, sent: false });
      while (window.length > 0 && window[0] <= now - budget.per) window.shift();
      if (window.length < budget.count) {
        window.push(now);
        return;
      }
      const freeAt = window[window.length - budget.count] + budget.per;
      const seconds = Math.ceil((freeAt - now) / 1000);
      if (freeAt > deadline) {
        this._log(`budget used up, retry in ${seconds} s`);
        throw new WallboxError(ERR.THROTTLED, { retryAt: freeAt, sent: false });
      }
      this._log(`budget wait ${seconds} s`);
      await new Promise(resolve => this._timers.setTimeout(resolve, freeAt - now));
    }
  }

  /**
   * Blocks the account after a throttle response
   *
   * @returns {WallboxError} throttled
   */
  _throttle(res) {
    const now = this._now();
    const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    const retryAfter = retryAfterMs(header, now);
    const backoff = TIMING.BACKOFF[Math.min(this._level, TIMING.BACKOFF.length - 1)];
    this._level = Math.min(this._level + 1, TIMING.BACKOFF.length);
    this.blockedUntil = now + (retryAfter === null ? backoff : Math.min(retryAfter, MAX_RETRY_AFTER));
    this._log(`throttled (${res.status}) until ${new Date(this.blockedUntil).toISOString()}`);
    return new WallboxError(ERR.THROTTLED, { status: res.status, retryAt: this.blockedUntil });
  }

}

/**
 * One Account per Wallbox account, shared by its chargers
 */
class AccountRegistry {

  /**
   * @param {Object} options
   * @param {Function} options.create - create(username, password) → Account
   */
  constructor({ create }) {
    this._create = create;
    this._accounts = new Map();
  }

  /**
   * Key of an account: sha256 of the trimmed, lower-case e-mail
   *
   * @param {string} username
   * @returns {string} hex
   */
  key(username) {
    return crypto.createHash('sha256').update(String(username || '').trim().toLowerCase()).digest('hex');
  }

  /**
   * The Account of this e-mail; created on first use
   *
   * @param {string} username
   * @param {string} password - used only when the Account is created
   * @returns {Account}
   */
  get(username, password) {
    const key = this.key(username);
    let account = this._accounts.get(key);
    if (!account) {
      account = this._create(username, password);
      this._accounts.set(key, account);
    }
    return account;
  }

}

module.exports = { Account, AccountRegistry, HOSTS };

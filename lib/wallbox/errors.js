'use strict';

const { ERR, MSG } = require('../contract');

/**
 * Fixed message per code. Never put an e-mail, password, token, serial or URL
 * in a message: they end up in logs and flow card errors.
 */
const TEXT = Object.freeze({
  [ERR.THROTTLED]: 'Wallbox is busy (too many requests)',
  [ERR.AUTH_REJECTED]: 'Wallbox login rejected',
  [ERR.REFUSED]: 'Wallbox refused the request',
  [ERR.TIMEOUT]: 'Wallbox did not answer in time',
  [ERR.NETWORK]: 'Wallbox cloud not reachable',
  [ERR.HTTP]: 'Wallbox request failed',
  [ERR.BAD_RESPONSE]: 'Wallbox sent an unexpected response'
});

/**
 * Error of the Wallbox client (lib/wallbox/account.js, api.js).
 */
class WallboxError extends Error {

  /**
   * @param {string} code - an ERR id
   * @param {Object} [options]
   * @param {number|null} [options.status] - HTTP status, null when there is none
   * @param {number|null} [options.retryAt] - ms, for `throttled`: when a retry may work
   * @param {boolean} [options.sent] - false when the request never reached fetch
   * @param {boolean} [options.charger] - `throttled` for this charger only (its status GET got a 403)
   * @param {string} [options.message] - replaces the default message; must hold no secrets
   */
  constructor(code, { status = null, retryAt = null, sent = true, charger = false, message } = {}) {
    const text = TEXT[code] || 'Wallbox error';
    super(message || (status === null || status === undefined ? text : `${text} (${status})`));
    this.name = 'WallboxError';
    this.code = code;
    this.status = status === undefined ? null : status;
    this.retryAt = retryAt === undefined ? null : retryAt;
    this.sent = sent !== false;
    this.charger = charger === true;
  }

}

// Message key (locales) per code, for cards and pairing
const MESSAGE = Object.freeze({
  [ERR.REFUSED]: MSG.REFUSED,
  [ERR.AUTH_REJECTED]: MSG.LOGIN,
  [ERR.TIMEOUT]: MSG.TIMEOUT,
  [ERR.NETWORK]: MSG.NETWORK
});

/**
 * Translated message for a failed request, shown to the user
 *
 * @param {Error} error - a WallboxError, or any other error
 * @param {Function} t - (key, vars) → text, homey.__
 * @param {number} now - ms, for the minutes of a back-off
 * @return {string}
 */
function errorMessage(error, t, now) {
  const code = error && error.code;
  if (code === ERR.THROTTLED)
    return t(MSG.BUSY, { minutes: Math.max(1, Math.ceil(((error.retryAt || 0) - now) / 60000)) });
  if (MESSAGE[code])
    return t(MESSAGE[code]);
  // The HTTP status, else the code (no secrets in either)
  return t(MSG.FAILED, { status: error && error.status != null ? error.status : code || '-' });
}

module.exports = { WallboxError, errorMessage };

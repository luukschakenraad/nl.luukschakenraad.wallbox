'use strict';

const { ERR } = require('../contract');

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
   * @param {string} [options.message] - replaces the default message; must hold no secrets
   */
  constructor(code, { status = null, retryAt = null, sent = true, message } = {}) {
    const text = TEXT[code] || 'Wallbox error';
    super(message || (status === null || status === undefined ? text : `${text} (${status})`));
    this.name = 'WallboxError';
    this.code = code;
    this.status = status === undefined ? null : status;
    this.retryAt = retryAt === undefined ? null : retryAt;
    this.sent = sent !== false;
  }

}

module.exports = { WallboxError };

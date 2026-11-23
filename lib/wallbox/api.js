'use strict';

const { ECO_SMART, ERR } = require('../contract');
const { WallboxError } = require('./errors');

/**
 * Eco-Smart body attributes per ECO_SMART id
 */
const ECO_SMART_ATTRIBUTES = Object.freeze({
  [ECO_SMART.OFF]: Object.freeze({ enabled: 0, mode: 0 }),
  [ECO_SMART.ECO]: Object.freeze({ enabled: 1, mode: 0 }),
  [ECO_SMART.FULL_SOLAR]: Object.freeze({ enabled: 1, mode: 1 })
});

const segment = id => encodeURIComponent(String(id));

/**
 * Wallbox endpoints on top of an Account (lib/wallbox/account.js). Errors are
 * the Account's WallboxErrors.
 */
class WallboxApi {

  /**
   * @param {Object} account - Account, or anything with request(method, path, { body, host })
   */
  constructor(account) {
    this.account = account;
  }

  /**
   * Chargers of the account, over all groups
   *
   * @param {Object} [options]
   * @param {number} [options.deadline] - ms, see Account.request (pairing)
   * @returns {Promise<Array<{id: *, name: string}>>}
   */
  async listChargers({ deadline } = {}) {
    const json = await this.account.request('GET', 'v3/chargers/groups', deadline ? { deadline } : undefined);
    const groups = json && json.result && Array.isArray(json.result.groups) ? json.result.groups : [];
    const seen = new Set();
    const chargers = [];
    const all = groups.flatMap(group => (group && Array.isArray(group.chargers) ? group.chargers : []));
    for (const charger of all) {
      if (!charger || charger.id === undefined || charger.id === null || seen.has(String(charger.id))) continue;
      seen.add(String(charger.id));
      chargers.push({ id: charger.id, name: typeof charger.name === 'string' && charger.name !== '' ? charger.name : String(charger.id) });
    }
    return chargers;
  }

  /**
   * Raw status of a charger. A 403 backs off this charger only.
   *
   * @param {string|number} id - charger id
   * @returns {Promise<Object>} the chargers/status JSON
   * @throws {WallboxError} bad_response for a 2xx that is no charger status (empty, an error object)
   */
  async getStatus(id) {
    const json = await this.account.request('GET', `chargers/status/${segment(id)}`, { charger: id });
    const status = json && typeof json === 'object' && !Array.isArray(json);
    if (!status || (json.status_id === undefined && json.config_data === undefined))
      throw new WallboxError(ERR.BAD_RESPONSE);
    return json;
  }

  /**
   * Sets the maximum charging current, without reading the status first
   *
   * @param {string|number} id - charger id
   * @param {number} amps
   * @returns {Promise<number>} the current Wallbox reports, else the requested amps
   */
  async setCurrent(id, amps) {
    const json = await this.account.request('PUT', `v2/charger/${segment(id)}`, { body: { maxChargingCurrent: amps } });
    const set = json && json.data && json.data.chargerData && json.data.chargerData.maxChargingCurrent;
    return typeof set === 'number' && Number.isFinite(set) ? set : amps;
  }

  /**
   * Locks or unlocks a charger
   *
   * @param {string|number} id - charger id
   * @param {boolean} locked
   * @returns {Promise<void>}
   */
  async setLocked(id, locked) {
    await this.account.request('PUT', `v2/charger/${segment(id)}`, { body: { locked: locked ? 1 : 0 } });
  }

  /**
   * Pauses charging
   *
   * @param {string|number} id - charger id
   * @returns {Promise<void>}
   */
  async pause(id) {
    await this._remoteAction(id, 2);
  }

  /**
   * Resumes charging
   *
   * @param {string|number} id - charger id
   * @returns {Promise<void>}
   */
  async resume(id) {
    await this._remoteAction(id, 1);
  }

  /**
   * Hands charging back to the charger's automations (Eco-Smart, schedule),
   * like Resume in the Wallbox app after a Stop. `resume` (action 1) is the
   * manual start that overrides them.
   *
   * @param {string|number} id - charger id
   * @returns {Promise<void>}
   */
  async resumeAutomations(id) {
    await this._remoteAction(id, 9);
  }

  /**
   * Sets the Eco-Smart (solar charging) mode
   *
   * @param {string|number} id - charger id
   * @param {string} mode - an ECO_SMART id
   * @returns {Promise<void>}
   */
  async setEcoSmart(id, mode) {
    if (!Object.prototype.hasOwnProperty.call(ECO_SMART_ATTRIBUTES, mode)) throw new TypeError('unknown Eco-Smart mode');
    const body = { data: { attributes: { ...ECO_SMART_ATTRIBUTES[mode] }, type: 'eco_smart' } };
    await this.account.request('PUT', `v4/chargers/${segment(id)}/eco-smart`, { body });
  }

  /**
   * Charging session stats in a time range
   *
   * @param {string|number} id - charger id
   * @param {number} start - seconds since epoch
   * @param {number} end - seconds since epoch
   * @returns {Promise<Object>} the raw v4/sessions/stats JSON
   */
  async sessions(id, start, end) {
    const query = `charger=${segment(id)}&start_date=${Math.floor(start)}&end_date=${Math.floor(end)}`;
    return this.account.request('GET', `v4/sessions/stats?${query}`);
  }

  async _remoteAction(id, action) {
    await this.account.request('POST', `v3/chargers/${segment(id)}/remote-action`, { body: { action } });
  }

}

module.exports = { WallboxApi, ECO_SMART_ATTRIBUTES };

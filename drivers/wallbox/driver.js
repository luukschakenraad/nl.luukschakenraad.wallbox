'use strict';

const Homey = require('homey');
const { WallboxApi } = require('../../lib/wallbox/api');
const { ERR, MSG } = require('../../lib/contract');

const MINUTE = 60 * 1000;

/**
 * Wallbox charger driver: pairing and repair. Credentials go in the device
 * store, never in settings or logs.
 */
class WallboxDriver extends Homey.Driver {

  async onInit() {
    this.log('Wallbox driver started');
  }

  /**
   * Pairing: log in, then list the chargers of the account
   *
   * @param {PairSession} session
   */
  async onPair(session) {
    let credentials = null;
    let chargers = [];

    session.setHandler('login', async data => {
      const username = String(data.username || '').trim();
      const password = String(data.password || '');
      const account = this.homey.app.registry.get(username, password);
      chargers = await this.verify(account, username, password);
      credentials = { username, password };
      this.log(`Login ok, ${chargers.length} charger(s)`);
      return true;
    });

    session.setHandler('list_devices', async () => chargers.map(charger => ({
      name: charger.name,
      data: { id: charger.id },
      store: { ...credentials }
    })));
  }

  /**
   * Repair: log in again, then give every device on this account the new
   * credentials and restart the repaired one
   *
   * @param {PairSession} session
   * @param {Device} device - device being repaired
   */
  async onRepair(session, device) {
    session.setHandler('login', async data => {
      const username = String(data.username || '').trim();
      const password = String(data.password || '');
      const registry = this.homey.app.registry;
      const account = registry.get(username, password);
      const chargers = await this.verify(account, username, password);
      if (!chargers.some(charger => String(charger.id) === String(device.getData().id)))
        throw new Error(this.homey.__(MSG.NOT_REACHABLE));

      const key = registry.key(username);
      const others = this.getDevices().filter(other => other !== device && registry.key(other.getStoreValue('username') || '') === key);
      // Without waiting on Homey: a slow store write must not hold up the repair
      for (const target of [device, ...others])
        target.setCredentials(username, password);
      this.log(`Repaired, ${others.length} other device(s) on the account updated`);
      await device.restart();
      return true;
    });
  }

  /**
   * Check the login, then list the chargers. The account only takes the new
   * credentials when Wallbox accepts them, so a typo blocks nothing.
   *
   * @param {Account} account
   * @param {string} username
   * @param {string} password
   * @return {Promise<Array>} chargers of the account, [{ id, name }]
   * @throws {Error} with a translated message
   */
  async verify(account, username, password) {
    try {
      await account.verifyCredentials(username, password);
      return await new WallboxApi(account).listChargers();
    } catch (error) {
      this.log(`Login failed: ${error.code || error.name}`);
      throw new Error(this.errorText(error));
    }
  }

  /**
   * Translated message for a failed request
   *
   * @param {Error} error - a WallboxError, or any other error
   * @return {string}
   */
  errorText(error) {
    const t = (key, vars) => this.homey.__(key, vars);
    switch (error.code) {
      case ERR.AUTH_REJECTED: return t(MSG.LOGIN);
      case ERR.THROTTLED: return t(MSG.BUSY, { minutes: Math.max(1, Math.ceil(((error.retryAt || 0) - Date.now()) / MINUTE)) });
      case ERR.TIMEOUT: return t(MSG.TIMEOUT);
      case ERR.NETWORK: return t(MSG.NETWORK);
      default: return t(MSG.FAILED, { status: error.status || error.code || error.name });
    }
  }

}

module.exports = WallboxDriver;

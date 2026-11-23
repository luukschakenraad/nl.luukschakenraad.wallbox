'use strict';

const Homey = require('homey');
const { WallboxApi } = require('../../lib/wallbox/api');
const { MSG } = require('../../lib/contract');
const { errorMessage } = require('../../lib/wallbox/errors');

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
      // A changed password: the devices already on this account get it too,
      // else after a restart the account could start with the old one
      const others = this.devicesOf(username);
      for (const device of others)
        device.setCredentials(username, password);
      this.log(`Login ok, ${chargers.length} charger(s), ${others.length} device(s) on the account updated`);
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

      const others = this.devicesOf(username).filter(other => other !== device);
      // Without waiting on Homey: a slow store write must not hold up the repair
      for (const target of [device, ...others])
        target.setCredentials(username, password);
      this.log(`Repaired, ${others.length} other device(s) on the account updated`);
      await device.restart();
      return true;
    });
  }

  /**
   * Devices whose store holds this e-mail (one Wallbox account)
   *
   * @param {string} username
   * @return {Array<Device>}
   */
  devicesOf(username) {
    const registry = this.homey.app.registry;
    const key = registry.key(username);
    return this.getDevices().filter(device => registry.key(device.getStoreValue('username') || '') === key);
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
      throw new Error(errorMessage(error, (key, vars) => this.homey.__(key, vars), Date.now()));
    }
  }

}

module.exports = WallboxDriver;

'use strict';

const Homey = require('homey');
const { WallboxApi } = require('../../lib/wallbox/api');
const { parseSnapshot, toView, capabilityValues, transitions } = require('../../lib/charger/view');
const { ChargerController } = require('../../lib/charger/controller');
const { Poller } = require('../../lib/poller');
const { EnergyMeter, sumSessions, showGreen } = require('../../lib/energy');
const { STATUS, ERR, MSG, CAP, MODE, FLOW, TIMING } = require('../../lib/contract');

const SECOND = 1000;

/**
 * Homey adapter of one Wallbox charger. The decisions live in lib/; this
 * class maps them on capabilities, flow triggers, settings and availability.
 */
class WallboxDevice extends Homey.Device {

  async onInit() {
    this.id = this.getData().id;
    this.view = null; // View of the latest poll
    this.optionsText = null; // target_power options last set
    this.timers = {
      setTimeout: (fn, ms) => this.homey.setTimeout(fn, ms),
      clearTimeout: handle => this.homey.clearTimeout(handle)
    };
    this.store = {
      get: key => this.getStoreValue(key),
      set: (key, value) => this.setStoreValue(key, value)
    };

    await this.updateCapabilities();
    if (this.getCapabilityValue(CAP.TARGET_MODE) == null)
      await this.setCapabilityValue(CAP.TARGET_MODE, MODE.DEVICE).catch(error => this.log(`Failed to set ${CAP.TARGET_MODE}: ${error.message}`));

    this.energy = new EnergyMeter({
      fetchSessions: async (start, end) => sumSessions(await this.api.sessions(this.id, start, end), this.id),
      store: this.store,
      log: message => this.log(message),
      now: () => Date.now(),
      timers: this.timers
    });
    this.poller = new Poller({
      run: () => this.poll(),
      timers: this.timers,
      now: () => Date.now(),
      log: message => this.log(message)
    });

    this.registerCapabilityListener(CAP.LOCKED, async value => this.control().setLocked(value));
    this.registerMultipleCapabilityListener([CAP.TARGET_POWER, CAP.TARGET_MODE, CAP.CHARGING], async batch => this.control().command(batch), 500);

    await this.start();
    // The interval depends on the chargers on the account
    for (const device of this.driver.getDevices())
      if (device !== this && device.account === this.account && typeof device.refreshInterval === 'function')
        device.refreshInterval();
  }

  /**
   * Add manifest capabilities the device misses, drop onoff (start/stop is evcharger_charging)
   */
  async updateCapabilities() {
    for (const capabilityId of this.driver.manifest.capabilities || [])
      if (!this.hasCapability(capabilityId))
        await this.addCapabilityWithOptions(capabilityId);
    if (this.hasCapability('onoff'))
      await this.removeCapability('onoff').catch(error => this.log(`Failed to remove onoff: ${error.message}`));
  }

  /**
   * Add a capability with its options (title) from the driver manifest
   *
   * @param {string} capabilityId
   */
  async addCapabilityWithOptions(capabilityId) {
    try {
      await this.addCapability(capabilityId);
      const options = (this.driver.manifest.capabilitiesOptions || {})[capabilityId];
      if (options)
        await this.setCapabilityOptions(capabilityId, options);
    } catch (error) {
      this.log(`Failed to add ${capabilityId}: ${error.message}`);
    }
  }

  /**
   * Connect to the account in the store and start polling
   */
  async start() {
    if (!this.connect()) {
      await this.setUnavailable(this.homey.__(MSG.LOGIN)).catch(error => this.log(`Failed to set unavailable: ${error.message}`));
      return;
    }
    this.intervalMs = this.interval();
    const offset = Math.round(this.account.slot(this.id) * this.intervalMs / Math.max(1, this.account.chargerCount));
    this.poller.start(this.intervalMs, offset);
  }

  /**
   * Restart after a repair: new credentials, fresh poller and availability
   */
  async restart() {
    this.poller.stop();
    await this.setAvailable().catch(error => this.log(`Failed to set available: ${error.message}`));
    await this.start();
  }

  /**
   * Get the Account for the credentials in the store; a new account gets a new API and controller
   *
   * @return {boolean} false when the store has no credentials
   */
  connect() {
    const username = this.getStoreValue('username');
    if (!username)
      return false;
    const account = this.homey.app.registry.get(username, this.getStoreValue('password'));
    if (account === this.account)
      return true;

    if (this.account)
      this.account.unregister(this.id);
    account.register(this.id);
    this.account = account;
    this.api = new WallboxApi(account);
    this.controller = new ChargerController({
      api: this.api,
      chargerId: this.id,
      now: () => Date.now(),
      timers: this.timers,
      store: this.store,
      log: message => this.log(message),
      t: (key, vars) => this.homey.__(key, vars),
      caps: { get: capabilityId => this.getCapabilityValue(capabilityId) },
      requestPoll: ms => this.poller.soon(ms),
      onEvent: (trigger, tokens) => this.fire(trigger, tokens)
    });
    return true;
  }

  /**
   * Controller for a capability or flow card
   *
   * @return {ChargerController}
   * @throws {Error} when the device has no credentials
   */
  control() {
    if (!this.controller)
      throw new Error(this.homey.__(MSG.LOGIN));
    return this.controller;
  }

  /**
   * Poll interval: the setting, at least TIMING.POLL_PER_CHARGER per charger on the account
   *
   * @param {number} polling - setting `polling` in seconds
   * @return {number} ms
   */
  interval(polling = this.getSetting('polling')) {
    const setting = Math.min(TIMING.POLL_MAX, Math.max(TIMING.POLL_MIN, Number(polling) || TIMING.POLL_DEFAULT));
    return Math.max(setting, this.account.chargerCount * TIMING.POLL_PER_CHARGER) * SECOND;
  }

  /**
   * Apply a changed charger count on the account
   */
  refreshInterval() {
    if (!this.account)
      return;
    const ms = this.interval();
    if (ms === this.intervalMs)
      return;
    this.intervalMs = ms;
    this.poller.setInterval(ms);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (!changedKeys.includes('polling') || !this.account)
      return;
    this.intervalMs = this.interval(newSettings.polling);
    this.poller.setInterval(this.intervalMs);
  }

  /**
   * Flow card "change charging current"
   *
   * @param {number} amps
   * @return {Promise<Object>} tokens { result, amps, seconds }
   */
  async setCurrentCard(amps) {
    return this.control().setCurrent(amps);
  }

  /**
   * Flow card "set solar charging"
   *
   * @param {string} mode - ECO_SMART id
   */
  async setEcoSmart(mode) {
    await this.control().setEcoSmart(mode);
  }

  /**
   * One status poll. Never throws.
   */
  async poll() {
    try {
      const now = Date.now();
      const snapshot = parseSnapshot(await this.api.getStatus(this.id), now);
      const prev = this.view;
      const view = toView(snapshot, prev, {
        phases: this.controller.measuredPhases,
        timezone: this.homey.clock.getTimezone(),
        now
      });
      this.view = view;

      for (const [capabilityId, value] of Object.entries(capabilityValues(view)))
        await this.setValue(capabilityId, value);
      for (const { trigger, tokens, state } of transitions(prev, view))
        await this.fire(trigger, tokens, state);
      await this.controller.onPoll(view);
      await this.updateEnergy(snapshot);
      await this.updateTargetOptions();

      await this.setValue(CAP.ALARM, view.staleSync === true || view.status === STATUS.OFFLINE);
      if (!this.getAvailable())
        await this.setAvailable().catch(error => this.log(`Failed to set available: ${error.message}`));
    } catch (error) {
      await this.pollFailed(error).catch(failure => this.log(`Poll error handling failed: ${failure.message}`));
    }
  }

  /**
   * A login problem makes the device unavailable, anything else only turns on the alarm
   *
   * @param {Error} error
   */
  async pollFailed(error) {
    this.log(`Poll failed: ${error.code || `${error.name}: ${error.message}`}`);
    if (error.code === ERR.AUTH_REJECTED) {
      await this.setUnavailable(this.homey.__(MSG.LOGIN));
      return;
    }
    await this.setValue(CAP.ALARM, true);
  }

  /**
   * Set a capability value when the device has it and the value changed
   *
   * @param {string} capabilityId
   * @param {*} value - null: don't set
   */
  async setValue(capabilityId, value) {
    if (value == null || !this.hasCapability(capabilityId) || this.getCapabilityValue(capabilityId) === value)
      return;
    try {
      await this.setCapabilityValue(capabilityId, value);
    } catch (error) {
      this.log(`Failed to set ${capabilityId}: ${error.message}`);
    }
  }

  /**
   * Fire a device trigger card
   *
   * @param {string} trigger - FLOW.TRIGGER id
   * @param {Object} tokens - status_changed: STATUS ids, made titles here
   * @param {Object} state
   */
  async fire(trigger, tokens = {}, state = {}) {
    if (trigger === FLOW.TRIGGER.STATUS_CHANGED) {
      this.log(`Status ${tokens.old_status} -> ${tokens.new_status}`);
      tokens = { old_status: this.statusTitle(tokens.old_status), new_status: this.statusTitle(tokens.new_status) };
    }
    try {
      await this.homey.flow.getDeviceTriggerCard(trigger).trigger(this, tokens, state);
    } catch (error) {
      this.log(`Failed to trigger ${trigger}: ${error.message}`);
    }
  }

  /**
   * Title of a status value from the app manifest, in the user's language
   *
   * @param {string} status - STATUS id
   * @return {string}
   */
  statusTitle(status) {
    const capability = (this.homey.manifest.capabilities || {})[CAP.STATUS] || {};
    const value = (capability.values || []).find(item => item.id === status);
    const title = (value && value.title) || {};
    return title[this.homey.i18n.getLanguage()] || title.en || String(status);
  }

  /**
   * Lifetime meters; they never go down
   *
   * @param {Snapshot} snapshot
   */
  async updateEnergy(snapshot) {
    let values;
    try {
      values = await this.energy.update(snapshot);
    } catch (error) {
      this.log(`Energy meter failed: ${error.code || error.message}`);
      return;
    }
    if (!values)
      return;

    await this.setMeter(CAP.TOTAL_ENERGY, values.total);
    if (showGreen(values.green, snapshot.ecoSmart) && !this.hasCapability(CAP.GREEN_ENERGY))
      await this.addCapabilityWithOptions(CAP.GREEN_ENERGY);
    await this.setMeter(CAP.GREEN_ENERGY, values.green);
  }

  /**
   * Set a meter, never lower than its value now
   *
   * @param {string} capabilityId
   * @param {number} kwh
   */
  async setMeter(capabilityId, kwh) {
    if (typeof kwh !== 'number' || Number.isNaN(kwh))
      return;
    await this.setValue(capabilityId, Math.max(Math.round(kwh * 1000) / 1000, this.getCapabilityValue(capabilityId) || 0));
  }

  /**
   * target_power range for the charger and phases, set only when it changed
   */
  async updateTargetOptions() {
    const options = this.controller.targetOptions();
    const text = options ? JSON.stringify(options) : null;
    if (!text || text === this.optionsText)
      return;
    try {
      await this.setCapabilityOptions(CAP.TARGET_POWER, options);
      this.optionsText = text;
    } catch (error) {
      this.log(`Failed to set ${CAP.TARGET_POWER} options: ${error.message}`);
    }
  }

  /**
   * Stop polling and leave the account
   */
  stop() {
    if (this.poller)
      this.poller.stop();
    if (this.account)
      this.account.unregister(this.id);
    this.account = null;
  }

  async onUninit() {
    this.stop();
  }

  async onDeleted() {
    this.stop();
    this.log('Device deleted');
  }

}

module.exports = WallboxDevice;

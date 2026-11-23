'use strict';

const Homey = require('homey');
const { WallboxApi } = require('../../lib/wallbox/api');
const { parseSnapshot, toView, capabilityValues, transitions } = require('../../lib/charger/view');
const { ChargerController } = require('../../lib/charger/controller');
const { Poller } = require('../../lib/poller');
const { EnergyMeter, sumSessions, showGreen } = require('../../lib/energy');
const { LatestWriter, bounded } = require('../../lib/writer');
const { STATUS, ERR, MSG, CAP, MODE, FLOW, TIMING } = require('../../lib/contract');

const SECOND = 1000;
const POLL_TIMEOUT = 90 * SECOND; // a poll busy this long no longer holds up the next one
const HOMEY_SLOW = 30 * SECOND; // a capability write unanswered this long is logged
const POLL_SLOW = 10 * SECOND; // a poll or trigger slower than this is logged
const INIT_LIMIT = 60 * SECOND; // startup steps that wait on Homey give up after this
const STALE_VALUES = 10 * 60 * SECOND; // without a good poll this long, power and current go to 0
const FORBIDDEN_LIMIT = 4; // status 403s in a row (about half an hour of back-off) before "not reachable"

/**
 * Homey adapter of one Wallbox charger. The decisions live in lib/; this
 * class maps them on capabilities, flow triggers, settings and availability.
 *
 * Never wait on Homey in a shared path: Homey may answer a call late or
 * never. Capability values go through a LatestWriter (lib/writer.js): the
 * poll goes on at once and the newest value wins. Store, availability and
 * warning writes are fired without waiting (the SDK keeps their order).
 * Flow triggers too. Startup steps have a time limit. A poll answered after a
 * newer one changes nothing.
 */
class WallboxDevice extends Homey.Device {

  async onInit() {
    this.id = this.getData().id;
    this.view = null; // View of the latest poll
    this.pollRun = null; // { id, step } of the newest poll
    this.pollRuns = 0;
    this.stopped = false;
    this.adding = new Set(); // capabilities being added after init
    this.timers = {
      setTimeout: (fn, ms) => this.homey.setTimeout(fn, ms),
      clearTimeout: handle => this.homey.clearTimeout(handle)
    };
    // The SDK queues writes per capability: wait for the answer, the newest value waits
    this.values = new LatestWriter({
      name: 'Capability',
      write: (capabilityId, value) => this.setCapabilityValue(capabilityId, value),
      read: capabilityId => this.getCapabilityValue(capabilityId),
      timers: this.timers,
      timeout: HOMEY_SLOW,
      log: message => this.log(message)
    });
    // The SDK updates the store in memory at once, so reads see the newest value
    this.store = {
      get: key => this.getStoreValue(key),
      set: async (key, value) => this.later(this.setStoreValue(key, value), `Store ${key}`)
    };

    // Startup steps that wait on Homey have a time limit, so polling always starts
    const added = await bounded(this.updateCapabilities(), INIT_LIMIT, this.timers);
    if (!added.done)
      this.log(`Adding capabilities: Homey hasn't answered in ${INIT_LIMIT / SECOND} s, going on`);
    if (this.getCapabilityValue(CAP.TARGET_MODE) == null)
      this.values.set(CAP.TARGET_MODE, MODE.DEVICE);

    this.energy = new EnergyMeter({
      fetchSessions: async (start, end) => sumSessions(await this.api.sessions(this.id, start, end), this.id),
      store: this.store,
      log: message => this.log(message),
      now: () => Date.now(),
      timers: this.timers
    });
    this.poller = new Poller({
      run: () => this.poll(),
      timeout: POLL_TIMEOUT,
      onTimeout: () => this.log(`Poll still busy after ${POLL_TIMEOUT / SECOND} s (at: ${this.pollRun ? this.pollRun.step : '-'}), polling goes on`),
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
   * A Homey call that nobody waits for; a failure is logged
   *
   * @param {Promise} call
   * @param {string} what - for the log
   * @param {Function} [failed] - called after a failure
   */
  later(call, what, failed) {
    Promise.resolve(call).catch(error => {
      this.log(`${what} failed: ${error && error.message}`);
      if (failed)
        failed();
    });
  }

  /**
   * Available or not, without waiting on Homey. Sent only on a change, so a
   * call Homey doesn't answer can't pile up (the SDK queues them in order).
   *
   * @param {boolean} available
   * @param {string} [message] - shown while unavailable
   */
  setAvailability(available, message) {
    const state = available ? 'available' : `unavailable ${message}`;
    if (state === (this.availabilitySent || (this.getAvailable() ? 'available' : null)))
      return;
    this.availabilitySent = state;
    // Refused: forget it, so the next call compares with Homey's own state and sends again
    this.later(available ? this.setAvailable() : this.setUnavailable(message), 'Availability', () => {
      if (this.availabilitySent === state)
        this.availabilitySent = undefined;
    });
  }

  /**
   * Device warning, or null to clear it; sent only on a change (and once
   * after start, for a warning left from before)
   *
   * @param {string|null} message
   */
  setWarningText(message) {
    if (this.warningSent === message)
      return;
    this.warningSent = message;
    this.later(message ? this.setWarning(message) : this.unsetWarning(), 'Warning', () => {
      if (this.warningSent === message)
        this.warningSent = undefined; // sent again at the next call
    });
  }

  /**
   * @return {Promise} resolves once the capability writer is idle (tests, harness)
   */
  settled() {
    return this.values.idle();
  }

  /**
   * Add manifest capabilities the device misses
   */
  async updateCapabilities() {
    for (const capabilityId of this.driver.manifest.capabilities || [])
      if (!this.hasCapability(capabilityId))
        await this.addCapabilityWithOptions(capabilityId);
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
    this.stopped = false;
    if (!this.connect()) {
      this.setAvailability(false, this.homey.__(MSG.LOGIN));
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
    this.pollRun = null; // a poll still running is now stale
    this.setAvailability(true);
    await this.start();
  }

  /**
   * New login for this device (repair), without waiting on Homey
   *
   * @param {string} username
   * @param {string} password
   */
  setCredentials(username, password) {
    this.store.set('username', username);
    this.store.set('password', password);
  }

  /**
   * Get the Account for the credentials in the store; a new account gets a new API and controller
   *
   * @return {boolean} false when the store has no credentials
   */
  connect() {
    const username = this.store.get('username');
    if (!username)
      return false;
    const account = this.homey.app.registry.get(username, this.store.get('password'));
    if (account === this.account)
      return true;

    if (this.account)
      this.account.unregister(this.id);
    if (this.controller)
      this.controller.dispose(); // its queued writes went to the old account
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
   * Condition "paused by Homey"
   *
   * @return {boolean}
   */
  pausedByHomey() {
    return Boolean(this.controller && this.controller.pausedByHomey());
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
    const started = Date.now();
    const run = { id: ++this.pollRuns, step: 'status request' };
    this.pollRun = run;
    // A newer poll started (this one was too slow) or the device stopped
    const stale = () => this.pollRun !== run || this.stopped;
    try {
      const now = started;
      const raw = await this.api.getStatus(this.id);
      if (stale()) {
        this.log(`Poll ${run.id} answered after a newer one, dropped`);
        return;
      }
      const snapshot = parseSnapshot(raw, now);
      const prev = this.view;
      const view = toView(snapshot, prev, {
        // Phases seen this session, else this reading, else the last known ones
        phases: this.controller.phasesFor(snapshot.status, snapshot.maxCurrent, snapshot.powerKw),
        timezone: this.homey.clock.getTimezone()
      });
      this.view = view;

      run.step = 'capabilities';
      for (const [capabilityId, value] of Object.entries(capabilityValues(view)))
        this.setValue(capabilityId, value);
      // Not awaited: a flow behind a trigger may wait for minutes (a delay, a
      // push question), and the poll must never wait for flows
      for (const { trigger, tokens, state } of transitions(prev, view))
        this.fire(trigger, tokens, state);
      // Not awaited either: the work after a poll waits behind running commands
      run.step = 'controller';
      this.controller.onPoll(view);
      run.step = 'energy';
      await this.updateEnergy(snapshot, stale);
      if (stale())
        return;
      this.lastGoodPoll = now;
      // Values that didn't change aren't written, so tell Homey the charger is still seen
      this.later(this.setLastSeenAt(), 'Last seen');
      this.setValue(CAP.ALARM, view.status === STATUS.OFFLINE);
      this.setWarningText(null);
      this.forbidden = 0;
      this.setAvailability(true);
      run.step = 'done';
      if (Date.now() - started > POLL_SLOW)
        this.log(`Poll slow (${Date.now() - started} ms): ${view.status} (${view.statusCode}), ${view.powerW} W, set ${view.maxCurrent} A`);
    } catch (error) {
      if (stale())
        return;
      try {
        this.pollFailed(error);
      } catch (failure) {
        this.log(`Poll error handling failed: ${failure.message}`);
      }
    }
  }

  /**
   * A login problem makes the device unavailable, anything else only turns on the alarm
   *
   * @param {Error} error
   */
  pollFailed(error) {
    this.log(`Poll failed: ${error.code || `${error.name}: ${error.message}`}`);
    if (error.code === ERR.AUTH_REJECTED) {
      this.setAvailability(false, this.homey.__(MSG.LOGIN));
      return;
    }
    // Our own request budget was full: Wallbox refused nothing, so no alarm
    const ownBudget = error.code === ERR.THROTTLED && error.sent === false && !(this.account && this.account.blockedUntil > Date.now());
    if (!ownBudget)
      this.setValue(CAP.ALARM, true);

    // No data for a while: don't keep showing the last power as if it flows
    if (!ownBudget && this.lastGoodPoll && Date.now() - this.lastGoodPoll > STALE_VALUES) {
      this.setValue(CAP.POWER, 0);
      this.setValue(CAP.CURRENT, 0);
    }

    // 403 on the status poll again and again: the charger left this account
    this.forbidden = error.code === ERR.THROTTLED && error.status === 403 ? (this.forbidden || 0) + 1 : this.forbidden || 0;
    if (this.forbidden >= FORBIDDEN_LIMIT)
      this.setWarningText(this.homey.__(MSG.NOT_REACHABLE));

    // Poll again right when Wallbox allows it, not a whole interval later
    if (error.code === ERR.THROTTLED && error.retryAt > Date.now())
      this.poller.soon(error.retryAt - Date.now());
  }

  /**
   * Set a capability value when the device has it and the value changed
   *
   * @param {string} capabilityId
   * @param {*} value - null: don't set
   */
  setValue(capabilityId, value) {
    if (value == null || !this.hasCapability(capabilityId))
      return;
    // Compare with the newest value: one on its way to Homey counts already
    if (!this.values.pending(capabilityId) && this.getCapabilityValue(capabilityId) === value)
      return;
    this.values.set(capabilityId, value);
  }

  /**
   * Fire a device trigger card
   *
   * @param {string} trigger - FLOW.TRIGGER id
   * @param {Object} tokens - ids from lib/; cardTokens adds the titles
   * @param {Object} state
   */
  async fire(trigger, tokens = {}, state = {}) {
    const started = Date.now();
    try {
      await this.homey.flow.getDeviceTriggerCard(trigger).trigger(this, this.cardTokens(trigger, tokens), state);
    } catch (error) {
      this.log(`Failed to trigger ${trigger}: ${error && error.message}`);
    }
    if (Date.now() - started > POLL_SLOW)
      this.log(`Trigger ${trigger} answered after ${Math.round((Date.now() - started) / SECOND)} s`);
  }

  /**
   * Card tokens: titles in the user's language, next to the ids
   *
   * @param {string} trigger - FLOW.TRIGGER id
   * @param {Object} tokens - ids from lib/
   * @return {Object}
   */
  cardTokens(trigger, tokens) {
    if (trigger === FLOW.TRIGGER.STATUS_CHANGED) {
      this.log(`Status ${tokens.old_status} -> ${tokens.new_status}`);
      tokens = {
        old_status: this.statusTitle(tokens.old_status),
        new_status: this.statusTitle(tokens.new_status),
        old_status_id: tokens.old_status, // ids for comparing in flows and scripts
        new_status_id: tokens.new_status
      };
    }
    if (trigger === FLOW.TRIGGER.ECO_SMART_CHANGED)
      tokens = { mode: this.valueTitle(CAP.ECO_SMART, tokens.mode), mode_id: tokens.mode };
    if (trigger === FLOW.TRIGGER.NOT_FOLLOWED) {
      this.log(`Charger did not follow ${tokens.command}: ${tokens.reason}`);
      tokens = {
        command: this.homey.__(`commands.${tokens.command}`),
        reason: this.homey.__(`reasons.${tokens.reason}`),
        command_id: tokens.command,
        reason_id: tokens.reason
      };
    }
    return tokens;
  }

  /**
   * Title of a status value from the app manifest, in the user's language
   *
   * @param {string} status - STATUS id
   * @return {string}
   */
  statusTitle(status) {
    return this.valueTitle(CAP.STATUS, status);
  }

  /**
   * Title of an enum capability value from the app manifest, in the user's language
   *
   * @param {string} capabilityId - custom enum capability
   * @param {string} id - value id
   * @return {string}
   */
  valueTitle(capabilityId, id) {
    const capability = (this.homey.manifest.capabilities || {})[capabilityId] || {};
    const value = (capability.values || []).find(item => item.id === id);
    const title = (value && value.title) || {};
    return title[this.homey.i18n.getLanguage()] || title.en || String(id);
  }

  /**
   * Lifetime meters; they never go down
   *
   * @param {Snapshot} snapshot
   */
  async updateEnergy(snapshot, stale = () => false) {
    let values;
    try {
      values = await this.energy.update(snapshot);
    } catch (error) {
      this.log(`Energy meter failed: ${error.code || error.message}`);
      return;
    }
    if (!values || stale())
      return;

    this.setMeter(CAP.TOTAL_ENERGY, values.total);
    if (showGreen(values.green, snapshot.ecoSmart) && !this.hasCapability(CAP.GREEN_ENERGY))
      this.addLater(CAP.GREEN_ENERGY);
    this.setMeter(CAP.GREEN_ENERGY, values.green);
  }

  /**
   * Add a capability after init without waiting; one try at a time
   *
   * @param {string} capabilityId
   */
  addLater(capabilityId) {
    if (this.adding.has(capabilityId))
      return;
    this.adding.add(capabilityId);
    // Tried again only once this add is answered, never two at once
    const add = this.addCapabilityWithOptions(capabilityId).finally(() => this.adding.delete(capabilityId));
    bounded(add, INIT_LIMIT, this.timers).then(result => {
      if (!result.done)
        this.log(`Adding ${capabilityId}: Homey hasn't answered in ${INIT_LIMIT / SECOND} s, still waiting`);
    });
  }

  /**
   * Set a meter, never lower than its value now
   *
   * @param {string} capabilityId
   * @param {number} kwh
   */
  setMeter(capabilityId, kwh) {
    if (typeof kwh !== 'number' || Number.isNaN(kwh))
      return;
    // Never lower than the newest value, also one still on its way to Homey
    this.setValue(capabilityId, Math.max(Math.round(kwh * 1000) / 1000, this.values.get(capabilityId) || 0));
  }

  /**
   * Stop polling, timers and writes, and leave the account
   */
  stop() {
    this.stopped = true;
    this.pollRun = null;
    if (this.poller)
      this.poller.stop();
    if (this.controller)
      this.controller.dispose();
    if (this.energy)
      this.energy.dispose();
    if (this.values)
      this.values.dispose(); // nothing waiting is written to a removed device
    const account = this.account;
    if (account)
      account.unregister(this.id);
    this.account = null;
    // The other chargers on the account may poll more often now
    if (account && this.driver)
      for (const device of this.driver.getDevices())
        if (device !== this && device.account === account && typeof device.refreshInterval === 'function')
          device.refreshInterval();
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

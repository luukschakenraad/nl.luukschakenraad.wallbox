'use strict';

/* global fetch */

const Homey = require('homey');
const { Account, AccountRegistry } = require('./lib/wallbox/account');
const { matches, statusTriggerMatches } = require('./lib/charger/view');
const { CAP, FLOW } = require('./lib/contract');

/**
 * Wallbox EV app: one Wallbox client per account, shared by its chargers,
 * and the app-wide flow card listeners.
 */
class WallboxApp extends Homey.App {

  async onInit() {
    // Node's own fetch (Homey 12.13+), called unbound, so wrapped
    const httpFetch = (url, options) => fetch(url, options);
    const { id, version } = this.homey.manifest;
    const settings = this.homey.settings;

    /** @type {AccountRegistry} one Account per Wallbox account, used by the driver and devices */
    this.registry = new AccountRegistry({
      create: (username, password) => {
        const key = `tokens:${this.registry.key(username)}`;
        return new Account({
          username,
          password,
          fetch: httpFetch,
          now: () => Date.now(),
          timers: {
            setTimeout: (fn, ms) => this.homey.setTimeout(fn, ms),
            clearTimeout: handle => this.homey.clearTimeout(handle)
          },
          persist: {
            load: () => settings.get(key) || null,
            save: tokens => (tokens ? settings.set(key, tokens) : settings.unset(key))
          },
          log: message => this.log(message),
          userAgent: `Homey-WallboxEV (${id}/${version})`
        });
      }
    });

    this.registerFlowCards();
    this.log('Wallbox EV app started');
  }

  /**
   * Run listeners of the flow cards. Device trigger cards are fired by the devices.
   */
  registerFlowCards() {
    const flow = this.homey.flow;

    flow.getActionCard(FLOW.ACTION.CHANGE_AMPERE)
      .registerRunListener(args => args.device.setCurrentCard(args.ampere));
    flow.getActionCard(FLOW.ACTION.SET_ECO_SMART)
      .registerRunListener(args => args.device.setEcoSmart(args.mode));

    // The latest poll, also while Homey hasn't answered its capability write yet:
    // a flow behind one of our triggers may run before that
    flow.getConditionCard(FLOW.CONDITION.STATUS_IS)
      .registerRunListener(args => matches(args.status, args.device.latest(CAP.STATUS)));
    flow.getConditionCard(FLOW.CONDITION.CAR_IS_CONNECTED)
      .registerRunListener(args => args.device.latest(CAP.CAR_CONNECTED) === true);
    flow.getConditionCard(FLOW.CONDITION.ECO_SMART_IS)
      .registerRunListener(args => args.device.latest(CAP.ECO_SMART) === args.mode);
    flow.getConditionCard(FLOW.CONDITION.PAUSED_BY_HOMEY)
      .registerRunListener(args => args.device.pausedByHomey());

    flow.getDeviceTriggerCard(FLOW.TRIGGER.STATUS_CHANGED)
      .registerRunListener((args, state) => statusTriggerMatches(args.status, state));
  }

}

module.exports = WallboxApp;

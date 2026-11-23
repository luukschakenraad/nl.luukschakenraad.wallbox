'use strict';

/**
 * Charger state: raw chargers/status JSON → Snapshot → View → capability
 * values, flow trigger events and status groups. Pure, no Homey.
 *
 * Snapshot is one poll as Wallbox reports it; View is the effective device
 * state after the keep-previous rules (unknown status id, unknown car).
 */

const {
  STATUS,
  STATUS_IDS,
  CAR_CONNECTED,
  CHARGING_STATE_BY_STATUS,
  SESSION_STATE,
  ANY,
  GROUP_MEMBERS,
  ECO_SMART,
  CAP,
  FLOW,
  VOLT
} = require('../contract');

/** @typedef {import('../contract').Snapshot} Snapshot */
/** @typedef {import('../contract').View} View */

const STATUS_BY_ID = new Map();
for (const [status, ids] of Object.entries(STATUS_IDS))
  for (const id of ids)
    STATUS_BY_ID.set(id, status);

const SYNC_FORMAT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * @param {*} value
 * @return {number|null} the number, null when missing or not a number
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '')
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {number} value
 * @return {number} rounded to 1 decimal
 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * @param {*} value
 * @return {boolean}
 */
function isMissing(value) {
  return value === null || value === undefined;
}

/**
 * @param {*} value - last_sync, "YYYY-MM-DD HH:MM:SS" in UTC
 * @return {number|null} ms, null when missing or not in that format
 */
function parseSync(value) {
  const match = typeof value === 'string' && value.trim().match(SYNC_FORMAT);
  if (!match)
    return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part || 0));
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {*} ecosmart - config_data.ecosmart { enabled, mode }
 * @return {string|null} ECO_SMART id, null when the charger has no Eco-Smart
 */
function parseEcoSmart(ecosmart) {
  if (!ecosmart || typeof ecosmart !== 'object' || isMissing(ecosmart.mode))
    return null;
  if (ecosmart.enabled === false || ecosmart.enabled === 0)
    return ECO_SMART.OFF;
  const mode = Number(ecosmart.mode);
  if (mode === 0)
    return ECO_SMART.ECO;
  if (mode === 1)
    return ECO_SMART.FULL_SOLAR;
  return null;
}

/**
 * @param {number|null|undefined} statusId - Wallbox status_id
 * @return {string|null} STATUS id; null and undefined are OFFLINE, an id not
 *   in STATUS_IDS gives null
 */
function statusOf(statusId) {
  if (isMissing(statusId))
    return STATUS.OFFLINE;
  const status = STATUS_BY_ID.get(Number(statusId));
  return status === undefined ? null : status;
}

/**
 * Parse one poll of chargers/status
 *
 * @param {Object} raw - JSON of chargers/status/{id}
 * @param {number} now - poll time, ms
 * @return {Snapshot}
 */
function parseSnapshot(raw, now) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const hasConfig = Boolean(data.config_data && typeof data.config_data === 'object');
  const config = hasConfig ? data.config_data : {};
  const statusId = toNumber(data.status_id);
  const powerKw = toNumber(data.charging_power);
  const addedGreenKwh = toNumber(data.added_green_energy);

  return {
    at: now,
    statusId,
    status: statusOf(statusId),
    locked: hasConfig ? Boolean(config.locked) : null, // unknown without config_data, not unlocked
    maxCurrent: toNumber(config.max_charging_current),
    maxAvailable: toNumber(config.max_available_current),
    powerKw: powerKw === null ? 0 : powerKw,
    addedKwh: toNumber(data.added_energy),
    addedGreenKwh: addedGreenKwh === null ? 0 : addedGreenKwh,
    ecoSmart: parseEcoSmart(config.ecosmart),
    lastSync: parseSync(data.last_sync)
  };
}

/**
 * @param {number} ms
 * @return {string} "YYYY-MM-DD HH:MM" in UTC
 */
function utcText(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * @param {number|null} ms
 * @param {string} timezone - IANA time zone, e.g. Europe/Amsterdam
 * @return {string|null} "YYYY-MM-DD HH:MM" in that time zone (UTC when the
 *   zone is invalid), null without a time
 */
function localText(ms, timezone) {
  if (isMissing(ms))
    return null;
  try {
    const parts = {};
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    for (const part of format.formatToParts(new Date(ms)))
      parts[part.type] = part.value;
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
  } catch (error) {
    return utcText(ms);
  }
}

/**
 * Effective device state after a poll
 *
 * - An unknown status id keeps the previous status (UNKNOWN without one).
 * - An unknown car (CAR_CONNECTED null) keeps the previous car_connected and
 *   charging state.
 * - Power only counts while charging or discharging: charging_power stays at
 *   the last value for minutes after charging stops.
 * - The session energy comes from a poll with an open session; other polls
 *   (no car, locked, offline, unknown) keep it.
 * - A plug-in counts as charged once power flowed, or added_energy moved away
 *   from the last session's value (Wallbox shows that one until charging starts).
 * - The lock is kept when the poll has no config_data.
 *
 * @param {Snapshot} snapshot
 * @param {View|null} prev - previous View
 * @param {{ phases: number, timezone: string }} options
 * @return {View}
 */
function toView(snapshot, prev, { phases, timezone } = {}) {
  const before = prev || null;
  let status = snapshot.status;
  if (status === null)
    status = before ? before.status : STATUS.UNKNOWN;

  const car = CAR_CONNECTED[status];
  const carConnected = isMissing(car) ? (before ? before.carConnected : null) : car;
  const state = CHARGING_STATE_BY_STATUS[status];
  const chargingState = isMissing(state) ? (before ? before.chargingState : null) : state;

  const flowing = status === STATUS.CHARGING || status === STATUS.DISCHARGING;
  const phaseCount = phases >= 1 ? phases : 1;
  const powerW = flowing ? Math.round(snapshot.powerKw * 1000) : 0;
  const currentA = flowing ? round1(powerW / (VOLT * phaseCount)) : 0;

  const lastSync = snapshot.lastSync;
  // At 210 (locked, car connected) added_energy still shows the last session
  const session = SESSION_STATE[status];
  const sessionOpen = isMissing(session) ? (before ? before.sessionOpen : null) : session === 'open';
  const fromSession = session === 'open' && snapshot.addedKwh !== null;

  // Energy of this plug-in: at the plug-in, added_energy still shows the last
  // session (also while scheduled, full or waiting), so that value is no new session
  const pluggedIn = carConnected === true && Boolean(before) && before.carConnected === false;
  const stayed = carConnected === true && Boolean(before) && before.carConnected === true;
  let plugKwh;
  if (pluggedIn)
    plugKwh = before.addedKwh !== null && before.addedKwh !== undefined ? before.addedKwh : snapshot.addedKwh;
  else if (stayed)
    plugKwh = before.plugKwh;
  const added = snapshot.addedKwh > 0 && snapshot.addedKwh !== plugKwh;
  // Without a plug-in seen (app started with a car connected): an open session counts
  const charged = carConnected === true &&
    (flowing || (stayed && before.charged === true) || (plugKwh === undefined ? sessionOpen === true : added));

  return {
    at: snapshot.at,
    status,
    statusCode: isMissing(snapshot.statusId) ? 0 : snapshot.statusId, // missing: offline, Wallbox's 0
    carConnected,
    chargingState,
    charging: isMissing(car) && before ? before.charging : status === STATUS.CHARGING, // unknown: keep, like the charging state
    locked: isMissing(snapshot.locked) ? (before ? before.locked : null) : snapshot.locked,
    powerW,
    currentA,
    maxCurrent: snapshot.maxCurrent,
    maxAvailable: snapshot.maxAvailable,
    ecoSmart: snapshot.ecoSmart,
    lastSync,
    lastUpdated: localText(lastSync, timezone),
    sessionOpen,
    sessionKwh: fromSession ? snapshot.addedKwh : (before ? before.sessionKwh : null),
    sessionGreenKwh: fromSession ? snapshot.addedGreenKwh : (before ? before.sessionGreenKwh : 0),
    plugKwh,
    charged,
    addedKwh: snapshot.addedKwh,
    addedGreenKwh: snapshot.addedGreenKwh
  };
}

/**
 * Capability values driven by the View. A null value means "don't set".
 *
 * @param {View} view
 * @return {Object<string, *>} { [CAP id]: value }
 */
function capabilityValues(view) {
  return {
    [CAP.STATUS]: view.status,
    [CAP.STATUS_CODE]: view.statusCode,
    [CAP.CAR_CONNECTED]: view.carConnected,
    [CAP.CHARGING_STATE]: view.chargingState,
    [CAP.CHARGING]: view.charging,
    [CAP.LOCKED]: view.locked,
    [CAP.POWER]: view.powerW,
    [CAP.CURRENT]: view.currentA,
    [CAP.MAX_CURRENT]: view.maxCurrent,
    [CAP.ECO_SMART]: view.ecoSmart,
    [CAP.LAST_UPDATED]: view.lastUpdated,
    [CAP.SESSION_ENERGY]: view.sessionKwh
  };
}

/**
 * @param {*} value
 * @return {number} kWh rounded to 3 decimals, 0 when unknown
 */
function kwhToken(value) {
  const kwh = toNumber(value);
  return kwh === null ? 0 : Math.round(kwh * 1000) / 1000;
}

/**
 * Flow trigger events between two Views
 *
 * @param {View|null} prev
 * @param {View} next
 * @return {Array<{ trigger: string, tokens: Object, state: Object }>} none
 *   when prev is null
 */
function transitions(prev, next) {
  if (!prev || !next)
    return [];

  const events = [];
  if (prev.status !== next.status)
    events.push({
      trigger: FLOW.TRIGGER.STATUS_CHANGED,
      tokens: { old_status: prev.status, new_status: next.status },
      state: { old: prev.status, new: next.status }
    });

  if (prev.carConnected === false && next.carConnected === true)
    events.push({ trigger: FLOW.TRIGGER.CAR_CONNECTED, tokens: {}, state: {} });

  if (prev.carConnected === true && next.carConnected === false) {
    events.push({ trigger: FLOW.TRIGGER.CAR_DISCONNECTED, tokens: {}, state: {} });
    // Only after a real session: energy was added since the plug-in (not after
    // only plugging in on a locked, scheduled or full charger), also when it locked before the unplug
    if (prev.charged === true)
      events.push({
        trigger: FLOW.TRIGGER.SESSION_ENDED,
        tokens: { kwh: kwhToken(prev.sessionKwh), green_kwh: kwhToken(prev.sessionGreenKwh) },
        state: {}
      });
  }

  // Changes from anywhere (also the Wallbox app); unknown values fire nothing
  if (prev.ecoSmart != null && next.ecoSmart != null && prev.ecoSmart !== next.ecoSmart)
    events.push({ trigger: FLOW.TRIGGER.ECO_SMART_CHANGED, tokens: { mode: next.ecoSmart }, state: {} });
  if (prev.maxCurrent != null && next.maxCurrent != null && prev.maxCurrent !== next.maxCurrent)
    events.push({ trigger: FLOW.TRIGGER.MAX_CURRENT_CHANGED, tokens: { amps: next.maxCurrent }, state: {} });

  return events;
}

/**
 * @param {string} selection - STATUS id, GROUP id or ANY
 * @param {string} status - STATUS id
 * @return {boolean} status is the selection, or in the selected group
 */
function matches(selection, status) {
  if (selection === ANY)
    return true;
  if (Object.prototype.hasOwnProperty.call(GROUP_MEMBERS, selection))
    return GROUP_MEMBERS[selection].includes(status);
  return selection === status;
}

/**
 * "Status changed" trigger filter: the status enters the selection. Moving
 * between statuses of one group doesn't fire; ANY fires on every change.
 *
 * @param {string} selection - STATUS id, GROUP id or ANY
 * @param {{ old: string, new: string }} state - from transitions()
 * @return {boolean}
 */
function statusTriggerMatches(selection, state) {
  if (selection === ANY)
    return true;
  return matches(selection, state.new) && !matches(selection, state.old);
}

module.exports = {
  parseSnapshot,
  statusOf,
  toView,
  capabilityValues,
  transitions,
  matches,
  statusTriggerMatches
};

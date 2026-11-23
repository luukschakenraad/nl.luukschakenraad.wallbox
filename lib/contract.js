'use strict';

/**
 * Shared ids, tables and timings of the app, and the interfaces between its
 * parts. See ARCHITECTURE.md for the module layout.
 *
 * Core rule: others (Wallbox app, website, other integrations) can change the
 * charger at any time. The latest poll is the truth, never our own last write.
 */

/**
 * Detailed charger status, also the value ids of the `status` capability.
 * Stored by Homey and used in flows: add values, never rename one.
 */
const STATUS = Object.freeze({
  CHARGING: 'charging',
  DISCHARGING: 'discharging',
  PAUSED: 'paused',
  SCHEDULED: 'scheduled',
  CAR_FULL: 'car_full', // car not taking power (full or car-side schedule)
  POWER_SHARING: 'power_sharing', // queue: load balancing over chargers
  POWER_BOOST: 'power_boost', // queue: waiting for power under the house limit
  ECO_SMART: 'eco_smart', // queue: waiting for solar
  MID_FAILED: 'mid_failed',
  MID_MARGIN: 'mid_margin', // MID safety margin exceeded
  SESSION_FINISHED: 'session_finished', // session done, car still connected
  READY: 'ready', // no car
  LOCKED: 'locked', // no car
  LOCKED_CAR: 'locked_car', // locked, car connected
  UPDATING: 'updating',
  ERROR: 'error',
  OFFLINE: 'offline', // charger not connected to the Wallbox cloud
  UNKNOWN: 'unknown' // status id not in the table, only when no previous status is known
});

/**
 * Wallbox status_id per status. A missing or null status_id is OFFLINE.
 * Ids not listed here: keep the previous status (UNKNOWN if there is none).
 * Source: Home Assistant wallbox integration, my.wallbox.com portal.
 */
const STATUS_IDS = Object.freeze({
  [STATUS.CHARGING]: [193, 194, 195],
  [STATUS.DISCHARGING]: [196],
  [STATUS.PAUSED]: [178, 182],
  [STATUS.SCHEDULED]: [177, 179],
  [STATUS.CAR_FULL]: [180, 181],
  [STATUS.POWER_SHARING]: [183, 184],
  [STATUS.POWER_BOOST]: [185, 186],
  [STATUS.ECO_SMART]: [189],
  [STATUS.MID_FAILED]: [187],
  [STATUS.MID_MARGIN]: [188],
  [STATUS.SESSION_FINISHED]: [164],
  [STATUS.READY]: [161, 162],
  [STATUS.LOCKED]: [165, 209],
  [STATUS.LOCKED_CAR]: [210],
  [STATUS.UPDATING]: [166],
  [STATUS.ERROR]: [14, 15],
  [STATUS.OFFLINE]: [0, 163]
});

/**
 * Car connected per status: true, false, or null = unknown, keep the previous
 * value (and the previous evcharger_charging_state).
 */
const CAR_CONNECTED = Object.freeze({
  [STATUS.CHARGING]: true,
  [STATUS.DISCHARGING]: true,
  [STATUS.PAUSED]: true,
  [STATUS.SCHEDULED]: true,
  [STATUS.CAR_FULL]: true,
  [STATUS.POWER_SHARING]: true,
  [STATUS.POWER_BOOST]: true,
  [STATUS.ECO_SMART]: true,
  [STATUS.MID_FAILED]: true,
  [STATUS.MID_MARGIN]: true,
  [STATUS.SESSION_FINISHED]: true,
  [STATUS.LOCKED_CAR]: true,
  [STATUS.READY]: false,
  [STATUS.LOCKED]: false,
  [STATUS.UPDATING]: null,
  [STATUS.ERROR]: null,
  [STATUS.OFFLINE]: null,
  [STATUS.UNKNOWN]: null
});

/**
 * Values of Homey's system capability evcharger_charging_state
 */
const CHARGING_STATE = Object.freeze({
  PLUGGED_OUT: 'plugged_out',
  PLUGGED_IN: 'plugged_in',
  PLUGGED_IN_CHARGING: 'plugged_in_charging',
  PLUGGED_IN_DISCHARGING: 'plugged_in_discharging',
  PLUGGED_IN_PAUSED: 'plugged_in_paused'
});

/**
 * evcharger_charging_state per status; null = keep the previous value
 */
const CHARGING_STATE_BY_STATUS = Object.freeze({
  [STATUS.CHARGING]: CHARGING_STATE.PLUGGED_IN_CHARGING,
  [STATUS.DISCHARGING]: CHARGING_STATE.PLUGGED_IN_DISCHARGING,
  [STATUS.PAUSED]: CHARGING_STATE.PLUGGED_IN_PAUSED,
  [STATUS.LOCKED_CAR]: CHARGING_STATE.PLUGGED_IN_PAUSED,
  [STATUS.SCHEDULED]: CHARGING_STATE.PLUGGED_IN,
  [STATUS.CAR_FULL]: CHARGING_STATE.PLUGGED_IN,
  [STATUS.POWER_SHARING]: CHARGING_STATE.PLUGGED_IN,
  [STATUS.POWER_BOOST]: CHARGING_STATE.PLUGGED_IN,
  [STATUS.ECO_SMART]: CHARGING_STATE.PLUGGED_IN,
  [STATUS.MID_FAILED]: CHARGING_STATE.PLUGGED_IN,
  [STATUS.MID_MARGIN]: CHARGING_STATE.PLUGGED_IN,
  [STATUS.SESSION_FINISHED]: CHARGING_STATE.PLUGGED_IN,
  [STATUS.READY]: CHARGING_STATE.PLUGGED_OUT,
  [STATUS.LOCKED]: CHARGING_STATE.PLUGGED_OUT,
  [STATUS.UPDATING]: null,
  [STATUS.ERROR]: null,
  [STATUS.OFFLINE]: null,
  [STATUS.UNKNOWN]: null
});

/**
 * Energy session state per status, for the lifetime meter (lib/energy.js):
 * 'open' a session is open, 'none' no session (added_energy still shows the
 * last session; also at 210 after plugging back in on a locked charger),
 * null unknown (skip the update).
 */
const SESSION_STATE = Object.freeze({
  [STATUS.CHARGING]: 'open',
  [STATUS.DISCHARGING]: 'open',
  [STATUS.PAUSED]: 'open',
  [STATUS.SCHEDULED]: 'open',
  [STATUS.CAR_FULL]: 'open',
  [STATUS.POWER_SHARING]: 'open',
  [STATUS.POWER_BOOST]: 'open',
  [STATUS.ECO_SMART]: 'open',
  [STATUS.MID_FAILED]: 'open',
  [STATUS.MID_MARGIN]: 'open',
  [STATUS.SESSION_FINISHED]: 'open',
  [STATUS.READY]: 'none',
  [STATUS.LOCKED]: 'none',
  [STATUS.LOCKED_CAR]: 'none',
  [STATUS.UPDATING]: null,
  [STATUS.ERROR]: null,
  [STATUS.OFFLINE]: null,
  [STATUS.UNKNOWN]: null
});

/**
 * Status groups, offered next to the detailed values in the "status is"
 * condition and "status changed" trigger. Ids share one dropdown with the
 * STATUS ids, hence the prefix. ANY matches every status (trigger only).
 */
const ANY = 'any';
const GROUP = Object.freeze({
  CHARGING: 'group_charging',
  PAUSED: 'group_paused',
  WAITING: 'group_waiting',
  LOCKED: 'group_locked',
  CAR_CONNECTED: 'group_car_connected',
  NO_CAR: 'group_no_car'
});
const GROUP_MEMBERS = Object.freeze({
  [GROUP.CHARGING]: [STATUS.CHARGING, STATUS.DISCHARGING],
  [GROUP.PAUSED]: [STATUS.PAUSED],
  [GROUP.WAITING]: [STATUS.SCHEDULED, STATUS.CAR_FULL, STATUS.POWER_SHARING, STATUS.POWER_BOOST,
    STATUS.ECO_SMART, STATUS.MID_FAILED, STATUS.MID_MARGIN, STATUS.SESSION_FINISHED],
  [GROUP.LOCKED]: [STATUS.LOCKED, STATUS.LOCKED_CAR],
  [GROUP.CAR_CONNECTED]: Object.keys(CAR_CONNECTED).filter(status => CAR_CONNECTED[status] === true),
  [GROUP.NO_CAR]: Object.keys(CAR_CONNECTED).filter(status => CAR_CONNECTED[status] === false)
});

/**
 * Eco-Smart (solar charging) mode, value ids of the `eco_smart` capability.
 * null in a Snapshot: the charger has no Eco-Smart.
 */
const ECO_SMART = Object.freeze({
  OFF: 'off',
  ECO: 'eco', // config_data.ecosmart.mode 0
  FULL_SOLAR: 'full_solar' // config_data.ecosmart.mode 1
});

/**
 * Commands checked after the follow-up poll
 */
const COMMAND = Object.freeze({
  START: 'start',
  STOP: 'stop'
});

/**
 * Why the charger didn't follow a Start or Stop ("not_followed" trigger)
 */
const REASON = Object.freeze({
  STILL_PAUSED: 'still_paused',
  STILL_CHARGING: 'still_charging', // Stop not followed
  CAR_FULL: 'car_full',
  WAITING_FOR_SOLAR: 'waiting_for_solar',
  WAITING_FOR_POWER: 'waiting_for_power', // power sharing or power boost queue
  SCHEDULED: 'scheduled',
  SESSION_FINISHED: 'session_finished',
  LOCKED: 'locked',
  NO_CAR: 'no_car',
  CHARGER_FAULT: 'charger_fault' // error, MID failed, MID margin
});

/**
 * Reason per status after a Start. undefined = followed (charging or
 * discharging: power flows),
 * 'wait' = not conclusive, check again at the next poll.
 * Waiting reasons only count when 2 polls in a row show a waiting status
 * (a resume may pass Waiting before Charging).
 */
const START_REASON = Object.freeze({
  [STATUS.PAUSED]: REASON.STILL_PAUSED,
  [STATUS.SCHEDULED]: REASON.SCHEDULED,
  [STATUS.CAR_FULL]: REASON.CAR_FULL,
  [STATUS.POWER_SHARING]: REASON.WAITING_FOR_POWER,
  [STATUS.POWER_BOOST]: REASON.WAITING_FOR_POWER,
  [STATUS.ECO_SMART]: REASON.WAITING_FOR_SOLAR,
  [STATUS.SESSION_FINISHED]: REASON.SESSION_FINISHED,
  [STATUS.MID_FAILED]: REASON.CHARGER_FAULT,
  [STATUS.MID_MARGIN]: REASON.CHARGER_FAULT,
  [STATUS.ERROR]: REASON.CHARGER_FAULT,
  [STATUS.LOCKED]: REASON.LOCKED,
  [STATUS.LOCKED_CAR]: REASON.LOCKED,
  [STATUS.READY]: REASON.NO_CAR,
  [STATUS.UPDATING]: 'wait',
  [STATUS.OFFLINE]: 'wait',
  [STATUS.UNKNOWN]: 'wait'
});

/**
 * Error codes of WallboxError (lib/wallbox/errors.js)
 */
const ERR = Object.freeze({
  THROTTLED: 'throttled', // 429, 403 on a GET, or our own budget is used up
  AUTH_REJECTED: 'auth_rejected', // sign-in refused: wrong e-mail or password
  REFUSED: 'refused', // 403 on a write: charger refused (no car, locked)
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  HTTP: 'http', // other non-2xx status
  BAD_RESPONSE: 'bad_response' // 2xx but not the expected JSON
});

/**
 * Translation keys (locales/*.json). English text in the comments; __x__ are
 * variables passed to homey.__().
 */
const MSG = Object.freeze({
  LOGIN: 'errors.login', // "Wallbox login failed: e-mail or password rejected. Repair the device to log in again."
  BUSY: 'errors.busy', // "Wallbox is busy (too many requests), try again in __minutes__ min."
  NO_CAR: 'errors.no_car', // "No car connected."
  LOCKED: 'errors.locked', // "The charger is locked. Unlock it first."
  REFUSED: 'errors.refused', // "The charger refused in its current state (no car connected, charger locked, or not in a state for this command)."
  TIMEOUT: 'errors.timeout', // "Wallbox did not answer in time."
  NETWORK: 'errors.network', // "Wallbox cloud not reachable."
  FAILED: 'errors.failed', // "Wallbox request failed (__status__)."
  HOMEY_CONTROLS: 'errors.homey_controls', // "Homey Energy controls this charger. Set target power mode to Automatic first."
  NOT_REACHABLE: 'errors.not_reachable', // "Charger not reachable on this Wallbox account."
  CURRENT_RANGE: 'errors.current_range' // "Charging current must be between __min__ and __max__ A."
});

/**
 * Capability ids used by the driver
 */
const CAP = Object.freeze({
  STATUS: 'status',
  STATUS_CODE: 'status_code',
  CAR_CONNECTED: 'car_connected',
  CHARGING_STATE: 'evcharger_charging_state',
  CHARGING: 'evcharger_charging',
  LOCKED: 'locked',
  POWER: 'measure_power',
  CURRENT: 'measure_current', // flowing current per phase, derived from power
  MAX_CURRENT: 'max_charging_current', // set maximum current
  ECO_SMART: 'eco_smart',
  LAST_UPDATED: 'last_updated',
  ALARM: 'alarm_connectivity',
  SESSION_ENERGY: 'meter_power.charged',
  TOTAL_ENERGY: 'meter_power.total',
  GREEN_ENERGY: 'meter_power.green', // added when the charger can do solar or did
  TARGET_POWER: 'target_power',
  TARGET_MODE: 'target_power_mode'
});

const MODE = Object.freeze({ DEVICE: 'device', HOMEY: 'homey' });

/**
 * Flow card ids, their argument names and token names
 */
const FLOW = Object.freeze({
  TRIGGER: Object.freeze({
    STATUS_CHANGED: 'charger_status_changed', // not status_changed: Homey fires that id itself for the status capability; arg `status` (STATUS, GROUP or ANY); tokens old_status, new_status (titles), old_status_id, new_status_id
    CAR_CONNECTED: 'car_connected',
    CAR_DISCONNECTED: 'car_disconnected',
    SESSION_ENDED: 'session_ended', // tokens kwh, green_kwh (numbers)
    NOT_FOLLOWED: 'not_followed', // tokens command, reason (titles), command_id, reason_id
    ECO_SMART_CHANGED: 'eco_smart_mode_changed', // not eco_smart_changed (Homey fires that itself); tokens mode (title), mode_id; also when changed in the Wallbox app
    MAX_CURRENT_CHANGED: 'max_current_changed' // token amps (number); also when changed in the Wallbox app
  }),
  CONDITION: Object.freeze({
    STATUS_IS: 'status_is', // arg `status` (STATUS or GROUP)
    CAR_IS_CONNECTED: 'car_is_connected',
    ECO_SMART_IS: 'eco_smart_is', // arg `mode` (ECO_SMART)
    PAUSED_BY_HOMEY: 'paused_by_homey' // the app paused it for target power (not the user, car or solar)
  }),
  ACTION: Object.freeze({
    CHANGE_AMPERE: 'change_ampere', // arg `ampere` (6..32); tokens result (sent|queued|unchanged), amps, seconds
    SET_ECO_SMART: 'set_eco_smart' // arg `mode` (ECO_SMART)
  })
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * Timings and limits
 */
const TIMING = Object.freeze({
  FETCH_TIMEOUT: 30 * SECOND,
  FOLLOW_DELAY: 30 * SECOND, // next poll after a Start or Stop
  FOLLOW_EXPIRE: 10 * MINUTE, // give up a follow check
  INCREASE_WINDOW: MINUTE, // at most one current increase per window
  BACKOFF: Object.freeze([2 * MINUTE, 4 * MINUTE, 8 * MINUTE, 15 * MINUTE]),
  RETRY_EXPIRE: 30 * MINUTE, // throttled safety commands are retried this long
  TARGET_PAUSE_EXPIRE: 10 * MINUTE, // own pause not seen in a poll by then is forgotten
  GET_BUDGET: Object.freeze({ count: 3, per: MINUTE }), // per account
  WRITE_BUDGET: Object.freeze({ count: 5, per: MINUTE }), // per account
  BUDGET_WAIT: 30 * SECOND, // wait this long for budget, else throttled
  POLL_DEFAULT: 120, // seconds, setting `polling`
  POLL_MIN: 90,
  POLL_MAX: 600,
  POLL_PER_CHARGER: 60, // seconds: interval is at least chargers on the account x this
  HISTORY_SPACING: MINUTE, // between history requests, all chargers
  HISTORY_FIRST_DELAY: 3 * MINUTE, // first history load after start
  HISTORY_LOAD_TIMEOUT: 30 * MINUTE
});

const VOLT = 230;
const MIN_AMP = 6;
const MAX_AMP = 32;

/**
 * @typedef {Object} Snapshot - one poll of chargers/status, parsed (lib/charger/view.js parseSnapshot)
 * @property {number} at - poll time, ms
 * @property {number|null} statusId - raw status_id
 * @property {string|null} status - STATUS id, null when the id is not in STATUS_IDS
 * @property {boolean|null} locked - config_data.locked, null without config_data
 * @property {number|null} maxCurrent - set current, A (config_data.max_charging_current)
 * @property {number|null} maxAvailable - highest settable current, A (config_data.max_available_current)
 * @property {number} powerKw - charging_power, kW (may be stale while not charging)
 * @property {number|null} addedKwh - added_energy of the current or last session
 * @property {number} addedGreenKwh - added_green_energy, 0 when missing
 * @property {string|null} ecoSmart - ECO_SMART id, null when the charger has no Eco-Smart
 * @property {number|null} lastSync - last_sync of the charger, ms (UTC), null when missing.
 *   Wallbox updates it when the charger reports a change, not as a heartbeat:
 *   an old value is normal for an idle charger
 */

/**
 * @typedef {Object} View - effective device state after a poll (keep-previous rules applied)
 * @property {number} at - poll time, ms (Snapshot.at)
 * @property {string} status - STATUS id (previous one kept for unknown ids)
 * @property {number|null} statusCode - raw status_id
 * @property {boolean|null} carConnected - previous value kept when unknown
 * @property {string|null} chargingState - CHARGING_STATE, previous kept when unknown
 * @property {boolean} charging - status is CHARGING
 * @property {boolean|null} locked - previous one kept when the poll has no config_data
 * @property {number} powerW - 0 unless charging or discharging
 * @property {number} currentA - flowing current per phase, powerW / (VOLT x phases), 0 when not flowing
 * @property {number|null} maxCurrent
 * @property {number|null} maxAvailable
 * @property {string|null} ecoSmart
 * @property {number|null} lastSync - ms
 * @property {string|null} lastUpdated - lastSync as local text "YYYY-MM-DD HH:MM"
 * @property {boolean|null} sessionOpen - a charging session is open (SESSION_STATE), kept when unknown
 * @property {number|null} sessionKwh - meter_power.charged: added_energy of a poll with an open session, else kept
 * @property {number} sessionGreenKwh - added_green_energy of that poll, else kept
 * @property {number|null|undefined} plugKwh - added_energy before this plug-in (the last session), undefined when no plug-in was seen
 * @property {boolean} charged - energy was added since the plug-in (session_ended fires on the unplug)
 * @property {number|null} addedKwh
 * @property {number} addedGreenKwh
 */

module.exports = {
  STATUS,
  STATUS_IDS,
  CAR_CONNECTED,
  CHARGING_STATE,
  CHARGING_STATE_BY_STATUS,
  SESSION_STATE,
  ANY,
  GROUP,
  GROUP_MEMBERS,
  ECO_SMART,
  COMMAND,
  REASON,
  START_REASON,
  ERR,
  MSG,
  CAP,
  MODE,
  FLOW,
  TIMING,
  VOLT,
  MIN_AMP,
  MAX_AMP
};

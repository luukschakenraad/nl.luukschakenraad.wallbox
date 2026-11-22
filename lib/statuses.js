
/**
 * Status names. These are the value ids of the custom `status` capability
 * (.homeycompose/capabilities/status.json). Homey stores them on the device
 * and uses them in flows, so never change a value, only add new ones.
 */
const STATUS = Object.freeze({
  CHARGING: 'Charging',
  WAITING: 'Waiting',
  READY: 'Ready',
  PAUSED: 'Paused',
  DISCHARGING: 'Discharging',
  ERROR: 'Error',
  DISCONNECTED: 'Disconnected',
  LOCKED: 'Locked',
  LOCKED_CAR_CONNECTED: 'LockedCarConnected',
  UPDATING: 'Updating'
});

/**
 * Values of Homey's system capability `evcharger_charging_state`
 */
const CHARGING_STATE = Object.freeze({
  PLUGGED_OUT: 'plugged_out',
  PLUGGED_IN: 'plugged_in',
  PLUGGED_IN_CHARGING: 'plugged_in_charging',
  PLUGGED_IN_DISCHARGING: 'plugged_in_discharging',
  PLUGGED_IN_PAUSED: 'plugged_in_paused'
});

exports.STATUS = STATUS;
exports.CHARGING_STATE = CHARGING_STATE;

/**
 * Relations between statusses and statusIDs
 */
exports.statuses = {
  [STATUS.CHARGING]: [193, 194, 195],
  // 177 and 179 are Wallbox's "Scheduled" status: the car is connected but
  // charging is being held off until the configured schedule starts. They
  // were previously missing here, which caused getStatus() to return
  // `undefined` for a scheduled charger and made the device look
  // disconnected in Homey even though the car was plugged in.
  [STATUS.WAITING]: [164, 177, 179, 180, 181, 183, 184, 185, 186, 187, 188, 189],
  [STATUS.READY]: [161, 162],
  [STATUS.PAUSED]: [178, 182],
  [STATUS.DISCHARGING]: [196],
  [STATUS.ERROR]: [14, 15],
  [STATUS.DISCONNECTED]: [0, 163, null, undefined],
  // 209 and 165 are "Locked" without a car, 210 is "Locked, car connected"
  [STATUS.LOCKED]: [209, 165],
  [STATUS.LOCKED_CAR_CONNECTED]: [210],
  [STATUS.UPDATING]: [166]
}

exports.chargingState = {
  [STATUS.CHARGING]: CHARGING_STATE.PLUGGED_IN_CHARGING,
  [STATUS.WAITING]: CHARGING_STATE.PLUGGED_IN,
  [STATUS.READY]: CHARGING_STATE.PLUGGED_OUT,
  [STATUS.PAUSED]: CHARGING_STATE.PLUGGED_IN_PAUSED,
  [STATUS.DISCHARGING]: CHARGING_STATE.PLUGGED_IN_DISCHARGING,
  [STATUS.ERROR]: CHARGING_STATE.PLUGGED_OUT,
  [STATUS.DISCONNECTED]: CHARGING_STATE.PLUGGED_OUT,
  [STATUS.LOCKED]: CHARGING_STATE.PLUGGED_OUT,
  [STATUS.LOCKED_CAR_CONNECTED]: CHARGING_STATE.PLUGGED_IN_PAUSED,
  [STATUS.UPDATING]: CHARGING_STATE.PLUGGED_OUT
}

/**
 * Get the status based on status ID
 *
 * @param {int} statusId - statusId to get official status from
 * @return {String} - Current status or undefined if not found
 */
exports.getStatus = function(statusId){

    let found = undefined
  for (const [key, value] of Object.entries(this.statuses)){
    found = value.find(id => id == statusId)

    if (found != undefined)
      return key
  }

  return undefined
}

/**
 * Get the Homey EV charging state based on Status
 *
 * @param {String} status - status
 * @return {String} - Current homey ev charging state
 */
exports.getChargingState = function(status){
  return this.chargingState[status];
}
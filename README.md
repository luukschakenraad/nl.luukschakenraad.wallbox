# Wallbox EV for Homey

Unofficial community app for Wallbox EV chargers on Homey. Not affiliated with Wallbox or Athom.

Based on [Wallbox Charger](https://github.com/rkokkelk/nl.xseth.wallbox) (`nl.xseth.wallbox`) by Roy K and contributors, licensed under GPL-3.0. This is a modified version, rebuilt with a new architecture (see [ARCHITECTURE.md](ARCHITECTURE.md)); the changes are listed below and in the git history.

## What's different
* **Detailed status:** every Wallbox reason (scheduled, car full, power sharing, power boost, waiting for solar, locked with car, …), plus the raw Wallbox status number.
* **Car connected** as its own value and flow cards, reliable for every state from connected on.
* **Commands are checked:**
  * Start and stop are checked at the next poll, 30 s later, and a trigger tells you when the charger didn't follow, with the reason.
  * Stop while not charging and start while charging simply succeed.
* **Built for the Wallbox rate limits:**
  * one login per account, tokens kept over restarts
  * no extra reads around commands
  * current changes skipped when nothing changes; increases at most once a minute, decreases at once
  * back-off when Wallbox is busy
* **Others may change the charger too:** the app trusts the latest poll, not its own last command.
* **Target power (Homey Energy):**
  * only in Homey mode; new chargers start in Automatic
  * the current follows the target, rounded down, using the phases the car charges on
  * pauses below the minimum, and only resumes its own pause
* **Power and current:** power is 0 W as soon as charging stops; measure_current is the current that flows, and the set maximum has its own value.
* **Connection alarm:** shown when the Wallbox cloud can't be reached or is busy. The device stays usable; only a rejected login needs a repair.
* **Polling interval** is a setting (90–600 s).
* **Lifetime energy meter** for Homey Energy (total, and green energy when solar charging was used).

## Features
* Status, charging state, car connected, power, current, energy of the current session, lifetime energy
* Start and stop charging, set the charging current, lock and unlock
* Solar charging (Eco-Smart) flow action, and the Eco-Smart mode as a value
* Triggers:
  * status changed
  * car connected / disconnected
  * session ended (kWh)
  * charger didn't follow a command
  * Eco-Smart mode changed
  * charging current setting changed (also from the Wallbox app)
* Conditions:
  * status is (single statuses or groups)
  * car is connected
  * Eco-Smart is
  * charging is paused by Homey Energy
* Target power and target power mode for Homey Energy

## Setup
The app uses the Wallbox cloud. Connect the charger to the internet, add it in Homey and log in with your Wallbox account. If the password changes, use "Repair" on the device.

## Development
`node --test test/` runs the tests; `npx homey app validate --level publish` checks the manifest.

## Credits
* Roy K ([rkokkelk](https://github.com/rkokkelk)) and the contributors of Wallbox Charger
* [Phatenl](https://github.com/phatenl/nl.phate.goecharger), whose app code the original app learned from

## License
GPL-3.0, see [LICENSE](LICENSE).

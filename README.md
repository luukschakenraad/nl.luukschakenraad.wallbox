# Wallbox EV for Homey

Unofficial community app for Wallbox EV chargers on Homey. Not affiliated with Wallbox or Athom.

Based on [Wallbox Charger](https://github.com/rkokkelk/nl.xseth.wallbox) (`nl.xseth.wallbox`) by Roy K and contributors, licensed under GPL-3.0. This is a modified version: the changes are listed below and in the git history.

## What's different
* "Start charging" resumes a paused charger.
* Target power (Homey Energy) starts and pauses charging, and uses the phases the car charges on, measured from the charger's power and set current.
* Lifetime energy meter for Homey Energy (total, and green energy when solar charging was used).

## Features
* Status, charging state, power, current and energy of the current session
* Start and stop charging, set the charging current, lock and unlock
* Solar charging (Eco-Smart) flow action
* Target power and target power mode for Homey Energy

## Setup
The app uses the Wallbox cloud. Connect the charger to the internet, add it in Homey and log in with your Wallbox account.

## Credits
* Roy K ([rkokkelk](https://github.com/rkokkelk)) and the contributors of Wallbox Charger
* [Phatenl](https://github.com/phatenl/nl.phate.goecharger), whose app code the original app learned from

## License
GPL-3.0, see [LICENSE](LICENSE).

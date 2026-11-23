# Wallbox EV for Homey

Unofficial community app for Wallbox EV chargers on Homey. Not affiliated with Wallbox or Athom.

Based on [Wallbox Charger](https://github.com/rkokkelk/nl.xseth.wallbox) (`nl.xseth.wallbox`) by Roy K and contributors, licensed under GPL-3.0. This is a modified version, rebuilt with a new architecture (see [ARCHITECTURE.md](ARCHITECTURE.md)); the changes are listed below and in the git history.

## What's different
* **Detailed status:** every Wallbox reason (scheduled, car full, power sharing, power boost, waiting for solar, locked with car, …), plus the raw Wallbox status number. The flow cards offer single statuses and groups (charging, paused, waiting for any reason, locked, car connected, no car).
* **Car connected** as its own value and flow cards, true for every state from connected on, including "locked, car connected".
* **Commands are checked:**
  * The next poll, about 30 s after a start or stop, checks whether the charger followed. If not, a trigger tells you why (car full, waiting for solar or power, scheduled, locked, no car, still paused, still charging). A waiting reason needs a second poll to make sure.
  * When Wallbox refuses a start, the card says why ("No car connected", "The charger is locked"). Stop while not charging and start while charging simply succeed.
* **Built for the Wallbox rate limits:**
  * one login per account, tokens kept over restarts
  * no extra reads around commands; a write that changes nothing (same current, lock or Eco-Smart mode) isn't sent
  * the "Change charging current" card: decreases go out at once, increases at most once a minute (the newest value wins), with result tokens (sent, queued, unchanged)
  * back-off when Wallbox is busy, and several chargers on one account share the budget (at least 60 s per charger)
* **Others may change the charger too:** the app trusts the latest poll, not its own last command.
* **Target power (Homey Energy):**
  * only in target power mode "Homey"; new chargers start in "Automatic", where Homey Energy leaves the charger alone
  * the current follows the target, rounded down, using the phases the car charges on; in Homey mode it's set back at every poll, also after a change in the Wallbox app
  * pauses below the minimum, and only resumes its own pause (switching to Automatic resumes it too)
  * while Homey steers, a manual start with too low a target and the "Change charging current" card fail with a clear message
* **Power and current:** power shows 0 W at the first poll after charging stops (Wallbox keeps reporting the old power for minutes). measure_current is the current that flows (calculated from power and phases); the set maximum current has its own value. After 10 minutes without data, power and current go to 0.
* **Connection alarm:** on when the Wallbox cloud can't be reached or is busy, or the charger itself is offline. The device stays usable; only a rejected login needs a repair. A warning appears when the charger is no longer on the Wallbox account.
* **Last updated:** when the charger last reported a change to the Wallbox cloud (local time).
* **Polling interval** is a setting (90–600 s).
* **Lifetime energy meter** for Homey Energy (total, and green energy when solar charging was used), built from the Wallbox charging history.

## Features
* Values: status, raw status number, charging state, car connected, power, flowing current, set charging current, Eco-Smart mode, last updated, connection alarm, energy of the current session, lifetime energy, lifetime green energy
* Start and stop charging, set the charging current, lock and unlock
* Solar charging (Eco-Smart)
* Flow cards for status, car, session, commands, Eco-Smart and current: see [Flow cards](#flow-cards)
* Target power and target power mode for Homey Energy
* Several chargers per account, repair to log in again

## Flow cards
The app reads the charger from the Wallbox cloud at every poll (default every 2 minutes, plus one poll about 30 s after a start or stop). A trigger fires at the first poll that sees the change, so a change made in the Wallbox app shows up within one poll interval. The first poll after the app starts fires nothing, as there is nothing to compare with yet.

**Triggers**
| Card | Fires when | Tokens |
|---|---|---|
| Status changed | The status enters the chosen status or group. "Any status" fires on every change. Moving between two statuses of the same group doesn't fire for that group. | Old and new status, as a title and as an id |
| Car connected | A car is plugged in. A charger going offline or updating doesn't count. | |
| Car disconnected | The car is unplugged. | |
| Charging session ended | The car is unplugged after a real session. Not after only plugging in on a locked charger. | kWh and green kWh of that session |
| Charger did not follow a command | A start or stop from Homey wasn't followed. Checked from 30 s after the command. A waiting reason (car full, waiting for solar or power, scheduled, session finished) has to show at two polls in a row. The check gives up after 3 polls. | Command and reason, as a title and as an id |
| Eco-Smart mode changed | The solar charging mode changed, also when it was changed in the Wallbox app. | Mode, as a title and as an id |
| Charging current setting changed | The set maximum current changed: from the Wallbox app, a flow, or target power. | Current (A) |

**Status groups** (in "Status changed" and "Status is")
- **Charging:** charging, discharging
- **Paused:** paused
- **Waiting, any reason:** scheduled, car full, power sharing, power boost, waiting for solar, MID check failed, MID margin exceeded, session finished
- **Locked:** locked, locked with car
- **Car connected:** every status with a car connected
- **No car:** ready, locked

**Conditions**
| Card | True when |
|---|---|
| Status is | The status is the chosen status, or in the chosen group. |
| Car is connected | A car is connected. |
| Eco-Smart is | The solar charging mode is the chosen mode. |
| Charging is paused by Homey Energy | Target power paused charging (status paused), not you, the car or a solar or power wait. |

**Actions**
| Card | What it does |
|---|---|
| Change charging current | Sets the maximum current (6 A up to the charger's maximum).<br>An unchanged value isn't sent; a decrease goes out at once, an increase at most once a minute (the newest value wins).<br>Returns `sent`, `queued` or `unchanged`, with the amps and seconds.<br>Fails while target power mode is Homey. |
| Set Eco-Smart | Off, Eco mode or Full solar. Not sent when the charger already has that mode. |

Homey's own cards for EV chargers also work: start and stop charging, charging started or stopped, charging state changed, lock and unlock, target power and target power mode. Start and stop are checked by "Charger did not follow a command". In target power mode Homey, a start with too low a target fails.

## Setup
The app uses the Wallbox cloud. Connect the charger to the internet, add it in Homey and log in with your Wallbox account; add all chargers of the account in one go. If the password changes, use "Repair" on the device.

To let Homey Energy steer charging, set "Target power mode" to Homey. The polling interval (default 120 s) is in the device settings.

## Switching from Wallbox Charger
Wallbox EV is a separate app (`nl.luukschakenraad.wallbox`), not an update of Wallbox Charger (`nl.xseth.wallbox`).
* **Pair again:** add the charger in Wallbox EV, then remove or disable Wallbox Charger. Both apps would share the request limit of your Wallbox account.
* **Rebuild your flows:** the cards and the status values are different. Many old workarounds have their own card now, for example car connected, session ended, or status "Locked, car connected".
* **History stays behind:** insights and the Homey Energy history of the old device don't move over. The lifetime meter is rebuilt from your Wallbox charging history, so its total is complete again.
* **Target power mode** starts in Automatic; switch to Homey if Homey Energy should steer.
* **Current:** `measure_current` is now the current that flows, and the set maximum is `max_charging_current`.
* **Scripts:** the "Change charging current" card accepts 6 A and more.

## Limits
* The Wallbox cloud gives no per-phase values: the flowing current is calculated from power and the phases the car charges on.
* A Wallbox schedule shows as status "Scheduled" while the car waits for it; there is no separate schedule flag.
* Switching between 1 and 3 phases isn't possible through the Wallbox cloud.

## Development
`node --test test/` runs the tests; `npx homey app validate --level publish` checks the manifest. The design is in [ARCHITECTURE.md](ARCHITECTURE.md), the rules for contributors (and AI agents) in [AGENTS.md](AGENTS.md).

## Credits
* Roy K ([rkokkelk](https://github.com/rkokkelk)) and the contributors of Wallbox Charger
* [Phatenl](https://github.com/phatenl/nl.phate.goecharger), whose app code the original app learned from

## License
GPL-3.0, see [LICENSE](LICENSE).

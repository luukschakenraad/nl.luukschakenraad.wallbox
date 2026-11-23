# AGENTS.md

Rules for working on this repo. `CLAUDE.md` and `GEMINI.md` only import this file: change the rules here.

## What this is
**Wallbox EV**: a Homey app (SDK v3, Node, CommonJS) for Wallbox EV chargers, through the Wallbox cloud API.
- App id: `nl.luukschakenraad.wallbox`
- License: GPL-3.0, based on Wallbox Charger by Roy K
- Design: read [ARCHITECTURE.md](ARCHITECTURE.md) and [lib/contract.js](lib/contract.js) before changing anything. All ids, tables, timings and interfaces live there.

## Commands
```bash
node --test test/                            # all tests (Node 18+, no dependencies)
npx homey app validate --level publish       # manifest check, also regenerates app.json
```
- **Lint:** `.eslintrc.json` (eslint 8, `standard` + `plugin:homey-app`, with overrides). The packages aren't in the repo, so lint only works where they are installed.
- **Never run `homey app install --clean`:** it wipes the devices.
- **Installing on a Homey and publishing:** only the maintainer does these.

## Layout
| Path | What |
|---|---|
| `app.js`, `drivers/wallbox/{device,driver}.js` | Thin Homey adapter: capabilities, flow cards, settings, pairing, repair, availability |
| `lib/wallbox/{account,api,errors}.js` | Cloud client: one account client per Wallbox login, with tokens, request budget, back-off and timeouts |
| `lib/charger/view.js` | Pure: raw status → Snapshot → View → capability values, flow triggers, status groups |
| `lib/charger/decide.js` | Pure decisions: amps for a target power, reconcile, current throttle, follow check |
| `lib/charger/controller.js`, `lib/poller.js` | Run the decisions: commands, work after each poll, retries; the poll timer |
| `lib/phases.js`, `lib/energy.js` | Phases the car charges on; lifetime energy meter from the session history |
| `lib/writer.js` | `LatestWriter` (capability writes without waiting, newest value wins) and `bounded()` |
| `.homeycompose/`, `drivers/wallbox/*.compose.json`, `locales/` | Manifest sources |
| `test/*.test.js` | `node:test` suites with fakes, no network |

- **`app.json` is generated:** edit `.homeycompose/` and the `*.compose.json` files, run validate, then commit the regenerated `app.json` too.
- **`dev/` is git-ignored:** local probes, notes and an end-to-end harness on the real SDK, which only exist on the maintainer's machine.

## Core rules
1. **The latest poll is the truth.** Others (the Wallbox app, website, other integrations) change the charger at any time.
   - Decide on the latest polled View, never on our own last write.
   - "Unchanged" means equal to the latest poll.
   - A PUT response counts only until the next poll.
2. **Wallbox rate limits are strict and unpublished.** Reports range from 1 request per minute per account, to 3 GET plus 5 writes per minute, to 5 per 5 minutes on some endpoints; sign-in is limited too.
   - Every request goes through `Account.request` (budget, back-off on 429, and on a 403 to a GET; a 403 on a status GET backs off only that charger).
   - Don't add read-backs or polls around commands. The one poll asked for: about 30 s after a pause or resume (Start, Stop, target power), for the follow check and to confirm an own pause.
   - Skip writes that change nothing.
   - Keep the chargers of an account spread over the interval (the poller's phase, slot × 60 s after a throttle).
3. **Homey-free libraries:** everything in `lib/` gets its clock, timers, fetch and storage injected, so it runs under `node --test`. In the app, use only `this.homey.setTimeout`/`setInterval`, never the globals.
4. **Never wait on Homey in a shared path.** Homey may answer a call late or never, and the SDK has no time limit.
   - Capability values go through the `LatestWriter` in `drivers/wallbox/device.js` (`lib/writer.js`): the caller goes on at once, the newest value wins, reads see it at once. Conditions and the controller read that newest value (`device.latest`, `caps.get`), not Homey's answered one.
   - Store, availability and warning are plain calls that nobody waits for (`device.later()`, logged after 30 s without an answer); availability and warning are sent only on a change, warnings one at a time.
   - Flow triggers are fired without waiting.
   - One-off waits such as startup get a time limit with `bounded()`.
   - Never `await` a Homey call inside the poll, the controller's write queue or the energy meter.
   - A poll answered after a newer one changes nothing (poll numbers, `View.at`).
   - Never throw from a poll.
5. **Privacy:** no e-mail, password, token, serial number or charger object in logs, error messages, tests or fixtures. Error messages come from `lib/wallbox/errors.js` and the `MSG` keys in `locales/*.json`.
6. **Status values are stored by Homey and used in flows:** add new values, never rename one (`lib/contract.js` STATUS and the `status` capability).
7. **Unlocking stays a manual action.** The app never unlocks on its own.
8. **Keep it simple.** Do it the way Homey's own examples do (plain SDK calls, fixed manifest options) unless a measured problem needs more. Use the existing pieces (`decide.js` functions, `LatestWriter`, `bounded()`, `Poller`, `Account`) before adding a layer, and guard a case in one place only. Pure logic goes in `lib/`, the Homey adapter stays thin.
9. **Flow cards are documented for users** in README "Flow cards" (when each trigger fires, the tokens). Change that table together with the behaviour. Every card has a `hint` in en, nl and fr with the same facts (checked by `test/manifest.test.js`); Homey's own capability cards can't get one.
10. **Logs:** failures, slow steps (poll or trigger over 10 s, Homey calls over 30 s) and writes sent to Wallbox. No line per poll.

## Behaviour that is decided (don't "fix" it)
- **Target power** only acts in target power mode Homey; new devices start in Automatic.
  - In Homey mode the amps follow the target at every poll, also after a change in the Wallbox app.
  - It pauses below the minimum, and resumes only its own pause.
  - Automatic undoes the app's own confirmed pause: at the switch and at every poll after it (also a pause confirmed after the switch, or a resume that was throttled).
  - Manual Start (target too low) and the current card fail in Homey mode. A failed Start or Stop keeps the target power and mode of its batch (set again: Homey drops a refused batch).
- **Current changes:** not sent when unchanged; a decrease goes out at once, an increase at most once a minute (the newest wins). Watts to amps rounds down, minimum 6 A, with the phases seen this session (a new 3-phase car gets 3-phase amps at once). The card rounds a fraction down.
- **Target power slider:** a fixed range in the manifest (0 to 22080 W, step 230, nothing between 0 and 1380 W), as Homey's docs ask ("the widest possible min/max range"; the driver handles the phases). Homey itself rounds a target to the step and turns a value in the excluded range into 0. Not set per charger at runtime (setCapabilityOptions is expensive); only at init, once, when a device still has the options of an earlier build.
- **Start always resumes**, except a resume we sent moments ago with no newer poll since.
  - A refused Stop while not charging, and a refused Start while charging, count as done.
  - After a Start or Stop, the next poll comes about 30 s later and the follow check fires "didn't follow" with the reason. It counts from when Wallbox answered the command, and asks for its poll again when a regular poll came first.
  - The current card, lock and Eco-Smart get no extra poll.
- **Availability:** the device stays available on cloud errors, and `alarm_connectivity` shows them. Only a rejected login makes it unavailable; repair fixes it. No alarm from the age of `last_sync`.
- **Statuses** keep the previous car and charging state while offline, updating or unknown.
- **Session ended** fires on the unplug once energy was added since the plug-in (at the plug-in Wallbox still shows the last session's added_energy), also when the charger locked before the unplug.
- **Stale values:** after 10 minutes without a good poll, counted from the start, power and current go to 0 (also while the login is rejected).

## Facts measured on a real charger (Commander 2)
- **Tokens:** a token lives 15 min, a refresh token 60 days. The TTLs are epoch ms.
- **`last_sync`:** UTC "YYYY-MM-DD HH:MM:SS". It only changes when the charger reports a change, so it's no heartbeat.
- **Power after a pause:** `charging_power` stays at the old value for minutes. Only trust power while the status is charging or discharging.
- **Status lag:** after a pause or resume, the status is right within about 30 s.
- **Setting the current** (PUT `v2/charger/{id}` `{ maxChargingCurrent }`):
  - The response returns `data.chargerData.maxChargingCurrent`. It is capped at the maximum, but values below 6 are echoed while the charger applies 6 (seen at the next poll).
  - 0 A comes back as 6.
- **403 "Wrong current status":** sent for pause while paused and for resume while charging. The controller treats these as done when the latest poll agrees.
- **`config_data.locked`** is the lock setting, which can be 1 during an active session. "Can it charge now" comes from the status (209/210 = locked).
- **`v4/sessions/stats`** returns every session of a long range in one request (554 sessions, 840 kB, checked). `meta.count` > rows means incomplete, so fall back to per year.
- **Phases:** the API has no phase or per-phase current field. The phases come from power ÷ (230 V × set current).

## Homey SDK v3 notes
- **Calls into Homey have no time limit:** `HomeyClient.emit` waits for the host without any timeout. This covers setCapabilityValue, setStoreValue, setAvailable/setUnavailable, setWarning, setCapabilityOptions, addCapability and flow triggers.
  - **setCapabilityValue** is queued per capability, and its local value changes only after Homey answered. A trigger fired right after it reaches Homey first.
  - **setWarning** skips a value equal to the last one Homey answered, and has no queue.
  - **setStoreValue** changes the local store at once and sends the whole store.
  - **setAvailable/setUnavailable** share one queue.
  - **getCapabilityValue, getStoreValue and homey.settings** are local and synchronous.
- **One listener per capability:** `registerMultipleCapabilityListener` replaces an earlier single listener for the same capability.
- **Stored values:** a capability value is stored only after its listener resolves, a few microtasks after it (work queued meanwhile still reads the old value). A thrown error makes Homey drop every value of the batch, so target power errors are logged, not thrown.
- **Flow cards:** custom capabilities get no automatic flow cards; declare them in `driver.flow.compose.json`. Action cards may return tokens.
- **Trigger ids:** Homey fires a trigger card named `<capability>_changed` (or `<capability>_true`/`_false` for a boolean) by itself on every value change, with its own tokens. Never give a card such an id (that's why it's `charger_status_changed` and `eco_smart_mode_changed`). A renamed card id breaks the user's flows, so only rename before a release.
- **Last seen:** setCapabilityValue refreshes it, but unchanged values aren't written, so the device calls `setLastSeenAt()` after every good poll.
- **Versions:** `target_power` and `target_power_mode` need Homey 12.13.0, hence `compatibility: >=12.13.0`. From 12.9.0 every Homey model runs apps on Node 22, so Node's own `fetch` is always there: no `package.json`, no `node_modules`.

## Tests
- **Every behaviour change needs a test.** When a change alters an expected outcome on purpose, the test name says so, e.g. `(changed: was …)`.
- **Old behaviour stays covered:** keep the old scenarios, with new expectations where the design changed.
- **Fakes:** use them for the SDK, the api and the timers (see `test/device.test.js`, `test/controller.test.js`).
- **Hangs:** a Homey call that never answers is a fake that returns `new Promise(() => {})` (see the hang tests in `test/device.test.js`).
- **Real SDK (maintainer only):** `node dev/e2e/run.js <repo>` runs the app on the real SDK against a fake Wallbox cloud, including hang scenarios.

## Style and commits
- **Code:** CommonJS, `'use strict'`, 2-space indent, JSDoc on public functions. Follow each file's existing style; some files use semicolons and some don't.
- **Commit messages:** short and lowercase, `type(scope): summary` (e.g. `fix(energy): one request for all history`). Describe the change itself: no tool names, no co-author trailers. The same goes for code, comments, tests and docs.
- **Remote changes:** don't push, tag, publish or open issues/PRs without the maintainer's explicit OK.

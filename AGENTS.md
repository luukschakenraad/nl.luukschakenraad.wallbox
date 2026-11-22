# AGENTS.md

Instructions for AI coding agents (and humans) working on this repo. `CLAUDE.md` and `GEMINI.md` only import this file: change the rules here.

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
- **Installing on a Homey and publishing:** the maintainer does these, not an agent.

## Layout
| Path | What |
|---|---|
| `app.js`, `drivers/wallbox/{device,driver}.js` | Thin Homey adapter: capabilities, flow cards, settings, pairing, repair, availability |
| `lib/wallbox/{account,api,errors}.js` | Cloud client: one account client per Wallbox login, with tokens, request budget, back-off and timeouts |
| `lib/charger/view.js` | Pure: raw status → Snapshot → View → capability values, flow triggers, status groups |
| `lib/charger/decide.js` | Pure decisions: amps for a target power, reconcile, current throttle, follow check |
| `lib/charger/controller.js`, `lib/poller.js` | Run the decisions: commands, work after each poll, retries; the poll timer |
| `lib/phases.js`, `lib/energy.js` | Phases the car charges on; lifetime energy meter from the session history |
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
   - Every request goes through `Account.request` (budget, back-off on 429, and on a 403 to a GET).
   - Don't add read-backs or polls around commands.
   - Skip writes that change nothing.
3. **Homey-free libraries:** everything in `lib/` gets its clock, timers, fetch and storage injected, so it runs under `node --test`. In the app, use only `this.homey.setTimeout`/`setInterval`, never the globals.
4. **Never throw from a poll.** Await or catch every SDK promise.
5. **Privacy:** no e-mail, password, token, serial number or charger object in logs, error messages, tests or fixtures. Error messages come from `lib/wallbox/errors.js` and the `MSG` keys in `locales/*.json`.
6. **Status values are stored by Homey and used in flows:** add new values, never rename one (`lib/contract.js` STATUS and the `status` capability).
7. **Unlocking stays a manual action.** The app never unlocks on its own.

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
- **One listener per capability:** `registerMultipleCapabilityListener` replaces an earlier single listener for the same capability.
- **Stored values:** a capability value is stored only after its listener resolves. A thrown error makes Homey drop the new value, so target power errors are logged, not thrown.
- **Flow cards:** custom capabilities get no automatic flow cards; declare them in `driver.flow.compose.json`. Action cards may return tokens.

## Tests
- **Every behaviour change needs a test.** When a change alters an expected outcome on purpose, the test name says so, e.g. `(changed: was …)`.
- **Old behaviour stays covered:** keep the old scenarios, with new expectations where the design changed.
- **Fakes:** use them for the SDK, the api and the timers (see `test/device.test.js`, `test/controller.test.js`).

## Style and commits
- **Code:** CommonJS, `'use strict'`, 2-space indent, JSDoc on public functions. Follow each file's existing style; some files use semicolons and some don't.
- **Commit messages:** short and lowercase, `type(scope): summary` (e.g. `fix(energy): one request for all history`). No mention of AI tools, no co-author trailers.
- **Remote changes:** don't push, tag, publish or open issues/PRs without the maintainer's explicit OK.

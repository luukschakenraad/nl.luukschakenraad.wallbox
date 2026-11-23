# Architecture

All ids, tables and timings live in `lib/contract.js`. Every module except the Homey adapter is Homey-free: the clock, timers, fetch and storage are injected, so everything runs under `node --test test/`.

**Core rule:** others (the Wallbox app, website, other integrations) can change the charger at any time. The latest poll is the truth, never our own last write. "Unchanged" means equal to the latest polled value.

```
app.js ─ AccountRegistry, flow card listeners
drivers/wallbox/driver.js ─ pairing, repair
drivers/wallbox/device.js ─ Homey adapter: capabilities, triggers, settings, availability
   ├─ lib/wallbox/account.js  one client per Wallbox account: tokens, budget, back-off, timeouts
   ├─ lib/wallbox/api.js      endpoints on top of an Account
   ├─ lib/charger/view.js     raw status → Snapshot → View → capability values, triggers, groups
   ├─ lib/charger/decide.js   pure decisions: amps, reconcile, current throttle, follow check
   ├─ lib/charger/controller.js  runs the decisions: commands, onPoll, retries
   ├─ lib/poller.js           poll timer
   ├─ lib/phases.js           phases the car charges on
   └─ lib/energy.js           lifetime energy meter
```

Shared injected types:
- `now()` returns the time in ms.
- `timers = { setTimeout(fn, ms), clearTimeout(handle) }`.
- `store = { get(key), set(key, value) → Promise }`.
- `log(message)`.
- `t(key, vars)` translates (homey.__).

## lib/wallbox/errors.js
`class WallboxError extends Error`, `new WallboxError(code, { status, retryAt, sent, message })`. Fields:
- `code`: an `ERR` id.
- `status`: the HTTP status or null.
- `retryAt`: ms, for `throttled`.
- `sent`: whether the request reached Wallbox.

The message never contains an e-mail, password, token, serial or URL query.

## lib/wallbox/account.js
`new Account({ username, password, fetch, now, timers, persist, log, userAgent })`
- `persist = { load() → tokens|null, save(tokens|null) }`, with `tokens = { jwt, jwtTtl, refresh, refreshTtl }`. The TTLs are epoch ms.
- `request(method, path, { body, host: 'api'|'user' })` returns the parsed JSON, or null for an empty body. It throws a `WallboxError`.
  - It signs in, refreshes and persists tokens by itself.
  - On a 401 it refreshes once, then retries once.
  - A sign-in 401/403 gives `auth_rejected`, and there are no sign-ins after that until `setCredentials`.
  - A 429, or a 403 on a GET, gives `throttled`. It sets `blockedUntil` from Retry-After, else from `TIMING.BACKOFF` (2/4/8/15 min, rising per throttle in a row; a success resets it).
  - While blocked, it throws `throttled` with `sent: false` and doesn't fetch.
  - A 403 on a write gives `refused`.
  - Budget: sliding windows `TIMING.GET_BUDGET` and `TIMING.WRITE_BUDGET`. It waits up to `TIMING.BUDGET_WAIT` for room, else throws `throttled` with `sent: false`.
  - Every fetch has a `TIMING.FETCH_TIMEOUT` timeout and gives `timeout`; network errors give `network`.
- `rejected` (boolean), `blockedUntil` (ms, 0 when free).
- `setCredentials(username, password)` clears the tokens, `rejected` and the back-off.
- `register(chargerId)`, `unregister(chargerId)`, `chargerCount`, `slot(chargerId)` (the index in the sorted ids, used to stagger polls).

`AccountRegistry({ create(username, password) → Account })`
- `get(username, password)` returns the same Account per account. The key is sha256 of the trimmed, lower-case e-mail.
- `key(username)`.
- `remove(username)`.

## lib/wallbox/api.js
`new WallboxApi(account)`. Hosts: `api` is https://api.wall-box.com/, `user` is https://user-api.wall-box.com/.
- `listChargers()` returns `[{ id, name }]` (v3/chargers/groups).
- `getStatus(id)` returns the raw JSON (chargers/status/{id}).
- `setCurrent(id, amps)` returns the amps set. It does a PUT v2/charger/{id} `{ maxChargingCurrent }` with no GET before it. The value comes from `data.chargerData.maxChargingCurrent` in the response, else the requested amps.
- `setLocked(id, locked)` (PUT v2/charger/{id} `{ locked: 0|1 }`).
- `pause(id)` and `resume(id)` (POST v3/chargers/{id}/remote-action, action 2 and 1).
- `setEcoSmart(id, mode)`, with mode an `ECO_SMART` id (PUT v4/chargers/{id}/eco-smart).
- `sessions(id, start, end)` returns the raw JSON (v4/sessions/stats; start and end in seconds).

## lib/charger/view.js
- `parseSnapshot(raw, now)` returns a `Snapshot`. `last_sync` "YYYY-MM-DD HH:MM:SS" is read as UTC.
- `statusOf(statusId)` returns a `STATUS` id or null (null and undefined give `offline`).
- `toView(snapshot, prev, { phases, timezone, now })` returns a `View`.
  - `prev` is the previous View or null.
  - An unknown id keeps `prev.status`, or `unknown` when there is none.
  - A null car keeps the previous car_connected and charging state.
- `capabilityValues(view)` returns `{ [CAP id]: value }` for every View-driven capability: status, status_code, car_connected, evcharger_charging_state, evcharger_charging, locked, measure_power, measure_current, max_charging_current, eco_smart, last_updated, meter_power.charged. A null value means "don't set".
- `transitions(prev, next)` returns `[{ trigger, tokens, state }]`:
  - status_changed: tokens `{ old_status, new_status }` (STATUS ids; the adapter turns them into titles), state `{ old, new }`.
  - car_connected and car_disconnected, only on true↔false (never on null).
  - session_ended on car disconnect, tokens `{ kwh, green_kwh }` from prev.
  - No events when prev is null.
- `matches(selection, status)` takes a STATUS, GROUP or ANY.
- `statusTriggerMatches(selection, state)` is true when the status enters the selection: it matches `state.new` and not `state.old`. ANY matches every change.

## lib/charger/decide.js (pure)
- `ampsForPower(watts, phases, maxAvailable)` = floor(W / (VOLT × phases)), clamped to MIN_AMP .. min(maxAvailable, MAX_AMP).
- `minPower(measuredPhases)` = MIN_AMP × VOLT × measuredPhases.
- `targetOptions(maxAvailable, phases, measuredPhases)` returns `{ min: 0, max, step: VOLT × phases, excludeMin: 0, excludeMax: minPower }`.
- `reconcile({ view, mode, target, phases, measuredPhases, targetPaused, now })` returns `{ amps, action: 'pause'|'resume'|null, targetPaused }`.
  - It only acts in Homey mode.
  - The amps always follow a target at or above the minimum while a car is connected; amps equal to `view.maxCurrent`, or a target below the minimum, give null (no write).
  - Pause when the target is below the minimum and the status is charging or discharging.
  - Resume only an own, confirmed pause, from `paused`, when the target is at or above the minimum.
  - `targetPaused` is `{ at, confirmed }` or null:
    - a poll showing paused confirms it;
    - after confirmation, any non-paused status clears it;
    - no car clears it;
    - unconfirmed after `TIMING.TARGET_PAUSE_EXPIRE`, it's dropped.
- `planCurrent({ wanted, observed, lastIncreaseAt, queued, now })` returns `{ send: amps|null, queue: { amps, at }|null }`.
  - Equal to `observed` (the latest poll, or the last PUT response after it): skip.
  - A decrease is sent at once and drops a queued increase.
  - An increase is sent at once when `now - lastIncreaseAt ≥ TIMING.INCREASE_WINDOW`; otherwise it's queued at the window's end, and the newest value replaces it.
- `followCheck(command, view, seenWaiting)` returns `{ done, reason, seenWaiting }`. It uses `START_REASON`. For Stop, charging or discharging gives `still_charging`; anything else is followed. 'wait' and a first waiting status give `done: false`.

## lib/charger/controller.js
`new ChargerController({ api, chargerId, now, timers, store, log, t, caps, requestPoll, onEvent })`
- `caps.get(id)` reads a capability value.
- `requestPoll(ms)` asks the poller to poll sooner.
- `onEvent(trigger, tokens)` fires flow triggers (for not_followed).
- `onPoll(view)` never throws. It runs phases, then the follow check, then due retries, then reconcile.
- `command({ target_power, target_power_mode, evcharger_charging })` takes a capability listener batch. Batches run one at a time, and it throws an Error with a translated message.
  - Start always resumes.
  - Start and Stop clear `targetPaused`, call `requestPoll(TIMING.FOLLOW_DELAY)` and arm the follow check.
  - In Homey mode, Start with a target below the minimum fails with `MSG.HOMEY_CONTROLS`.
  - Switching to Automatic resumes only an own, confirmed pause.
- `setCurrent(amps)` (the flow card) returns `{ result: 'sent'|'queued'|'unchanged', amps, seconds }`. In Homey mode it fails with `MSG.HOMEY_CONTROLS`.
- `setLocked(locked)`, `setEcoSmart(mode)`.
- `phases`, `measuredPhases`, and `targetOptions()`.
- On a throttled command, the card fails with `MSG.BUSY`. Stop, a lower current and a target pause are kept as retry intents and run on the first poll after `retryAt`, only while the same session is open and for at most `TIMING.RETRY_EXPIRE`.
- Persisted in the store: `phases`, `targetPaused`.

## lib/poller.js
`new Poller({ run, timers, now, log })`
- `run()` is async; runs never overlap.
- `start(intervalMs, offsetMs)`, `soon(ms)` (only if sooner; the interval restarts from that run), `setInterval(ms)`, `stop()`.

## lib/energy.js
`new EnergyMeter({ fetchSessions, store, log, now, timers, queue, firstDelay, spacing })`
- `update(snapshot)` returns `{ total, green }` or null. It uses `SESSION_STATE[snapshot.status]`.
- History loads use about 4 requests for a new charger, requests at least `spacing` apart (default `TIMING.HISTORY_SPACING`), the first load after `firstDelay` (default `TIMING.HISTORY_FIRST_DELAY`), and a load that timed out never writes.
- Exports `sumSessions` and `showGreen(green, ecoSmart)`; ecoSmart is a Snapshot value.

## Never wait on Homey
Homey may answer a call late or never, and the SDK has no time limit of its own. One such call once stopped all polling for 20 minutes. The rules:
- **Writers:** capability values, the store, availability, warnings and capability options go through a `LatestWriter` (`lib/writer.js`). It never makes the caller wait, keeps one write per key in flight, and the newest value wins. The store writer sends one write at a time over all keys, because every SDK store write sends the whole store.
- **Triggers** are fired without waiting.
- **Startup and adding a capability later** are bounded (`bounded()`), so polling always starts.
- **Polls:** each one is numbered. An answer that comes after a newer poll started is dropped, and the controller and energy meter also ignore readings older than the last (`View.at`, `Snapshot.at`).
- **The controller's write queue** stays strict (commands in order, bounded by the Wallbox timeouts). The work after a poll queues behind it as one run on the newest poll, and doesn't hold up the poll.
- **The poller** has a 90 s watchdog as a last line of defence.

## Homey adapter (app.js, drivers/wallbox)
- **Credentials** live in the device store (`username`, `password`).
- **Tokens** live in `homey.settings` under `tokens:<account key>`.
- **Setting** `polling` (s). The interval is max(setting, chargers on the account × `TIMING.POLL_PER_CHARGER`), staggered by `slot`.
- **Availability:** `auth_rejected` makes the device unavailable with `MSG.LOGIN`, and repair fixes it. Other errors keep it available and turn on `alarm_connectivity`. The alarm is also on when the status is offline. `last_sync` is no heartbeat (it only changes when the charger reports a change), so its age never sets the alarm.
- A new device starts with `target_power_mode` = `device`.

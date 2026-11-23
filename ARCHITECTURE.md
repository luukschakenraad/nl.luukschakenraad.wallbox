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
`class WallboxError extends Error`, `new WallboxError(code, { status, retryAt, sent, charger, message })`. Fields:
- `code`: an `ERR` id.
- `status`: the HTTP status or null.
- `retryAt`: ms, for `throttled`.
- `sent`: whether the request reached Wallbox.
- `charger`: `throttled` for one charger only (its status GET got a 403).

The message never contains an e-mail, password, token, serial or URL query.

`errorMessage(error, t, now)` gives the translated text for cards and pairing: `MSG.BUSY` with the minutes for `throttled`, a fixed `MSG` key per code, else `MSG.FAILED` with the status.

## lib/wallbox/account.js
`new Account({ username, password, fetch, now, timers, persist, log, userAgent })`. `fetch`, `now` and `timers` are required (no globals).
- `persist = { load() → tokens|null, save(tokens|null) }`, with `tokens = { jwt, jwtTtl, refresh, refreshTtl }`. The TTLs are epoch ms.
- `request(method, path, { body, host: 'api'|'user', charger })` returns the parsed JSON, or null for an empty body. It throws a `WallboxError`.
  - It signs in, refreshes and persists tokens by itself.
  - On a 401 it refreshes once, then retries once.
  - A sign-in 401, or the third sign-in 403 in a row, gives `auth_rejected`, and there are no sign-ins after that until `verifyCredentials`. The first two 403s are a throttle.
  - A 429, or a 403 on a GET, gives `throttled`. It sets `blockedUntil` from Retry-After, else from `TIMING.BACKOFF` (2/4/8/15 min, rising per throttle in a row; a success resets it).
  - A 403 on a GET with `charger` (the status poll) backs off only that charger, with its own level: a charger that left the account doesn't block the others.
  - A sign-in or token refresh answered with a 5xx gives `throttled` too: signing in again soon can make an account lockout last.
  - `deadline` (ms): no budget wait past it, and the fetch timeout ends there. Pairing and repair use it (`TIMING.PAIR_LIMIT`), so the pair view gets "busy, retry in N min" instead of giving up.
  - While blocked, it throws `throttled` with `sent: false` and doesn't fetch.
  - A 403 on a write gives `refused`.
  - Budget: sliding windows `TIMING.GET_BUDGET` and `TIMING.WRITE_BUDGET`. It waits up to `TIMING.BUDGET_WAIT` for room, else throws `throttled` with `sent: false`.
  - Every fetch has a `TIMING.FETCH_TIMEOUT` timeout and gives `timeout`; network errors give `network`.
- `rejected` (boolean), `blockedUntil` (ms, 0 when free).
- `verifyCredentials(username, password, { deadline })` signs in with these and only then takes them, with the new tokens. A wrong password changes nothing, so a typo during pairing or repair blocks nothing. A sign-in 403 counts like above.
- `register(chargerId)`, `unregister(chargerId)`, `chargerCount`, `slot(chargerId)` (the index in the sorted ids, used to spread polls).
- `forget()` drops the tokens, also the stored ones.

`AccountRegistry({ create(username, password) → Account })`
- `get(username, password)` returns the same Account per account. The key is sha256 of the trimmed, lower-case e-mail.
- `key(username)`.
- `release(account)` drops an account without chargers, with its tokens (device deleted, or repaired to another e-mail; not on an app restart).

## lib/wallbox/api.js
`new WallboxApi(account)`. Hosts: `api` is https://api.wall-box.com/, `user` is https://user-api.wall-box.com/.
- `listChargers({ deadline })` returns `[{ id, name }]` (v3/chargers/groups).
- `getStatus(id)` returns the raw JSON (chargers/status/{id}), with `charger: id` for the back-off. A 2xx without `status_id` and `config_data` (empty, an error object) gives `bad_response`, so it is no poll.
- `setCurrent(id, amps)` returns the amps set. It does a PUT v2/charger/{id} `{ maxChargingCurrent }` with no GET before it. The value comes from `data.chargerData.maxChargingCurrent` in the response, else the requested amps.
- `setLocked(id, locked)` (PUT v2/charger/{id} `{ locked: 0|1 }`).
- `pause(id)` and `resume(id)` (POST v3/chargers/{id}/remote-action, action 2 and 1).
- `setEcoSmart(id, mode)`, with mode an `ECO_SMART` id (PUT v4/chargers/{id}/eco-smart).
- `sessions(id, start, end)` returns the raw JSON (v4/sessions/stats; start and end in seconds).

## lib/charger/view.js
- `parseSnapshot(raw, now)` returns a `Snapshot`. `last_sync` "YYYY-MM-DD HH:MM:SS" is read as UTC. `firmware` is `config_data.software.currentVersion`, `model` is `config_data.part_number` (no serial).
- `statusOf(statusId)` returns a `STATUS` id or null (null and undefined give `offline`).
- `toView(snapshot, prev, { phases, timezone })` returns a `View`.
  - `prev` is the previous View or null.
  - An unknown id keeps `prev.status`, or `unknown` when there is none.
  - A null car keeps the previous car_connected and charging state.
  - A poll without `config_data` keeps the lock.
  - The session energy comes only from a poll with an open session (offline, updating and locked polls keep it).
  - `charged`: energy was added since the plug-in. At the plug-in, added_energy still shows the last session (also while scheduled, full or waiting), so only power, or added_energy moving away from that value, counts.
- `capabilityValues(view)` returns `{ [CAP id]: value }` for every View-driven capability: status, status_code, car_connected, evcharger_charging_state, evcharger_charging, locked, measure_power, measure_current, max_charging_current, eco_smart, last_updated, meter_power.charged. A null value means "don't set".
- `transitions(prev, next)` returns `[{ trigger, tokens, state }]`:
  - `charger_status_changed`: tokens `{ old_status, new_status }` (STATUS ids; the adapter adds titles and keeps the ids as `*_id`), state `{ old, new }`.
  - car_connected and car_disconnected, only on true↔false (never on null).
  - session_ended on car disconnect when `prev.charged` (also when it locked before the unplug), tokens `{ kwh, green_kwh }` from prev.
  - No events when prev is null.
- `matches(selection, status)` takes a STATUS, GROUP or ANY.
- `statusTriggerMatches(selection, state)` is true when the status enters the selection: it matches `state.new` and not `state.old`. ANY matches every change.

## lib/charger/decide.js (pure)
- `ampsForPower(watts, phases, maxAvailable)` = floor(W / (VOLT × phases)), clamped to MIN_AMP .. min(maxAvailable, MAX_AMP).
- `minPower(measuredPhases)` = MIN_AMP × VOLT × measuredPhases.
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
- `caps.get(id)` reads the newest capability value, `caps.set(id, value)` writes one (the device's LatestWriter).
- Homey stores a listener batch only after the listener is done, and drops all of it when it throws. So `command()` keeps the batch's target power and mode (`capability(id)` reads them first) until Homey has them, and sets them again when the Start or Stop of the batch fails.
- `requestPoll(ms)` asks the poller to poll sooner. Only after a pause or resume (follow check, confirming an own pause); the card, lock and Eco-Smart get no extra poll.
- Command times (`putAt`, `lastIncreaseAt`, the follow check, `switched`) are taken when Wallbox answered, after any budget wait, and polls are compared by when they were sent (`View.at`).
- `wroteAfter(id, at)`: our lock or Start/Stop went through after a poll sent at `at`, so that poll still shows the old value; the device doesn't write it back.
- `onEvent(trigger, tokens)` fires flow triggers (for not_followed).
- `onPoll(view)` never throws. It runs phases, then the follow check, then due retries, then reconcile.
- `command({ target_power, target_power_mode, evcharger_charging })` takes a capability listener batch. Batches run one at a time, and it throws an Error with a translated message.
  - Start always resumes.
  - Start and Stop clear `targetPaused`, call `requestPoll(TIMING.FOLLOW_DELAY)` and arm the follow check. A Start also drops a Stop retry, also when it fails.
  - In Homey mode, Start with a target below the minimum fails with `MSG.HOMEY_CONTROLS`.
  - Automatic resumes only an own, confirmed pause: at the switch, and at every poll after it (a pause confirmed after the switch, a resume that was throttled). Wallbox refusing it drops the own pause.
  - The follow check asks for its poll again when a regular poll came first, too soon after the command.
- `setCurrent(amps)` (the flow card) returns `{ result: 'sent'|'queued'|'unchanged', amps, seconds }`. A fraction is rounded down. In Homey mode it fails with `MSG.HOMEY_CONTROLS`.
- `setLocked(locked)`, `setEcoSmart(mode)`.
- `phases` (for the amps: measured or seen this session, else the last known ones), `measuredPhases`, `minimumPhases()`, `phasesFor(status, amps, kw)`.
- On a throttled command, the card fails with `MSG.BUSY`. Stop, a lower current and a target pause are kept as retry intents and run on the first poll after `retryAt`, only while the same session is open and for at most `TIMING.RETRY_EXPIRE`.
- Persisted in the store: `phases`, `targetPaused`.

## lib/poller.js
`new Poller({ run, timers, now, log })`
- `run()` is async; runs never overlap.
- `start(intervalMs, offsetMs, phaseMs)`, `soon(ms)` (only if sooner), `setInterval(ms, phaseMs)`, `stop()`.
- With a phase, regular runs stay on their grid (phase + k × interval, at least half an interval after the last run), so chargers on one account keep their spread after an early run or a throttle. Without one, the interval restarts from every run.

## lib/energy.js
`new EnergyMeter({ fetchSessions, store, log, now, timers, queue, firstDelay, spacing })`
- `update(snapshot)` returns `{ total, green }` or null. It uses `SESSION_STATE[snapshot.status]`. `now` is required.
- The first update compares the shown session with the last finished one to the Wh (two endpoints), not exactly.
- A history load whose total is lower than the stored one is logged; the meter holds until the history catches up.
- A history load is one request for all years (per year only when Wallbox says the answer is incomplete), requests at least `spacing` apart (default `TIMING.HISTORY_SPACING`). After a restart the first load waits `firstDelay` (default `TIMING.HISTORY_FIRST_DELAY`); a new device loads at once. A request refused by our own budget waits for room. A load that timed out never writes.
- Exports `sumSessions` and `showGreen(green, ecoSmart)`; ecoSmart is a Snapshot value.

## Never wait on Homey
Homey may answer a call late or never, and the SDK has no time limit of its own. One such call once stopped all polling for 20 minutes. The rules:
- **Capability values** go through a `LatestWriter` (`lib/writer.js`). The SDK queues setCapabilityValue per capability and changes the local value only after Homey answered, so one stuck call would hold up every newer value. The writer never makes the caller wait, keeps one write per capability in flight, and the newest value wins.
- **Store, availability and warning** are plain calls that nobody waits for; a failure, or no answer within 30 s, is logged. The SDK changes the local store at once and queues availability in order. Availability and warning are sent only on a change. Warnings go one at a time: the SDK skips a warning equal to the last one Homey answered (no queue), so a clear sent while a set was unanswered would be lost.
- **Conditions** read the newest value (`device.latest`, the writer's), not Homey's answered one: a flow behind one of our triggers can run before Homey answered the capability write.
- **Last seen** is refreshed after every good poll (`setLastSeenAt`), since unchanged values aren't written.
- **Triggers** are fired without waiting.
- **Startup and adding a capability later** are bounded (`bounded()`, 30 s, logged), so polling always starts.
- **Polls:** each one is numbered. An answer that comes after a newer poll started is dropped, so the controller and the energy meter only see polls in order.
- **The controller's write queue** stays strict (commands in order, bounded by the Wallbox timeouts). The work after a poll queues behind it as one run on the newest poll, and doesn't hold up the poll.
- **The poller** has a 90 s watchdog as a last line of defence.

## Homey adapter (app.js, drivers/wallbox)
- **Credentials** live in the device store (`username`, `password`).
- **Tokens** live in `homey.settings` under `tokens:<account key>`, removed with the account's last device (`registry.release`).
- **Setting** `polling` (s). The interval is max(setting, chargers on the account × `TIMING.POLL_PER_CHARGER`), spread by `slot` (the poller's phase). A change of chargers on the account (add, delete, repair to another e-mail) re-applies both on every device of the account. After a throttle the chargers poll again one after another (slot × `TIMING.POLL_PER_CHARGER`).
- **Pairing** with a changed password gives it to the devices already on that account too, like repair. Pairing and repair answer within `TIMING.PAIR_LIMIT` (25 s).
- **Settings** `firmware` and `model` (labels) come from the status poll, sent only when they change, never awaited.
- **An unknown status id** keeps the previous status and is logged once per app run, so it can be added (rule 6).
- **Capability options** of an earlier build are set to the manifest ones at init, once, when they differ.
- **Stale values:** after 10 minutes without a good poll (counted from the start, also while the login is rejected) power and current go to 0.
- **Availability:** `auth_rejected` makes the device unavailable with `MSG.LOGIN`, and repair fixes it. Other errors keep it available and turn on `alarm_connectivity`. The alarm is also on when the status is offline. `last_sync` is no heartbeat (it only changes when the charger reports a change), so its age never sets the alarm.
- A new device starts with `target_power_mode` = `device`.
- **target_power** has a fixed range in the manifest: 0 to 22080 W, step 230, nothing between 0 and 1380 W. The amps round down (`ampsForPower`), so any value works on 1 or 3 phases.
- **Trigger ids** never equal `<capability>_changed`, `<capability>_true` or `<capability>_false`: Homey fires those itself on every value change, with other tokens.

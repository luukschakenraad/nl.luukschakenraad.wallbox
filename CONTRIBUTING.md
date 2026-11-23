# Contributing

Issues and pull requests are welcome.

- **Bugs:** say what you did, what you expected and what happened, with the time, the app version and the charger model. Leave out e-mail addresses, serial numbers and tokens.
- **Code:** read [ARCHITECTURE.md](ARCHITECTURE.md) and the rules in [AGENTS.md](AGENTS.md) first. Every behaviour change needs a test.
- **Checks:** `node --test test/` and `npx homey app validate --level publish`. Commit the regenerated `app.json` too.
- **Pull requests:** one change each, with short commits in the form `type(scope): summary`.

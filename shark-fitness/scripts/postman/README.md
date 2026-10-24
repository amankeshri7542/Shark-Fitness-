# Postman suite: every API route, as every role

This suite calls every route the API serves, signed in as each demo account: owner, manager, reception, trainer, accountant, two members, the platform admin and a second gym. It checks three things:

- every role gets the answer it should;
- nothing returns a server error;
- the main desk and member journeys work end to end.

It runs against any server that holds the **demo seed** (`SHARK_SEED_DEMO=true`), whether local or hosted.

## Run it against a hosted URL

From `shark-fitness/`, with Node 22, `pnpm install` done and the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-installation/) installed:

```bash
node scripts/postman/run.mjs --base-url https://your-app.onrender.com
```

Use the site's origin only, with no path and no trailing slash. It must be the same origin the server allows writes from (`SHARK_PUBLIC_ORIGIN` or `SHARK_ALLOWED_ORIGINS`). If it isn't, every write is refused with a 403.

The run takes a few minutes and ends with a summary:

- how many requests were answered;
- the status counts;
- every server error (5xx);
- every failed check.

It exits 1 if anything failed. The full Postman output is in `scripts/postman/out/run.log`.

Many 403, 404 and 422 answers are expected. For example, a member asking for the console must get a 403. Each request lists the statuses it accepts, and anything else counts as a failure.

### Full run or read-only

By default the run **writes**. It does the following:

- converts a walk-in lead into a member;
- sells them Depot Monthly, takes a cash payment and refunds ₹100;
- checks them in, books classes and sells a shop item;
- opens and resolves a ticket;
- logs a workout, a habit and a coach message;
- sends every write route an empty body. Almost all of those are refused. A route that acts on a record without needing a body, such as retiring a plan or cancelling a booking, is sent an ID that doesn't exist. That way a run can't damage the demo it is checking.

A second run on the same demo still passes. Each run does add a new member, a ticket, a sale and so on. To start clean, redeploy to get a fresh seed. The Render demo keeps its database in `/tmp`, which a new deploy empties.

To leave the data as it is, add `--read-only`. That checks the sessions, security and every GET route, and skips the journeys and the write sweep:

```bash
node scripts/postman/run.mjs --base-url https://your-app.onrender.com --read-only
```

**Never point it at a gym with real members.** It signs in with the demo accounts, and a full run takes payments.

## Run it locally

Start a server on a freshly seeded database of its own, so your usual dev data is left alone. Serving the built apps from it means the app-shell checks run too:

```bash
pnpm build && SHARK_DB=/tmp/shark-postman.db pnpm db:migrate && SHARK_DB=/tmp/shark-postman.db pnpm db:seed
```

```bash
SHARK_DB=/tmp/shark-postman.db SHARK_SERVE_STATIC=true PORT=8790 SHARK_ALLOWED_ORIGINS=http://localhost:8790 pnpm -F @shark/api start
```

```bash
node scripts/postman/run.mjs --base-url http://localhost:8790
```

The server runs on port 8790, so it can't collide with anything already on the API's default port, 8787. The allowed origin has to match that port, or writes are refused.

## How it works

`generate.mjs` builds the suite in five steps:

1. It reads the route list from the API's source, so a new route is covered the next time it runs.
2. It signs each demo account in once.
3. It looks up the IDs it needs through the API itself: a member's invoice, a class with free seats, a ticket, and so on.
4. It writes `out/collection.json` and `out/env.json`.
5. Where the server has no row for a lookup, the routes that need it expect a 404, and the generator says so.

`run.mjs` generates and then runs the collection. To open it in the Postman app instead, run the generator on its own and import both files:

```bash
node scripts/postman/generate.mjs --base-url https://your-app.onrender.com
```

Things to know:

- **`out/env.json` holds live session tokens** for the demo accounts. git ignores the `out/` folder; don't share it.
- **Sign-in allows ten attempts a minute from one address.** A run signs in nine accounts, so a second run started within a minute waits before it begins.
- **The demo password** defaults to the seed's. If it was changed, pass `--password` or set `SHARK_DEMO_PASSWORD`.
- **Check-ins depend on the branch's hours.** Outside Koramangala's opening hours the desk refuses entry, as it should. The run accepts that refusal and skips the check-out, so it passes at any hour.

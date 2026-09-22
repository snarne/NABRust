# NABRust server

Collectors, ingest, inference and API. **Zero runtime dependencies** — Node 22's
built-in `node:sqlite` and `node:http`, and TypeScript run directly via
`--experimental-strip-types`. Nothing to `npm install`.

```bash
cd server
npm test                                   # 158 tests, no framework

export NABRUST_DB=./nabrust.db
export NABRUST_TOKEN=pick-something
export NABRUST_TEAM=7656119...,7656119...  # your own team's steam ids

npm run cli -- init --id example-trio --name "EXAMPLE · TRIO" \
  --seed 123456789 --world 4250 --battlemetrics 1234567
npm run serve                              # API on :8787 + collectors
```

## Order of operations

Turn the **Battlemetrics collector on first**, before anything else is
finished. It is the one source whose history cannot be backfilled — if it
wasn't running, that week of sessions is simply gone, and clan detection is
worthless on a day of data and sharp after a few weeks.

## What runs where

| | where | cost |
| --- | --- | --- |
| log agent | each gaming PC | file tail + POST. No GPU, no memory reads |
| everything else | your box | sqlite, inference, API, collectors |

## Commands

```
setup     init --id --name [--seed --world --battlemetrics]
          find <server name>              find a battlemetrics id
          pair --id --host --player --token    store Rust+ credentials

running   serve                           api + collectors + rust+
          collect --id                    one-shot battlemetrics poll
          rustplus --id                   one-shot rust+ connectivity check
          server-info --id                read seed/size from battlemetrics

map       map --id [--world]              fetch the map image / world file
          parse-map --id [--file]         render + monuments + terrain

data      ingest --id --reporter [--file] combat log (else stdin)
          evidence --id                   rebuild teammate evidence + rosters
          clans --id                      rebuild rosters
          validate                        score the teammate model on simulations
          simulate [--db --hours --map-from]  fake server in a separate db
          wipe --id [--seed --world] [--force]
          stats                           retention + coverage
```

## Schema shape

Two rules drive `db/schema.sql`:

**Identity.** Every row referring to a person keys on the 64-bit Steam ID.
Names live in `player_names` as time-ranged records, so a rename *appends* —
encounter history, rivalries and roster membership all survive it. Rename
frequency then becomes a signal in its own right rather than a data problem.

**Scope.** Rows are scoped to `(server_id, wipe_id)` unless they're permanent.
Retention moves data between three tiers on wipe rollover:

| tier | holds | on wipe |
| --- | --- | --- |
| hot | raw combat events, sessions, position samples, bases | collapsed |
| warm | encounter summaries, daily session totals | kept |
| cold | identity, name history, rivalries, skill, roster memory | never cleared |

`rolloverWipe()` is idempotent and logged, because a bug there destroys data
that cannot be recovered. Position samples are the table that would otherwise
dominate disk — once a retrace is computed we keep the conclusion and purge the
inputs.

Roster memory carries across wipes with a decay factor (halves roughly every
three wipes), so a team that stays together starts the next wipe already linked,
while genuine reshuffles wash out.

## Team inference in practice

Rosters come from Battlemetrics sessions: teammates join and leave within a
couple of minutes of each other far more often than chance. `ingest.ts`
(`buildSessionEvidence`) turns the current wipe's sessions into per-pair
log-likelihood ratios, discounting server restarts and collector gaps, and
`pairs.ts` adds a population-aware prior and clusters with the server's team
limit as the cap. Combat-log signals (co-onset, range correlation, HP
accounting) add to the same per-pair log-odds when the agent is running.

```
$ ./nab evidence --id myserver
watched 1.4 h · 327 players · team limit 3
prior: 1 in 272 pairs are teammates before any evidence
368 pairs moved together at least once · 0 at ≥60% · 0 rosters
under two days of data — expect few rosters yet; they sharpen every session
```

That's the honest answer after an hour and a half. `./nab validate` shows what
a week buys on simulated servers of the same size.

Manual rosters you assert are stored with `source = 'manual'` and are never
silently overwritten by inference — a disagreement is reported as a conflict
instead.

## API

```
GET    /health                        no auth
GET    /api/servers                   server records for the picker
GET    /api/dataset/:serverId         the payload the web app renders
GET    /api/status/:serverId          collector / Rust+ / map / agent health
GET    /api/terrain/:serverId?res=N   heightmap + buildable mask for the retracer
GET    /api/map/:serverId?token=      rendered map image
POST   /api/bases                     mark a base
PATCH  /api/bases/:id?serverId=       edit one
DELETE /api/bases/:id?serverId=
POST   /api/clans/rebuild             { serverId }
POST   /ingest/combatlog              { serverId, reporterId, text }
POST   /ingest/positions              { serverId, samples[] }
```

Bearer token auth. Meant to sit behind a Cloudflare Tunnel on a box you
control, not on the open internet.

## The agent

```bash
node --experimental-strip-types agent/agent.ts \
  --log "C:\rust-logs\client.log" --server example-trio \
  --me 7656119... --url http://nab-box:8787 --token pick-something
```

Requires `-logfile "C:\rust-logs\client.log"` in Rust's Steam launch options.
It filters to combat-log rows only (so unrelated log noise never leaves the
machine), batches, handles log rotation on game restart, and requeues on a
failed POST rather than dropping data.

Bind `combatlog` onto a key you already press after fights:
`bind f2 consoletoggle;clear;combatlog`. That's an ordinary keybind. Do **not**
use macro software to press it — synthetic input injection is precisely what
anti-cheat scripting detection looks for, and it isn't worth the risk for data a
keybind already gives you.


## Battlemetrics

Session history is the one thing that cannot be backfilled, so this runs first
and continuously.

```bash
export BATTLEMETRICS_TOKEN=...
npm run cli -- find "my server"          # → battlemetrics id
npm run cli -- init --id example-trio --battlemetrics 123456
npm run cli -- server-info --id example-trio
npm run cli -- collect --id example-trio    # one-shot; `serve` loops it
```

A token bucket keeps requests under the published limits (45/s and 300/min
authenticated) and 429s are retried with backoff honouring `Retry-After`.

Two honesty notes baked into the code:

- **Rust detail keys drift.** Seed and world size live under
  `attributes.details`, and the key spelling has changed upstream before. The
  extractor tries the known variants and `server-info` prints every key it
  actually saw, so a rename shows up as a visible `not exposed` rather than a
  silently wrong seed.
- **Not every player exposes a Steam ID.** Where only Battlemetrics' internal
  id is available the player is keyed as `bm:<id>` rather than guessed at.
  `reconcileBmIdentity()` folds that placeholder into the real identity when
  the combat log later reveals it, carrying the session history across.

## Rust+

Facepunch's own companion API. Nothing here touches the game client — it is the
same websocket the official phone app uses.

```bash
npm run cli -- pair --id example-trio --host 1.2.3.4 --player 7656119... --token -- -1717986918
npm run cli -- rustplus --id example-trio    # connectivity check
npm run serve                                  # runs it continuously
```

**Pairing credentials.** `playerId` is your 64-bit Steam ID; `playerToken` is
issued when you pair from the in-game menu and arrives as a Google FCM push
notification. Capturing it needs an FCM listener, so pair once with an existing
helper (`rustplus.js fcm-listen`, or the Rust+ desktop app) and paste the four
values in. NABRust does not re-implement the Google sign-in dance.

The token is an **int32 and is frequently negative** — pass it after `--` as
shown, and note the protobuf encoder sign-extends it to a full 10-byte varint.
Getting that wrong is the classic reason a hand-rolled client is rejected.

### What it gives us

| call | cadence | what it unlocks |
| --- | --- | --- |
| `getInfo` | 5 min | seed + wipe time → **wipe detection**, population |
| `getMap` | once per wipe | the server's real map JPEG → placeholder mode off |
| `getTeamInfo` | 15 s | our own positions (the retracer needs them), death detection, map notes |
| `getTime` | 60 s | in-game clock, one nightfall warning per night |
| team chat | push | the `/nab` command surface, both directions |

The protobuf codec is hand-written (`rustplus/protobuf.ts`) — wire format only,
no dependency. Unknown fields are skipped rather than throwing, so a game update
that adds fields does not break the client.

**Coordinates.** Rust+ reports positions in metres from the map's *bottom-left*
corner, not the centred system the game's own transforms use. `rustPlusToNorm()`
converts, so every overlay shares one normalised space no matter which source
produced it.

### In-game commands

Rust+ can write to team chat, so the team queries NABRust without alt-tabbing:

```
/nab who <name>     hours, rename history, who they run with + confidence
/nab clan <name>    roster
/nab threat         top groups on the server
/nab time           day/night with a countdown
/nab base <label>   mark a base at your current position
/nab stats          coverage
```

The zero-typing path is better still: **in-game map notes become base records
automatically**. Your team already drops markers while playing, and Rust+
exposes them.

### What Rust+ does NOT give us

Positions of players outside your own team. The API does not expose them and
NABRust does not try to infer them live — enemy positions are only ever
reconstructed after the fact, from combat-log ranges.

## Known limits

The combat log records damage events only — misses aren't in it, so true
accuracy is not computable from this source. What you get is hit quality:
headshot rate, body-part distribution, engagement distance, time-to-kill.

Battlemetrics exposes steam ids for most players but not all; when only its
internal id is available the collector keeps `bm:<id>` as the key rather than
guessing, and reconciles later from the combat log.

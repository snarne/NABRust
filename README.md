# NABRust

Team intel for Rust. Who is grouped with whom, when they play, where the shot
that killed you came from, and what a raid will cost — built from public data,
the server's own world file, Facepunch's Rust+ companion API, and your own
combat logs.

Self-hosted, no dependencies on the backend, and it never touches the game.

```bash
cp server/.env.example server/.env    # Battlemetrics token + a token of your own
npm test                              # 169 tests, nothing to install
./nab init --id myserver --name "MY SERVER" --battlemetrics <id>
./nab serve                           # collectors + API — keep it running
npm install && npm run dev            # http://localhost:5173
```

Full walkthrough in [SETUP.md](SETUP.md). No server yet? `./nab simulate`
builds a simulated one so every screen has something to show.

## What it does

**Rosters from session history.** Teammates join and leave together. NABRust
polls the public player list once a minute and turns join/leave co-movement
into per-pair log-odds, then clusters them into rosters. No combat needed — it
learns who runs with whom before you ever meet them.

**Dossiers.** Per player: every name they've used, when they play (a 28-day
activity grid), who they're grouped with, your record against them, which
weapons they've hit you with, and a threat score whose inputs are all listed.
Optionally profile age and VAC/game bans from the Steam Web API.

**Death Retracer.** Each hit in your combat log carries a range; Rust+ gives
where you stood. Each hit is a ring on the map, and the rings intersect at the
shooter. The solver scores every cell of the real heightmap, penalises cells
with no line of sight, and reports a position with ±σ.

**Timeline.** One fight reconstructed hit by hit, with parties separated — who
opened, who third-partied, where unexplained damage came from.

**Raid Planner.** Record the walls and doors between the outside and the loot;
get the cheapest way in, priced in sulfur, plus no-satchel and single-explosive
plans and a check against what's in your inventory. Also shows when the owners
are usually online.

**Base Library.** Mark bases on the map, with tier, turrets and raid path.
In-game map notes become weak sightings when Rust+ is paired.

**Base devices.** Smart switches, smart alarms and storage monitors you've
paired in game. Flip a switch from the dashboard; an alarm going off lands in
the live-events feed and in team chat; a storage monitor on a tool cupboard
turns upkeep into "31 h left" instead of a thing you forget until the base
decays.

**Command map.** The server's real map, rendered from its world file with
monuments named: your team, your deaths, marked bases, live events (cargo,
heli, crates), and in-game time.

**Live events and server tracking.** Population curves, wipe day, rosters
online right now, collector health.

Every screen says what it doesn't know. Screens with no data show what's
missing rather than inventing numbers.

## Architecture

```
                    ┌──────────────────────────────────────────┐
  public data       │  your machine                            │
  ───────────       │                                          │
  Battlemetrics ───►│  collectors ──┐                          │
  Steam Web API ───►│               │                          │
  world file    ───►│  parsers ─────┼──► SQLite ──► inference  │
                    │               │      │         rosters   │
  Facepunch         │               │      │         threat    │
  ─────────         │               │      │         localize  │
  Rust+ socket  ───►│  runtime ─────┘      │         raid cost │
                    │                      ▼                   │
  your PC           │                   HTTP API ──► web app   │
  ───────           │                      ▲                   │
  client.log    ───►│  log agent ──────────┘                   │
                    └──────────────────────────────────────────┘
```

```
shared/     types, inference, map maths, raid table — imported by both halves
  inference/  sessionEvidence, clanEvidence, localize
src/        web app (Vite + React, no UI framework)
server/
  collectors/ battlemetrics, steam
  parsers/    worldfile, terrain, monuments, mapRender, png, combatlog
  rustplus/   protobuf, client, sync, events, entities, items, commands, runtime
  api/        server, dataset, mapInfo, status, bases
  validation/ simulator + scoring harness
agent/      the log tailer that runs on a gaming PC
nab         CLI wrapper (loads server/.env)
```

Notes on the shape of it:

- **Backend has zero runtime dependencies.** Node 22's `node:sqlite` and
  `node:http`, TypeScript run directly with `--experimental-strip-types`.
  The Rust+ protobuf codec and the PNG encoder are written out rather than
  pulled in.
- **Everything keys on the 64-bit Steam id.** Display names are time-ranged
  records, so a rename appends to history instead of orphaning it — and rename
  frequency becomes a signal of its own.
- **Rows are scoped to (server, wipe)** unless they're permanent. A wipe
  collapses hot data (raw combat events, sessions, position samples), keeps
  warm summaries, and never clears identity, fight history or roster memory.
- **Map coordinates are normalised 0..1 everywhere.** Overlays sit correctly on
  the parsed render, on a Rust+ map image and on the seed-derived placeholder.

## How the inference works

**Rosters** — `shared/inference/sessionEvidence.ts`, `clanEvidence.ts`.
For every pair, count how often one joined within ±150 s of the other and
compare it with how often that would happen by chance at that time of day, as
a binomial log-likelihood ratio. Server restarts and collector gaps are
filtered out so mass reconnects don't look like teams; sessions cut off by a
gap are marked censored and don't count as evidence either way. The prior
depends on population and group limit — on a 300-player trio server, a given
pair starts at about 1 in 270 — and clustering is average-linkage with the
group limit as a hard cap.

Scored against simulated servers with known ground truth (`./nab validate`):
over a week, 95% of reported pairs and 98% of roster memberships were real.
Over a single day it reports almost nothing, which is the honest answer.

**Shooter localization** — `shared/inference/localize.ts`.
Logged distances are 3D, so elevation from the heightmap turns the unknown Z
into a constraint rather than an error source. Line of sight is a soft penalty,
not a veto — a blocked cell is unlikely, not impossible. Per-hit position error
adds in quadrature to σ. On 27 simulated deaths on a real map: median error
21 m, true shooter inside 2σ every time.

**Devices** — `server/src/rustplus/entities.ts`. An alarm reports "triggered"
on every poll while it's on, so a raid alert fires on the transition only.
Storage monitors report contents as numeric item ids, resolved through a
lookup table (`items.ts`); an id that isn't in the table renders as
`item #<id>` rather than a guess.

**Raid costs** — `shared/raid.ts`. Explosives per wall and door tier from a
current raid table (sources in the file), priced in sulfur.

**Monument names** — `server/src/parsers/monumentNames.ts`. A world file names
monuments only by a StringPool id, which is the first four bytes of the MD5 of
the prefab path. A table of known paths resolves most of them offline; the
rest fall back to a measured footprint ("large monument, 400 m across") rather
than a guessed name.

## Scope

This is an intel tool, not a cheat. It reads:

- public server data (Battlemetrics, Steam Web API)
- the server's own world file — the same one the game downloads
- Facepunch's Rust+ companion API, for your own team, after you pair
- your own combat log, from the file Rust writes when launched with `-logfile`

It does not read game memory, hook the client, capture network traffic, draw
overlays, or send synthetic input. Live positions of players you can't see,
live ore nodes, and anything else requiring client access are out of scope by
design. The Death Retracer is after-action only: it reconstructs where shots
that already hit you came from.

## Checks

```bash
npm test             # server + shared: parsers, inference, API, simulation
npm run typecheck    # web app
```

CI runs both plus the production build on every push
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

The simulator deserves a mention: `server/src/validation/` builds a synthetic
server and pushes it through the real collectors, the real Rust+ handlers and
the real combat-log parser — not mock rows — so the inference can be scored
against ground truth it never sees.

## Not built yet

- Discord / TeamSpeak alerts
- Native Rust+ pairing (today it borrows an FCM listener; see SETUP step 7)
- Security camera feeds — deliberately out of scope: watching your own CCTV is
  what the phone app is for, and it feeds no inference
- Ore density and no-build overlays from the world file
- Base interior prediction (needs a corpus of real layouts)
- Names for monument prefabs not in the lookup table

## Running it safely

- `server/.env` and every `*.db` are gitignored. The database holds real
  players' names and Steam ids; keep it out of version control.
- Change `NABRUST_TOKEN` from the default before the API is reachable from
  anything but your own machine, and put it behind a tunnel rather than on the
  open internet.

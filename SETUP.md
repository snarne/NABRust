# Setting up NABRust

NABRust runs on a machine you control — a laptop, a home server, a VPS. It
keeps a SQLite database, polls public data, and serves a web app on your LAN.
The only thing that goes on a gaming PC is the log agent in step 7, and that
only reads a file Rust itself writes.

Commands below assume you're in the project directory.

## 0. Requirements

```bash
node -v      # v22.6 or newer — needs node:sqlite and TypeScript type-stripping
```

The backend has **no dependencies**. Only the web app needs `npm install`.

## 1. Configure

```bash
cp server/.env.example server/.env
```

Fill in at least:

- `BATTLEMETRICS_TOKEN` — a personal access token from
  battlemetrics.com → Account → Developers. Read-only scopes are enough.
- `NABRUST_TOKEN` — any random string. It's the bearer token for NABRust's own
  API. Change it from the default before the API is reachable by anything but
  your own machine.
- `NABRUST_TEAM` — your own team's 64-bit Steam ids, comma-separated. Stops
  NABRust building teammate evidence about your own group and marks you as
  "us" across the app.

## 2. Verify the build

```bash
npm test
```

Expect `169 passed, 0 failed`, in a few seconds, with nothing installed.

If you have a Rust world file handy, point the parser tests at it for six more
checks against real data:

```bash
NABRUST_TEST_MAP=./data/maps/<file>.map npm test
```

## 3. Start collecting — do this first

Session history is the one thing that can't be backfilled. Teammate detection
compares who joins and leaves together, so it needs days of continuous
collection. Start before anything else is finished.

```bash
./nab find "server name"                     # → battlemetrics id
./nab init --id myserver --name "MY SERVER" --battlemetrics <id>
./nab server-info --id myserver              # reads the live seed and size
./nab serve                                  # leave this running
```

`./nab` loads `server/.env` for you. Variables already set in your shell win,
so `NABRUST_DB=./sim.db ./nab serve` opens a different database.

Group limit comes from the server name (solo/duo/trio/quad) and defaults to 8.
Override it with `--team-limit N` on `init`.

To keep the collector alive after you close the terminal:

```bash
nohup ./nab serve > serve.log 2>&1 &
tail -f serve.log
```

Check what it has learned at any point:

```bash
./nab evidence --id myserver
```

It prints hours actually watched, the prior, how many pairs moved together,
how many crossed 60%, and how many rosters it built.

## 4. Load the real map

The server's own world file gives a full-resolution map, monument footprints
and the terrain the death retracer solves against. No Rust+ needed.

```bash
./nab map --id myserver --world     # downloads the .map (tens of MB)
./nab parse-map --id myserver       # render + monuments + terrain, a few seconds
```

Re-run both after every wipe — a new seed is a new world.

## 5. Open the app

```bash
npm install
npm run dev
```

http://localhost:5173. The dev server proxies `/api` to `./nab serve` and
attaches the token from `server/.env` for requests coming from this machine,
so there's nothing to configure locally. The top bar shows **DEMO DATA** in
amber if it can't reach the API; Settings → Connection says why.

Another machine needs the API address and `NABRUST_TOKEN`, entered in
Settings → Connection. The token is only attached automatically for local
requests, never for other devices.

## 6. Try it without playing

A simulated server exercises every screen — rosters with known truth, deaths
to retrace, bases to plan against — in its own database:

```bash
./nab simulate --hours 168 --map-from myserver   # writes ./sim.db
NABRUST_DB=./sim.db ./nab serve
```

It's labelled SIMULATED everywhere and never touches your real database.
`./nab validate` scores the teammate model against simulated servers of
different sizes and lengths.

## 7. Rust+ pairing — live team positions and events

Gives NABRust your team's positions, deaths, in-game time and map events
(cargo, heli, crates) over Facepunch's companion socket. The Death Retracer
needs it: your position at the moment of a hit is half of every solve.

```bash
npx @liamcottle/rustplus.js fcm-register    # browser opens, sign in with Steam
npx @liamcottle/rustplus.js fcm-listen      # leave running
```

In game: ESC → Rust+ → Pair With Server. The listener prints the server ip,
port, your playerId and a playerToken. Then:

```bash
./nab pair --id myserver --host <ip> --port <port> --player <steamid> --token -- -1717986918
./nab rustplus --id myserver        # connectivity check
```

The token is an int32 and is often negative, so pass it after a bare `--`.
Pairing here doesn't break the Rust+ phone app; both can be paired.

## 7b. Paired devices (optional)

Smart switches, smart alarms and storage monitors you build and pair in game.
Pairing one sends a push notification carrying its entity id — the same
listener as step 7 prints it. Then:

```bash
./nab device --id myserver --add 1234567 --kind alarm --name "front door"
./nab device --id myserver --add 7654321 --kind storage --name "tool cupboard"
./nab device --id myserver            # list them and their last known state
```

Kinds are `switch`, `alarm` and `storage`. A switch can be flipped from the
Command page; an alarm going off becomes a live event and a team-chat message;
a storage monitor on a tool cupboard shows remaining upkeep.

Devices are scoped to the wipe, since entity ids die with the base they're in.

## 8. The log agent — combat logs

Rust writes its console output to a file when launched with `-logfile`, and
`combatlog` prints the last 30 seconds of damage. The agent tails that file
and posts new lines to the API. File reads and a socket: no GPU cost, no
memory access, no injection.

On the gaming PC:

- Steam → Rust → Properties → Launch Options:
  `-logfile "C:\rust-logs\client.log"`
- In game: `bind f2 consoletoggle;clear;combatlog`, then press F2 after fights.
  Bind it to a key you already press — don't script it. Synthetic input is
  what scripting detection looks for.
- Copy the project over, install Node 22, then:

```
node --experimental-strip-types agent\agent.ts ^
  --log "C:\rust-logs\client.log" --server myserver ^
  --me <your-steamid> --url http://<host-ip>:8787 --token <NABRUST_TOKEN>
```

The host machine may need to allow incoming connections on port 8787.

To check the parser against your game build before relying on it, paste a
combat log into a file and run:

```bash
./nab ingest --id myserver --reporter <your-steamid> --file ./cl.txt
```

It reports how many lines it rejected. Anything above zero means the column
layout differs from what the parser expects.

## Wipes

```bash
./nab wipe --id myserver [--seed N --world N]
```

Map state, bases, events and threat state reset. Identity, name history, fight
records and roster memory carry over, with rosters decaying over a few wipes,
so a team that stays together starts the next wipe already linked.

## Housekeeping

- `server/.env` and every `*.db` are gitignored. The database holds real
  players' names and Steam ids — don't commit it.
- `./nab stats` prints retention and coverage.
- Point `NABRUST_DB` and `NABRUST_DATA` elsewhere if you want the database and
  downloaded maps outside the project directory.

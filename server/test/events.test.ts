// ---------------------------------------------------------------------------
// Rust+ map markers -> server events, and the team state the UI reads.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, nowIso } from '../src/db/index.ts'
import { Writer } from '../src/rustplus/protobuf.ts'
import { decodeMessage, MARKER_TYPE, type AppMarker } from '../src/rustplus/messages.ts'
import { trackMarkers, CRATE_UNLOCK_SECONDS } from '../src/rustplus/events.ts'
import { syncTeam } from '../src/rustplus/sync.ts'
import { currentWipe } from '../src/retention.ts'

type TestFn = (name: string, fn: () => void | Promise<void>) => void

const WORLD = 4000

function freshDb() {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO servers (id, name, world_size, created_at) VALUES ('srv', 'T', ?, ?)`)
    .run(WORLD, nowIso())
  db.prepare(`INSERT INTO wipes (server_id, started_at, world_size) VALUES ('srv', ?, ?)`)
    .run('2026-09-17T19:00:00Z', WORLD)
  return { db, wipeId: currentWipe(db, 'srv')!.id }
}

function marker(id: number, type: number, x: number, y: number): AppMarker {
  return { id, type, x, y, steamId: '0', rotation: 0, radius: 0, name: '', outOfStock: false }
}

const T0 = Date.parse('2026-09-21T20:00:00Z')
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString()

export function run(test: TestFn) {
  console.log('\nmap markers')

  test('map markers decode from response field 13', () => {
    const buf = new Writer().message(1, (resp) => {
      resp.uint32Always(1, 7)
      resp.message(13, (mm) => {
        mm.message(1, (m) => {
          m.uint32Always(1, 99); m.uint32Always(2, MARKER_TYPE.CargoShip)
          m.float(3, 1200.5); m.float(4, 300.25); m.string(11, 'cargo')
        })
        mm.message(1, (m) => {
          m.uint32Always(1, 100); m.uint32Always(2, MARKER_TYPE.Crate)
          m.float(3, 10); m.float(4, 20)
        })
      })
    }).finish()
    const r = decodeMessage(buf).response!
    assert.equal(r.seq, 7)
    assert.equal(r.mapMarkers!.length, 2)
    assert.equal(r.mapMarkers![0].id, 99)
    assert.equal(r.mapMarkers![0].type, MARKER_TYPE.CargoShip)
    assert.equal(r.mapMarkers![0].x, 1200.5)
    assert.equal(r.mapMarkers![0].name, 'cargo')
  })

  test('a new cargo marker starts an event once, and its departure ends it', () => {
    const { db, wipeId } = freshDb()
    let d = trackMarkers(db, { wipeId, worldSize: WORLD, markers: [marker(1, MARKER_TYPE.CargoShip, 100, 100)], at: at(0) })
    assert.equal(d.started.length, 1)
    assert.equal(d.started[0].kind, 'cargo')
    assert.match(d.started[0].label, /Cargo Ship on the map/)

    d = trackMarkers(db, { wipeId, worldSize: WORLD, markers: [marker(1, MARKER_TYPE.CargoShip, 150, 120)], at: at(15) })
    assert.equal(d.started.length + d.ended.length, 0, 'same marker, same event')

    d = trackMarkers(db, { wipeId, worldSize: WORLD, markers: [], at: at(30) })
    assert.equal(d.ended.length, 1)
    assert.equal(d.ended[0].label, 'Cargo Ship left the map')
    const row = db.prepare(`SELECT ended_at, x FROM game_events`).get() as { ended_at: string; x: number }
    assert.equal(row.ended_at, at(30))
    assert.ok(Math.abs(row.x - 150 / WORLD) < 1e-9, 'position followed the ship while it was on the map')
  })

  test('a heli that vanishes beside a fresh explosion was shot down', () => {
    const { db, wipeId } = freshDb()
    trackMarkers(db, { wipeId, worldSize: WORLD, markers: [marker(5, MARKER_TYPE.PatrolHelicopter, 2000, 2000)], at: at(0) })
    trackMarkers(db, {
      wipeId, worldSize: WORLD,
      markers: [marker(5, MARKER_TYPE.PatrolHelicopter, 2000, 2000), marker(6, MARKER_TYPE.Explosion, 2100, 2050)],
      at: at(15),
    })
    const d = trackMarkers(db, { wipeId, worldSize: WORLD, markers: [marker(6, MARKER_TYPE.Explosion, 2100, 2050)], at: at(30) })
    assert.equal(d.ended.length, 1)
    assert.match(d.ended[0].label, /^Patrol Heli downed/)
  })

  test('a heli that vanishes with no explosion near it just left', () => {
    const { db, wipeId } = freshDb()
    trackMarkers(db, { wipeId, worldSize: WORLD, markers: [marker(5, MARKER_TYPE.PatrolHelicopter, 2000, 2000)], at: at(0) })
    // an explosion far across the map doesn't count
    trackMarkers(db, {
      wipeId, worldSize: WORLD,
      markers: [marker(5, MARKER_TYPE.PatrolHelicopter, 2000, 2000), marker(6, MARKER_TYPE.Explosion, 200, 200)],
      at: at(10),
    })
    const d = trackMarkers(db, { wipeId, worldSize: WORLD, markers: [], at: at(20) })
    const heli = d.ended.find((e) => e.kind === 'heli')!
    assert.equal(heli.label, 'Patrol Heli left the map')
  })

  test('an old explosion does not explain a heli vanishing later', () => {
    const { db, wipeId } = freshDb()
    trackMarkers(db, {
      wipeId, worldSize: WORLD,
      markers: [marker(5, MARKER_TYPE.PatrolHelicopter, 2000, 2000), marker(6, MARKER_TYPE.Explosion, 2010, 2010)],
      at: at(0),
    })
    trackMarkers(db, { wipeId, worldSize: WORLD, markers: [marker(5, MARKER_TYPE.PatrolHelicopter, 2000, 2000)], at: at(60) })
    const d = trackMarkers(db, { wipeId, worldSize: WORLD, markers: [], at: at(600) })
    assert.equal(d.ended.find((e) => e.kind === 'heli')!.label, 'Patrol Heli left the map')
  })

  test('a locked crate by an offshore monument is an oil rig crate with a 15-minute ETA', () => {
    const { db, wipeId } = freshDb()
    // Rust+ y is metres from the BOTTOM; normalised y runs from the top.
    db.prepare(`INSERT INTO monuments (wipe_id, name, kind, x, y) VALUES (?, 'offshore #1', 'offshore', ?, ?)`)
      .run(wipeId, 3800 / WORLD, 1 - 3600 / WORLD)
    const d = trackMarkers(db, { wipeId, worldSize: WORLD, markers: [marker(9, MARKER_TYPE.Crate, 3820, 3610)], at: at(0) })
    assert.match(d.started[0].label, /^Locked crate · oil rig/)
    const row = db.prepare(`SELECT eta_at, confidence FROM game_events`).get() as { eta_at: string; confidence: number }
    assert.equal(Date.parse(row.eta_at) - T0, CRATE_UNLOCK_SECONDS * 1000)
    assert.ok(row.confidence < 1, 'the unlock time is a lower bound and says so')
  })

  test('markers we do not track are ignored', () => {
    const { db, wipeId } = freshDb()
    const d = trackMarkers(db, {
      wipeId, worldSize: WORLD,
      markers: [marker(1, MARKER_TYPE.VendingMachine, 10, 10), marker(2, MARKER_TYPE.Player, 20, 20)],
      at: at(0),
    })
    assert.equal(d.started.length, 0)
  })

  test('a restart mid-event reconciles instead of announcing it again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nabrust-ev-'))
    const path = join(dir, 'e.db')
    let db = openDb(path, { quiet: true })
    db.prepare(`INSERT INTO servers (id, name, created_at) VALUES ('srv', 'T', ?)`).run(nowIso())
    db.prepare(`INSERT INTO wipes (server_id, started_at) VALUES ('srv', ?)`).run(nowIso())
    const wipeId = currentWipe(db, 'srv')!.id
    trackMarkers(db, { wipeId, worldSize: WORLD, markers: [marker(1, MARKER_TYPE.CH47, 10, 10)], at: at(0) })
    db.close()

    db = openDb(path, { quiet: true })
    const d = trackMarkers(db, { wipeId, worldSize: WORLD, markers: [marker(1, MARKER_TYPE.CH47, 30, 30)], at: at(15) })
    assert.equal(d.started.length, 0)
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM game_events`).get() as { n: number }).n, 1)
    db.close()
  })

  test('an old game_events table is rebuilt so new event kinds fit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nabrust-ev-'))
    const path = join(dir, 'old.db')
    const raw = new DatabaseSync(path)
    raw.exec(`
      CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE wipes (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, seed INTEGER, world_size INTEGER,
        tier TEXT NOT NULL DEFAULT 'hot', UNIQUE (server_id, started_at));
      CREATE TABLE game_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wipe_id INTEGER NOT NULL REFERENCES wipes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('cargo','heli','crate','chinook')),
        observed_at TEXT NOT NULL, eta_at TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL CHECK (source IN ('observed','rf-alarm','inferred')));
      INSERT INTO servers VALUES ('srv', 'T', '2026-09-01');
      INSERT INTO wipes (server_id, started_at) VALUES ('srv', '2026-09-01');
      INSERT INTO game_events (wipe_id, kind, observed_at, source) VALUES (1, 'cargo', '2026-09-02', 'observed');
    `)
    raw.close()

    const db = openDb(path, { quiet: true })
    const n = db.prepare(`SELECT COUNT(*) n FROM game_events`).get() as { n: number }
    assert.equal(n.n, 1, 'existing events survive the rebuild')
    db.prepare(`INSERT INTO game_events (wipe_id, kind, observed_at, source, label) VALUES (1, 'explosion', ?, 'observed', 'x')`)
      .run(nowIso())
    db.close()
  })

  console.log('\nteam state')

  test('team state keeps the last known position of a teammate who logs off', () => {
    const { db, wipeId } = freshDb()
    const member = (online: boolean, x: number) => ({
      steamId: '76561198000000009', name: 'kettle', x, y: 2000,
      isOnline: online, spawnTime: 0, isAlive: true, deathTime: 0,
    })
    const team = (m: ReturnType<typeof member>) => ({ leaderSteamId: m.steamId, members: [m], mapNotes: [], leaderMapNotes: [] })

    syncTeam(db, 'srv', wipeId, team(member(true, 1000)), { worldSize: WORLD })
    syncTeam(db, 'srv', wipeId, team(member(false, 0)), { worldSize: WORLD })
    const row = db.prepare(`SELECT name, x, online, alive FROM team_state`).get() as
      { name: string; x: number; online: number; alive: number }
    assert.equal(row.name, 'kettle')
    assert.equal(row.online, 0)
    assert.ok(Math.abs(row.x - 1000 / WORLD) < 1e-9, `x ${row.x}`)
  })
}

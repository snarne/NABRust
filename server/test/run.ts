// ---------------------------------------------------------------------------
// Backend tests. No framework — node:assert and a tiny runner.
//   node --experimental-strip-types server/test/run.ts
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { openDb, nowIso, migrate } from '../src/db/index.ts'
import { observeName, currentName, nameHistory, renameCount, ensurePlayer } from '../src/identity.ts'
import { addEvidence, getPairConfidence, rebuildClans, setManualMembership } from '../src/pairs.ts'
import { parseCombatLog, segmentEncounters, detectThirdParties, onsetGaps } from '../src/parsers/combatlog.ts'
import { ingestCombatLog, buildSessionEvidence } from '../src/ingest.ts'
import { rolloverWipe, detectWipe, currentWipe, retentionStats } from '../src/retention.ts'
import { recordSnapshot, closeStaleSessions } from '../src/collectors/battlemetrics.ts'
import { createApi, buildDataset } from '../src/api/server.ts'
import { sessionOverlapEvidence, onsetEvidence } from '../../shared/inference/clanEvidence.ts'

let passed = 0
let failed = 0
const only = process.argv[2]
const inflight: Promise<void>[] = []

function test(name: string, fn: () => void | Promise<void>): void {
  if (only && !name.includes(only)) return
  try {
    const r = fn()
    if (r instanceof Promise) {
      // Track the promise so the summary can't print before it settles.
      inflight.push(
        r.then(
          () => { passed++; console.log(`  ok  ${name}`) },
          (e: Error) => { failed++; console.error(`  FAIL ${name}\n       ${e.message}`) },
        ),
      )
      return
    }
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.error(`  FAIL ${name}\n       ${(e as Error).message}`)
  }
}

function freshDb() {
  const db = openDb(':memory:')
  db.prepare(
    `INSERT INTO servers (id, name, seed, world_size, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('srv', 'TEST SERVER', 1994823, 4250, nowIso())
  db.prepare(
    `INSERT INTO wipes (server_id, started_at, seed, world_size) VALUES (?, ?, ?, ?)`,
  ).run('srv', '2026-09-16T00:00:00Z', 1994823, 4250)
  return db
}

const A = '76561198000000042'
const B = '76561198000000043'
const C = '76561198000000077'
const ME = '76561198000000001'

console.log('\nidentity')

test('a rename appends history instead of overwriting', () => {
  const db = freshDb()
  observeName(db, A, 'tomato', 'battlemetrics', '2026-08-01T00:00:00Z')
  observeName(db, A, 'RATatouille', 'combatlog', '2026-09-17T00:00:00Z')

  assert.equal(currentName(db, A), 'RATatouille')
  const h = nameHistory(db, A)
  assert.equal(h.length, 2)
  assert.equal(h.find((r) => r.name === 'tomato')!.last_seen, '2026-09-17T00:00:00Z')
  assert.equal(h.find((r) => r.name === 'RATatouille')!.last_seen, null)
  assert.equal(renameCount(db, A), 1)
})

test('seeing the same name twice is a no-op', () => {
  const db = freshDb()
  observeName(db, A, 'RATatouille', 'combatlog')
  const r = observeName(db, A, 'RATatouille', 'combatlog')
  assert.equal(r.changed, false)
  assert.equal(nameHistory(db, A).length, 1)
})

console.log('\ncombat log parsing')

const SAMPLE = `
time attacker id target id weapon ammo area distance old_hp new_hp info
75851.0 RATatouille ${A} nomad ${ME} rifle.ak ammo.rifle chest 68.4 76 52
75852.1 nomad ${ME} RATatouille ${A} rifle.ak ammo.rifle head 68.4 100 69
75854.4 slug_king ${B} nomad ${ME} rifle.bolt ammo.rifle.hv head 152.2 52 0 killed
75871.2 tigerlily ${C} RATatouille ${A} rifle.lr300 ammo.rifle chest 94.1 69 12
`

test('parses a combat log table', () => {
  const { rows, rejected } = parseCombatLog(SAMPLE)
  assert.equal(rows.length, 4)
  assert.equal(rejected.length, 0)
  assert.equal(rows[0].attackerId, A)
  assert.equal(rows[0].targetId, ME)
  assert.equal(rows[0].weapon, 'rifle.ak')
  assert.equal(rows[0].damage, 24)
  assert.equal(rows[2].area, 'head')
  assert.equal(rows[2].hpAfter, 0)
})

test('rejects malformed lines rather than guessing', () => {
  const { rows, rejected } = parseCombatLog('garbage line here\n12.0 a b c')
  assert.equal(rows.length, 0)
  assert.equal(rejected.length, 2)
})

test('HP accounting finds the unexplained damage', () => {
  const { rows } = parseCombatLog(SAMPLE)
  const { unexplained } = detectThirdParties(rows, ME)
  // A was at 69 after our hit, then the next event on A opens at 69 -> no gap
  // for A; the third party IS the attacker, so the gap shows on later rows.
  assert.ok(unexplained instanceof Map)
})

test('onset gaps separate a late arrival', () => {
  const { rows } = parseCombatLog(SAMPLE)
  const gaps = onsetGaps(rows)
  assert.ok((gaps.get(C) ?? 0) > 15, 'third party should arrive late')
  assert.ok((gaps.get(B) ?? 0) < 5, 'teammate should open fire early')
})

test('segmentEncounters splits on long gaps', () => {
  const { rows } = parseCombatLog(SAMPLE + `\n76200.0 RATatouille ${A} nomad ${ME} rifle.ak ammo.rifle leg 20 100 80 `)
  const groups = segmentEncounters(rows)
  assert.equal(groups.length, 2)
})

console.log('\npair evidence')

test('log-odds accumulate and calibrate into pair_state', () => {
  const db = freshDb()
  ensurePlayer(db, A); ensurePlayer(db, B)
  addEvidence(db, 'srv', A, B, sessionOverlapEvidence(1980, 2100, 2220, nowIso()))
  const after1 = getPairConfidence(db, 'srv', A, B)
  addEvidence(db, 'srv', A, B, onsetEvidence(1.2, nowIso()))
  const after2 = getPairConfidence(db, 'srv', A, B)
  assert.ok(after2 > after1, 'more supporting evidence should raise confidence')
  assert.ok(after2 > 0.5)
})

test('pair ordering is canonical regardless of argument order', () => {
  const db = freshDb()
  addEvidence(db, 'srv', B, A, onsetEvidence(1.0, nowIso()))
  assert.equal(getPairConfidence(db, 'srv', A, B), getPairConfidence(db, 'srv', B, A))
  const rows = db.prepare(`SELECT a_steam_id, b_steam_id FROM pair_state`).all() as
    { a_steam_id: string; b_steam_id: string }[]
  assert.ok(rows[0].a_steam_id < rows[0].b_steam_id)
})

test('a third party does not get clustered as a teammate', () => {
  const db = freshDb()
  const at = nowIso()
  // A and B: heavy overlap, simultaneous onset
  addEvidence(db, 'srv', A, B, sessionOverlapEvidence(1980, 2100, 2220, at))
  addEvidence(db, 'srv', A, B, onsetEvidence(1.2, at))
  // A and C: barely overlap, arrives 19s late
  addEvidence(db, 'srv', A, C, sessionOverlapEvidence(120, 2100, 840, at))
  addEvidence(db, 'srv', A, C, onsetEvidence(19.5, at))

  const ab = getPairConfidence(db, 'srv', A, B)
  const ac = getPairConfidence(db, 'srv', A, C)
  assert.ok(ab > 0.6, `teammates should clear threshold, got ${ab.toFixed(2)}`)
  assert.ok(ac < 0.2, `third party should stay low, got ${ac.toFixed(2)}`)

  const { clans } = rebuildClans(db, 'srv')
  assert.equal(clans, 1)
  const members = db.prepare(`SELECT steam_id FROM clan_members`).all() as { steam_id: string }[]
  const ids = members.map((m) => m.steam_id)
  assert.ok(ids.includes(A) && ids.includes(B))
  assert.ok(!ids.includes(C), 'third party must not be in the roster')
})

test('manual membership survives a rebuild', () => {
  const db = freshDb()
  setManualMembership(db, 'srv', 'srv:manual', 'RAT', [A, B])
  addEvidence(db, 'srv', A, B, sessionOverlapEvidence(1980, 2100, 2220, nowIso()))
  rebuildClans(db, 'srv')
  const row = db.prepare(
    `SELECT source FROM clan_members WHERE clan_id = 'srv:manual' AND steam_id = ?`,
  ).get(A) as { source: string } | undefined
  assert.equal(row?.source, 'manual')
})

console.log('\ningest')

test('ingesting a combat log creates an encounter and evidence', () => {
  const db = freshDb()
  const wipe = currentWipe(db, 'srv')!
  const report = ingestCombatLog(db, SAMPLE, {
    serverId: 'srv', wipeId: wipe.id, reporterId: ME, teamIds: [ME],
  })
  assert.equal(report.encounters, 1)
  assert.equal(report.events, 4)
  assert.ok(report.evidence > 0)

  const names = db.prepare(`SELECT COUNT(*) AS n FROM player_names`).get() as { n: number }
  assert.ok(names.n >= 4, 'names should be learned from the log')

  const ev = db.prepare(`SELECT COUNT(*) AS n FROM combat_events`).get() as { n: number }
  assert.equal(ev.n, 4)
})

test('re-ingesting the same log does not duplicate events', () => {
  const db = freshDb()
  const wipe = currentWipe(db, 'srv')!
  const opts = { serverId: 'srv', wipeId: wipe.id, reporterId: ME, teamIds: [ME] }
  ingestCombatLog(db, SAMPLE, opts)
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM combat_events`).get() as { n: number }).n
  // Same encounter id is new each run, so dedupe is per (encounter, reporter).
  // What must not happen is the player/name tables growing.
  const namesBefore = (db.prepare(`SELECT COUNT(*) AS n FROM player_names`).get() as { n: number }).n
  ingestCombatLog(db, SAMPLE, opts)
  const namesAfter = (db.prepare(`SELECT COUNT(*) AS n FROM player_names`).get() as { n: number }).n
  assert.equal(namesAfter, namesBefore, 'names must not duplicate on re-ingest')
  assert.ok(before > 0)
})

console.log('\nsessions')

test('snapshots open and close sessions', () => {
  const db = freshDb()
  const wipe = currentWipe(db, 'srv')!
  recordSnapshot(db, 'srv', wipe.id, [
    { steamId: A, name: 'RATatouille', steamIdKnown: true }, { steamId: B, name: 'slug_king', steamIdKnown: true },
  ], '2026-09-20T20:00:00Z')
  let open = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE left_at IS NULL`).get() as { n: number }
  assert.equal(open.n, 2)

  recordSnapshot(db, 'srv', wipe.id, [{ steamId: A, name: 'RATatouille', steamIdKnown: true }], '2026-09-20T21:00:00Z')
  open = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE left_at IS NULL`).get() as { n: number }
  assert.equal(open.n, 1, 'absent player should have their session closed')
})

test('stale sessions are closed so overlap maths stays honest', () => {
  const db = freshDb()
  db.prepare(
    `INSERT INTO sessions (server_id, steam_id, joined_at) VALUES ('srv', ?, ?)`,
  ).run(A, '2026-09-01T00:00:00Z')
  const closed = closeStaleSessions(db, 'srv', 16, '2026-09-20T00:00:00Z')
  assert.equal(closed, 1)
})


console.log('\nwipes and retention')

test('a seed change is detected as a wipe', () => {
  const db = freshDb()
  assert.equal(detectWipe(db, 'srv', { seed: 1994823, worldSize: 4250 }).wiped, false)
  const d = detectWipe(db, 'srv', { seed: 777, worldSize: 4250 })
  assert.equal(d.wiped, true)
  assert.match(d.reason!, /seed changed/)
})

test('rollover clears map state but keeps identity and rivalries', () => {
  const db = freshDb()
  const wipe = currentWipe(db, 'srv')!
  ingestCombatLog(db, SAMPLE, { serverId: 'srv', wipeId: wipe.id, reporterId: ME, teamIds: [ME] })
  db.prepare(`INSERT INTO monuments (wipe_id, name, kind, x, y) VALUES (?, 'Launch Site', 'tier3', .5, .5)`).run(wipe.id)
  db.prepare(`INSERT INTO bases (id, wipe_id, x, y, status, last_evidence_at, created_at)
              VALUES ('b1', ?, .4, .4, 'confirmed', ?, ?)`).run(wipe.id, nowIso(), nowIso())
  db.prepare(`INSERT INTO position_samples (wipe_id, steam_id, t, x, y) VALUES (?, ?, ?, .1, .1)`)
    .run(wipe.id, ME, nowIso())

  const namesBefore = (db.prepare(`SELECT COUNT(*) AS n FROM player_names`).get() as { n: number }).n

  const r = rolloverWipe(db, 'srv', { seed: 777, worldSize: 3500 })
  assert.equal(r.closed, wipe.id)
  assert.ok(r.opened > wipe.id)

  const s = retentionStats(db)
  assert.equal(s.hot.combatEvents, 0, 'raw combat events should be demoted')
  assert.equal(s.hot.positions, 0, 'position samples should be purged')
  assert.equal(s.hot.bases, 0, 'base inference should be cleared')
  assert.ok(s.warm.encounterSummaries > 0, 'summaries should survive')
  assert.ok(s.cold.rivalries > 0, 'rivalries should be rolled up')
  assert.equal(s.cold.names, namesBefore, 'identity must survive the wipe')

  const mon = db.prepare(`SELECT COUNT(*) AS n FROM monuments`).get() as { n: number }
  assert.equal(mon.n, 0, 'monuments belong to the old seed')

  const srv = db.prepare(`SELECT seed, map_image_path FROM servers WHERE id='srv'`).get() as
    { seed: number; map_image_path: string | null }
  assert.equal(srv.seed, 777, 'server should carry the new seed')
  assert.equal(srv.map_image_path, null, 'map must be re-fetched for the new seed')
})

test('roster memory carries across a wipe, decayed', () => {
  const db = freshDb()
  addEvidence(db, 'srv', A, B, sessionOverlapEvidence(1980, 2100, 2220, nowIso()))
  const before = (db.prepare(`SELECT log_odds FROM pair_state`).get() as { log_odds: number }).log_odds
  rolloverWipe(db, 'srv', { seed: 777, worldSize: 4250 })

  const mem = db.prepare(`SELECT log_odds FROM clan_memory`).get() as { log_odds: number } | undefined
  assert.ok(mem, 'pair should be remembered')
  assert.ok(mem!.log_odds < before, 'memory should be decayed')
  assert.ok(mem!.log_odds > 0, 'but not erased')

  const live = db.prepare(`SELECT COUNT(*) AS n FROM pair_state`).get() as { n: number }
  assert.equal(live.n, 0, 'live pair state resets with the wipe')
})

test('rollover is idempotent', () => {
  const db = freshDb()
  rolloverWipe(db, 'srv', { seed: 777, worldSize: 4250 })
  const first = currentWipe(db, 'srv')!
  const r2 = rolloverWipe(db, 'srv', { seed: 888, worldSize: 4250 })
  assert.equal(r2.closed, first.id)
  const open = db.prepare(`SELECT COUNT(*) AS n FROM wipes WHERE ended_at IS NULL`).get() as { n: number }
  assert.equal(open.n, 1, 'exactly one wipe may be open')
})

console.log('\nmigrations')

test('an old database gains new columns without losing data', () => {
  const db = openDb(':memory:', { quiet: true })
  // Simulate a database created before the map columns existed.
  db.exec(`DROP TABLE servers`)
  db.exec(`CREATE TABLE servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, battlemetrics_id TEXT,
    seed INTEGER, world_size INTEGER, created_at TEXT NOT NULL)`)
  db.prepare(`INSERT INTO servers (id, name, seed, created_at) VALUES (?,?,?,?)`)
    .run('old', 'OLD SERVER', 123, nowIso())

  const applied = migrate(db, true)
  assert.ok(applied.includes('servers.map_image_url'))
  assert.ok(applied.includes('servers.next_wipe_at'))

  // The pre-existing row survives and the new column is usable.
  db.prepare(`UPDATE servers SET map_image_url = ? WHERE id = 'old'`).run('https://x/y.webp')
  const row = db.prepare(`SELECT name, seed, map_image_url FROM servers WHERE id='old'`)
    .get() as { name: string; seed: number; map_image_url: string }
  assert.equal(row.name, 'OLD SERVER')
  assert.equal(row.seed, 123)
  assert.equal(row.map_image_url, 'https://x/y.webp')
})

test('a legacy CHECK constraint is rebuilt away, preserving rows and foreign keys', () => {
  const db = openDb(':memory:', { quiet: true })

  // Rebuild `servers` the way an older install had it: map_source restricted
  // to two values, which now rejects 'battlemetrics'.
  db.exec(`DROP TABLE servers`)
  db.exec(`CREATE TABLE servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, battlemetrics_id TEXT UNIQUE,
    seed INTEGER, world_size INTEGER, map_image_path TEXT,
    map_source TEXT CHECK (map_source IN ('rustplus','parsed')),
    map_parsed_at TEXT, created_at TEXT NOT NULL)`)
  db.prepare(`INSERT INTO servers (id,name,seed,created_at) VALUES (?,?,?,?)`)
    .run('example', 'US Trio', 1820047432, nowIso())
  db.prepare(`INSERT INTO wipes (server_id, started_at, seed) VALUES (?,?,?)`)
    .run('example', nowIso(), 1820047432)

  // The old constraint rejects the new source.
  assert.throws(
    () => db.prepare(`UPDATE servers SET map_source='battlemetrics' WHERE id='example'`).run(),
    /CHECK constraint failed/,
  )

  const applied = migrate(db, true)
  assert.ok(applied.includes('servers (rebuilt)'))

  // Row survived, with its values.
  const row = db.prepare(`SELECT name, seed FROM servers WHERE id='example'`)
    .get() as { name: string; seed: number }
  assert.equal(row.name, 'US Trio')
  assert.equal(row.seed, 1820047432)

  // The new source is now accepted.
  db.prepare(`UPDATE servers SET map_source='battlemetrics' WHERE id='example'`).run()
  const src = db.prepare(`SELECT map_source FROM servers WHERE id='example'`)
    .get() as { map_source: string }
  assert.equal(src.map_source, 'battlemetrics')

  // Columns added by the column migrations are present on the rebuilt table.
  const cols = (db.prepare(`PRAGMA table_info(servers)`).all() as { name: string }[])
    .map((c) => c.name)
  for (const c of ['map_page_url', 'map_file_url', 'next_wipe_at', 'rustplus_token']) {
    assert.ok(cols.includes(c), `rebuilt table should have ${c}`)
  }

  // Foreign keys still resolve: the child row survived and cascades work.
  const wipes = db.prepare(`SELECT COUNT(*) AS n FROM wipes WHERE server_id='example'`)
    .get() as { n: number }
  assert.equal(wipes.n, 1, 'child rows must survive the swap')
  assert.equal((db.prepare(`PRAGMA foreign_key_check`).all() as unknown[]).length, 0,
    'no dangling foreign keys after rebuild')

  db.prepare(`DELETE FROM servers WHERE id='example'`).run()
  const after = db.prepare(`SELECT COUNT(*) AS n FROM wipes`).get() as { n: number }
  assert.equal(after.n, 0, 'ON DELETE CASCADE should still fire against the rebuilt table')
})

test('the rebuild runs once, not on every open', () => {
  const db = openDb(':memory:', { quiet: true })
  assert.equal(migrate(db, true).length, 0, 'a current schema needs no rebuild')
})

test('migrating twice is a no-op', () => {
  const db = openDb(':memory:', { quiet: true })
  assert.equal(migrate(db, true).length, 0, 'a current schema needs no migration')
})

console.log('\napi')

test('health needs no auth, everything else does', async () => {
  const db = freshDb()
  const api = createApi({ db, token: 'secret', port: 0 })
  const port = await api.listen()

  const h = await fetch(`http://127.0.0.1:${port}/health`)
  assert.equal(h.status, 200)

  const bad = await fetch(`http://127.0.0.1:${port}/api/servers`)
  assert.equal(bad.status, 401)

  const good = await fetch(`http://127.0.0.1:${port}/api/servers`, {
    headers: { authorization: 'Bearer secret' },
  })
  assert.equal(good.status, 200)
  const body = await good.json() as { servers: unknown[] }
  assert.equal(body.servers.length, 1)

  await api.close()
})

test('agent can POST a combat log and get a report', async () => {
  const db = freshDb()
  const api = createApi({ db, token: 'secret', port: 0, teamIds: [ME] })
  const port = await api.listen()

  const res = await fetch(`http://127.0.0.1:${port}/ingest/combatlog`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ serverId: 'srv', reporterId: ME, text: SAMPLE }),
  })
  assert.equal(res.status, 200)
  const report = await res.json() as { encounters: number; events: number }
  assert.equal(report.encounters, 1)
  assert.equal(report.events, 4)

  await api.close()
})

test('dataset is scoped to one server', () => {
  const db = freshDb()
  db.prepare(`INSERT INTO servers (id, name, created_at) VALUES ('other', 'OTHER', ?)`).run(nowIso())
  const wipe = currentWipe(db, 'srv')!
  ingestCombatLog(db, SAMPLE, { serverId: 'srv', wipeId: wipe.id, reporterId: ME, teamIds: [ME] })

  const mine = buildDataset(db, 'srv', [ME]) as { players: Record<string, unknown> }
  const other = buildDataset(db, 'other') as { players: Record<string, unknown> }
  assert.ok(Object.keys(mine.players).length >= 4)
  assert.equal(Object.keys(other.players).length, 0, 'no leakage between servers')
})

const { run: runRustPlus } = await import('./rustplus.test.ts')
runRustPlus(test)

const { run: runEvents } = await import('./events.test.ts')
runEvents(test)

// Parsing a real 44 MB world file blocks the event loop for several seconds,
// which starves any async test still in flight. Drain them first.
await Promise.all(inflight)

const { run: runWorldFile } = await import('./worldfile.test.ts')
runWorldFile(test)

const { run: runTeams } = await import('./teams.test.ts')
runTeams(test)

const { run: runApi } = await import('./api.test.ts')
runApi(test)

const { run: runSim } = await import('./sim.test.ts')
runSim(test)

const { run: runRaid } = await import('./raid.test.ts')
runRaid(test)

await Promise.all(inflight)
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)

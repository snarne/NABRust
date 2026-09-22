// ---------------------------------------------------------------------------
// Teammate detection: the session evidence builder, the population prior,
// roster building, and the validation harness as a regression guard.
//
// The first tests reproduce the failure seen on a real busy night —
// 19,518 pairs all scored as 70% teammates — and assert it can't recur.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { openDb, nowIso, backfillSessionCensoring } from '../src/db/index.ts'
import { buildSessionEvidence, watchedMs } from '../src/ingest.ts'
import { getPairConfidence, inferTeamLimit, pairPrior, rebuildClans, refreshAllPairStates, teamLimit } from '../src/pairs.ts'
import { recordSnapshot } from '../src/collectors/battlemetrics.ts'
import { simulateServer, evaluate, reliability } from '../src/validation/simulate.ts'
import { binomialLLR, coMovementStats, pairPriorLogOdds } from '../../shared/inference/sessionEvidence.ts'
import { clusterPairs } from '../../shared/inference/clanEvidence.ts'

type TestFn = (name: string, fn: () => void | Promise<void>) => void

const MIN = 60_000
const T0 = Date.parse('2026-09-20T00:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

function freshDb(name = 'EXAMPLE TRIO SERVER') {
  const db = openDb(':memory:', { quiet: true })
  db.prepare(`INSERT INTO servers (id, name, created_at) VALUES ('srv', ?, ?)`).run(name, nowIso())
  db.prepare(`INSERT INTO wipes (server_id, started_at) VALUES ('srv', ?)`).run(iso(T0))
  return db
}

/**
 * Drive the real collector with a scripted server: `online(t)` says who is on
 * at each one-minute poll. This is how sessions get into the database for
 * real, censoring and poll log included.
 */
function collect(db: ReturnType<typeof freshDb>, minutes: number, online: (t: number) => string[]) {
  for (let m = 0; m <= minutes; m++) {
    const t = T0 + m * MIN
    recordSnapshot(db, 'srv', 1, online(t).map((id) => ({ steamId: id, name: id, steamIdKnown: false })), iso(t))
  }
  return T0 + minutes * MIN
}

/** A background crowd with unrelated, staggered sessions. */
function crowd(n: number, seed = 1) {
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
  const plan = Array.from({ length: n }, (_, i) => {
    const sessions: [number, number][] = []
    for (let d = 0; d < 3; d++) {
      const a = T0 + d * 1440 * MIN + Math.floor(rnd() * 1200) * MIN
      sessions.push([a, a + (60 + Math.floor(rnd() * 240)) * MIN])
    }
    return { id: `c${i}`, sessions }
  })
  return (t: number) => plan.filter((p) => p.sessions.some(([a, b]) => a <= t && t < b)).map((p) => p.id)
}

export function run(test: TestFn) {
  console.log('\nteammate detection')

  test('long overlap alone is not evidence of a team', () => {
    // Two players online for hours at once, arriving and leaving at unrelated
    // times — the pattern that made a whole server look like one clan.
    const db = freshDb()
    const bg = crowd(40)
    const end = collect(db, 3 * 1440, (t) => {
      const on = bg(t)
      const h = ((t - T0) / MIN) % 1440
      if (h >= 600 && h < 1200) on.push('A')
      if (h >= 700 && h < 1300) on.push('B')
      return on
    })
    buildSessionEvidence(db, 'srv', { at: iso(end) })
    assert.ok(getPairConfidence(db, 'srv', 'A', 'B') < 0.1,
      `overlap-only pair scored ${getPairConfidence(db, 'srv', 'A', 'B')}`)
  })

  test('joining and leaving together, repeatedly, is', () => {
    const db = freshDb()
    const bg = crowd(40)
    const end = collect(db, 3 * 1440, (t) => {
      const on = bg(t)
      const h = ((t - T0) / MIN) % 1440
      if (h >= 1100 && h < 1280) on.push('A')
      if (h >= 1101 && h < 1281) on.push('B') // one poll behind, both ways
      return on
    })
    buildSessionEvidence(db, 'srv', { at: iso(end) })
    const p = getPairConfidence(db, 'srv', 'A', 'B')
    assert.ok(p > 0.9, `co-moving pair scored only ${p}`)
  })

  test('everyone online when the collector starts did not "join together"', () => {
    const db = freshDb()
    // 30 players already on at the first poll, then they drift off one by one.
    const end = collect(db, 600, (t) => {
      const m = (t - T0) / MIN
      return Array.from({ length: 30 }, (_, i) => `x${i}`).filter((_, i) => m < 100 + i * 17)
    })
    const n = buildSessionEvidence(db, 'srv', { at: iso(end) })
    assert.equal(n, 0, 'start-up joins must be censored')
    const censored = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE join_censored = 1`).get() as { n: number }
    assert.equal(censored.n, 30)
  })

  test('a server restart does not make everyone a team', () => {
    const db = freshDb()
    const bg = crowd(60, 7)
    // Daily restart at 11:00: everyone is kicked and most return within 10 min.
    const end = collect(db, 3 * 1440, (t) => {
      const h = ((t - T0) / MIN) % 1440
      if (h >= 660 && h < 662) return []
      if (h >= 662 && h < 672) return bg(t).filter((id) => Number(id.slice(1)) % 10 < (h - 662))
      return bg(t)
    })
    buildSessionEvidence(db, 'srv', { at: iso(end) })
    const strong = db.prepare(`SELECT COUNT(*) AS n FROM pair_state WHERE server_id = 'srv' AND confidence > 0.5`).get() as { n: number }
    assert.ok(strong.n <= 2, `${strong.n} pairs flagged after restarts`)
  })

  test('a collector outage ends sessions as unobserved, not as logouts', () => {
    const db = freshDb()
    recordSnapshot(db, 'srv', 1, [{ steamId: 'A', name: 'A', steamIdKnown: false }, { steamId: 'B', name: 'B', steamIdKnown: false }], iso(T0))
    recordSnapshot(db, 'srv', 1, [{ steamId: 'A', name: 'A', steamIdKnown: false }, { steamId: 'B', name: 'B', steamIdKnown: false }], iso(T0 + MIN))
    // down for an hour
    recordSnapshot(db, 'srv', 1, [{ steamId: 'A', name: 'A', steamIdKnown: false }], iso(T0 + 61 * MIN))
    const rows = db.prepare(`SELECT steam_id, left_at, leave_censored, join_censored FROM sessions ORDER BY id`).all() as
      { steam_id: string; left_at: string | null; leave_censored: number; join_censored: number }[]
    assert.equal(rows[0].leave_censored, 1)
    assert.equal(rows[1].leave_censored, 1)
    assert.equal(rows[2].join_censored, 1, 'the first poll after an outage sees, not observes, joins')
  })

  test('watched time skips outages', () => {
    const db = freshDb()
    for (const m of [0, 1, 2, 3, 60, 61, 62]) {
      recordSnapshot(db, 'srv', 1, [{ steamId: 'A', name: 'A', steamIdKnown: false }], iso(T0 + m * MIN))
    }
    assert.equal(watchedMs(db, 'srv', T0, T0 + 62 * MIN), 5 * MIN)
  })

  test('censoring is backfilled for sessions recorded before it existed', () => {
    const db = freshDb()
    const ins = db.prepare(`INSERT INTO sessions (server_id, steam_id, joined_at, left_at) VALUES ('srv', ?, ?, ?)`)
    ins.run('A', iso(T0), iso(T0 + 5 * MIN))            // first poll: censored join
    ins.run('B', iso(T0 + 2 * MIN), iso(T0 + 5 * MIN))  // observed join; leave right before a gap
    ins.run('C', iso(T0 + 90 * MIN), null)              // first poll after the gap
    db.prepare(`UPDATE sessions SET join_censored = 0, leave_censored = 0`).run()
    backfillSessionCensoring(db)
    const r = db.prepare(`SELECT steam_id, join_censored AS j, leave_censored AS l FROM sessions ORDER BY steam_id`).all() as
      { steam_id: string; j: number; l: number }[]
    assert.deepEqual(r.map((x) => [x.steam_id, x.j, x.l]), [['A', 1, 1], ['B', 0, 1], ['C', 1, 0]])
  })

  test('rebuilding replaces session evidence instead of stacking it', () => {
    const db = freshDb()
    const end = collect(db, 2 * 1440, (t) => {
      const h = ((t - T0) / MIN) % 1440
      return h >= 1100 && h < 1280 ? ['A', 'B'] : []
    })
    buildSessionEvidence(db, 'srv', { at: iso(end) })
    buildSessionEvidence(db, 'srv', { at: iso(end) })
    const n = db.prepare(`SELECT COUNT(*) AS n FROM pair_evidence WHERE kind = 'session-overlap'`).get() as { n: number }
    assert.equal(n.n, 1)
  })

  test('the prior scales with population and team size', () => {
    // 1 in 250-ish on a 300-player trio server, far from the old fixed 4%.
    const p = 1 / (1 + Math.exp(-pairPriorLogOdds(300, 3)))
    assert.ok(p > 0.002 && p < 0.006, `prior ${p}`)
    assert.ok(pairPriorLogOdds(300, 8) > pairPriorLogOdds(300, 2))
    assert.ok(pairPriorLogOdds(50, 3) > pairPriorLogOdds(500, 3))
  })

  test('the server records the prior it used', () => {
    // 150 players on a trio server: ~1 in 125, stricter than the 4% default.
    // (With ~30 players the right prior really is about 4%.)
    const db = freshDb()
    const end = collect(db, 3 * 1440, crowd(150))
    buildSessionEvidence(db, 'srv', { at: iso(end) })
    const pop = (db.prepare(`SELECT COUNT(DISTINCT steam_id) AS n FROM sessions`).get() as { n: number }).n
    assert.ok(Math.abs(pairPrior(db, 'srv') - pairPriorLogOdds(pop, 3)) < 1e-9)
    assert.ok(pairPrior(db, 'srv') < -3.2, `prior ${pairPrior(db, 'srv')} for ${pop} players`)
  })

  test('team limit comes from the server name, or the column when set', () => {
    assert.equal(inferTeamLimit('example.com - US Trio'), 3)
    assert.equal(inferTeamLimit('[EU] Solo Only | Monthly'), 1)
    assert.equal(inferTeamLimit('Rusty Moose |US Main|'), null)
    const db = freshDb('Some Main Server')
    assert.equal(teamLimit(db, 'srv'), 8)
    db.prepare(`UPDATE servers SET team_limit = 4`).run()
    assert.equal(teamLimit(db, 'srv'), 4)
  })

  test('rosters never exceed the team limit', () => {
    const db = freshDb()
    const end = collect(db, 3 * 1440, (t) => {
      const h = ((t - T0) / MIN) % 1440
      // Five people who move together — on a trio server they can't all be one team.
      return h >= 1100 && h < 1280 ? ['A', 'B', 'C', 'D', 'E'] : []
    })
    buildSessionEvidence(db, 'srv', { at: iso(end) })
    rebuildClans(db, 'srv')
    const sizes = db.prepare(
      `SELECT COUNT(*) AS n FROM clan_members cm JOIN clans c ON c.id = cm.clan_id WHERE c.server_id = 'srv' GROUP BY c.id`,
    ).all() as { n: number }[]
    assert.ok(sizes.length > 0, 'expected at least one roster')
    assert.ok(sizes.every((s) => s.n <= 3), `sizes ${sizes.map((s) => s.n)}`)
  })

  test('a roster keeps its id across rebuilds, so bases stay attributed', () => {
    const db = freshDb()
    const at = nowIso()
    const add = (a: string, b: string) => db.prepare(
      `INSERT INTO pair_evidence (server_id, a_steam_id, b_steam_id, kind, log_odds, observed_at)
       VALUES ('srv', ?, ?, 'session-overlap', 12, ?)`,
    ).run(a, b, at)
    add('A', 'B'); add('X', 'Y')
    refreshAllPairStates(db, 'srv')
    rebuildClans(db, 'srv')
    const idOf = (m: string) => (db.prepare(`SELECT clan_id FROM clan_members WHERE steam_id = ?`).get(m) as { clan_id: string }).clan_id
    const ab = idOf('A')
    const xy = idOf('X')
    db.prepare(
      `INSERT INTO bases (id, wipe_id, x, y, status, owner_clan_id, created_at, last_evidence_at)
       VALUES ('b1', 1, 0.5, 0.5, 'confirmed', ?, ?, ?)`,
    ).run(ab, at, at)
    // A third member joins A+B; a new pair appears that sorts first.
    add('A', 'C'); add('B', 'C'); add('0', '1')
    refreshAllPairStates(db, 'srv')
    rebuildClans(db, 'srv')
    assert.equal(idOf('A'), ab)
    assert.equal(idOf('C'), ab)
    assert.equal(idOf('X'), xy)
    const base = db.prepare(`SELECT owner_clan_id FROM bases WHERE id = 'b1'`).get() as { owner_clan_id: string }
    assert.equal(base.owner_clan_id, ab)
  })

  test('negative evidence keeps a third party out of a roster', () => {
    const at = nowIso()
    const links = [
      { a: 'A', b: 'B', evidence: [{ kind: 'session-overlap' as const, logOdds: 9, at }] },
      { a: 'B', b: 'C', evidence: [{ kind: 'session-overlap' as const, logOdds: 9, at }] },
      // C shot at A with a late onset: strong evidence they are NOT a team
      { a: 'A', b: 'C', evidence: [{ kind: 'co-onset' as const, logOdds: -6, at }] },
    ]
    const groups = clusterPairs(links, { threshold: 0.6, maxTeam: 3, prior: -3 })
    assert.ok(!groups.some((g) => g.includes('A') && g.includes('C')), JSON.stringify(groups))
  })

  test('a binomial LLR is zero with no trials and signed by the evidence', () => {
    assert.equal(binomialLLR(0, 0, 0.5, 0.01), 0)
    assert.ok(binomialLLR(3, 3, 0.5, 0.01) > 0)
    assert.ok(binomialLLR(0, 6, 0.5, 0.01) < 0)
  })

  test('pairs that never align produce no rows at all', () => {
    const stats = coMovementStats([
      { player: 'A', join: 0, leave: 60 * MIN, joinCensored: false, leaveCensored: false },
      { player: 'B', join: 30 * MIN, leave: 90 * MIN, joinCensored: false, leaveCensored: false },
    ], { coverageMs: 120 * MIN })
    assert.equal(stats.length, 0)
  })

  console.log('\nvalidation harness')

  test('on a simulated week, co-movement finds teams the old model could not', () => {
    const sim = simulateServer({ seed: 101, hours: 168 })
    const r = evaluate(sim)
    assert.ok(r.coMovement.pairPrecision >= 0.85, `pair precision ${r.coMovement.pairPrecision}`)
    assert.ok(r.coMovement.rosterPrecision >= 0.9, `roster precision ${r.coMovement.rosterPrecision}`)
    assert.ok(r.coMovement.pairRecall >= 0.45, `pair recall ${r.coMovement.pairRecall}`)
    assert.ok(r.legacy.pairPrecision < r.coMovement.pairPrecision - 0.2,
      `legacy ${r.legacy.pairPrecision} vs new ${r.coMovement.pairPrecision}`)
  })

  test('with one day of data it stays cautious rather than wrong', () => {
    const sim = simulateServer({ seed: 102, hours: 24 })
    const r = evaluate(sim)
    // Few calls, but not the old model's thousands of wrong ones.
    assert.ok(r.coMovement.flagged < 150, `flagged ${r.coMovement.flagged}`)
    assert.ok(r.legacy.flagged > 5 * r.coMovement.flagged)
  })

  test('its confidences mean what they say', () => {
    let n = 0, err = 0
    for (const seed of [103, 104]) {
      for (const row of reliability(simulateServer({ seed, hours: 168 }))) {
        if (row.pairs < 40) continue
        n++
        err = Math.max(err, Math.abs(row.meanPredicted - row.observed))
      }
    }
    assert.ok(n >= 2, 'expected populated confidence bands')
    assert.ok(err < 0.15, `worst band off by ${err.toFixed(2)}`)
  })
}

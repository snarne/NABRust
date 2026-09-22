// ---------------------------------------------------------------------------
// The simulated server end to end: seed it through the real pipeline, then
// read it back through the real dataset — and score the retracer against the
// shooter positions the simulation knows.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { openDb } from '../src/db/index.ts'
import { seedSimulation, type SimTruth } from '../src/validation/simServer.ts'
import { datasetFor } from '../src/api/dataset.ts'
import { localizeShooter, syntheticTerrain } from '../../shared/inference/localize.ts'
import type { ServerDataset } from '../../shared/types.ts'

type TestFn = (name: string, fn: () => void | Promise<void>) => void

export function run(test: TestFn) {
  console.log('\nsimulated server')

  const NOW = Date.parse('2026-09-22T03:00:00Z')
  let cache: { ds: ServerDataset; truth: SimTruth } | null = null
  const seeded = () => {
    if (cache) return cache
    const db = openDb(':memory:', { quiet: true })
    const truth = seedSimulation(db, { seed: 5, hours: 48, players: 120, now: NOW })
    const ds = datasetFor(db, 'sim', { now: NOW })!
    cache = { ds, truth }
    return cache
  }

  test('every panel has data to show', () => {
    const { ds, truth } = seeded()
    assert.ok(Object.keys(ds.players).length > 60, `${Object.keys(ds.players).length} players`)
    assert.ok(ds.clans.length > 0, 'no rosters inferred')
    assert.equal(ds.team.length, 3)
    assert.ok(ds.team.every((m) => m.pos), 'team positions missing')
    assert.ok(ds.liveEvents.length >= 2, `events: ${ds.liveEvents.map((e) => e.label)}`)
    assert.ok(ds.bases.some((b) => b.ours), 'no home base')
    assert.ok(ds.bases.some((b) => b.raidPath), 'no raid path')
    assert.ok(ds.homePos)
    assert.ok(ds.gameTime)
    assert.equal(ds.self, truth.self)
    assert.equal(ds.server.name, 'SIMULATED · TRIO')
  })

  test('deaths are detected from Rust+ and joined to their combat logs', () => {
    const { ds, truth } = seeded()
    assert.equal(ds.deaths!.length, truth.deaths.length)
    for (const d of ds.deaths!) {
      assert.ok(d.killer, 'killer missing — combat log not attached to the death shell')
      assert.ok(d.fixes.length >= 2, `only ${d.fixes.length} range fixes`)
      assert.ok(d.pos, 'death position missing')
    }
    assert.ok(ds.recentEncounters!.length >= truth.deaths.length)
  })

  test('the third party in a fight is flagged, not rostered with the killer', () => {
    const { ds, truth } = seeded()
    // Unexplained HP loss on the killer is flagged on the victim's next hit.
    const flagged = ds.recentEncounters!.flatMap((e) => e.events).filter((e) => e.thirdPartyFlag)
    assert.ok(flagged.length >= 1, 'no third-party flag on the ambushed fight')
    // The late arrival is a separate party, never in the killer's roster.
    const killer = truth.deaths[1].killer
    const ambush = ds.recentEncounters!.flatMap((e) => e.events)
      .find((e) => e.attacker !== killer && e.target === truth.deaths[1].victim && e.attacker !== truth.deaths[1].victim)
    assert.ok(ambush, 'third party hit missing from the victim log')
    const killerClan = ds.clans.find((c) => c.members.some((m) => m.steamId === killer))
    assert.ok(!killerClan?.members.some((m) => m.steamId === ambush!.attacker), 'third party clustered with the killer')
    const link = ds.pairLinks.find((l) => [l.a, l.b].includes(killer) && [l.a, l.b].includes(ambush!.attacker as string))
    assert.ok(!link || (link.confidence ?? 0) < 0.2, `killer ~ third party at ${link?.confidence}`)
  })

  test('the retracer finds the true shooter from the logged ranges', () => {
    const { ds, truth } = seeded()
    const terrain = syntheticTerrain(128, 1)
    // Flat, open ground: the simulation had no world file, so neither does the solve.
    for (let j = 0; j < terrain.size; j++) for (let i = 0; i < terrain.size; i++) {
      terrain.height[j][i] = 0.3
      terrain.buildable[j][i] = true
    }
    const errs: number[] = []
    for (const d of ds.deaths!) {
      const t = truth.deaths.find((x) => x.encounterAt === d.at)!
      const r = localizeShooter(d.fixes, { terrain, worldSize: ds.server.worldSize, requireLineOfSight: false, sigmaMetres: 12 })
      errs.push(Math.hypot(r.best.x - t.shooter.x, r.best.y - t.shooter.y) * ds.server.worldSize)
    }
    const median = [...errs].sort((a, b) => a - b)[errs.length >> 1]
    assert.ok(median < 45, `retrace errors ${errs.map((e) => e.toFixed(0))} m`)
  })
}

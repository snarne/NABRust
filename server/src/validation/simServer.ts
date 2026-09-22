// ---------------------------------------------------------------------------
// A simulated server, fed through the real pipeline.
//
// NABRust only lights up fully while you play: deaths, fights, team positions
// and events all come from Rust+ and your combat log. To test every screen
// without being in game, this builds a server in its own database and pushes
// synthetic data through exactly the code live data takes:
//
//   Battlemetrics  recordSnapshot, one poll a minute, censoring and all
//   Rust+          syncTeam (deaths are detected, not inserted), trackMarkers,
//                  map notes, in-game time
//   combat logs    the real text format, through parseCombatLog + ingest
//   teams          buildSessionEvidence + rebuildClans
//
// Nothing here writes a row the live code wouldn't. The server is named and
// flagged SIMULATED so it can never be mistaken for intel, and it lives in a
// separate database file.
//
// Every death keeps its true shooter position in server_state, so the
// retracer can be scored against ground truth.
// ---------------------------------------------------------------------------

import type { DB } from '../db/index.ts'
import { nowIso, setServerState } from '../db/index.ts'
import { recordSnapshot } from '../collectors/battlemetrics.ts'
import { recordTeammateDeath, syncTeam } from '../rustplus/sync.ts'
import { trackMarkers } from '../rustplus/events.ts'
import { MARKER_TYPE, type AppMarker, type AppTeamInfo, type MapNote, type TeamMember } from '../rustplus/messages.ts'
import { buildSessionEvidence, ingestCombatLog } from '../ingest.ts'
import { rebuildClans } from '../pairs.ts'
import { createBase } from '../api/bases.ts'
import { readFileSync, existsSync } from 'node:fs'
import { readWorldFile } from '../parsers/worldfile.ts'
import { openTerrain, type Terrain } from '../parsers/terrain.ts'
import { mulberry32, simulateServer } from './simulate.ts'

const MIN = 60_000
const SERVER = 'sim'

export interface SimOptions {
  seed?: number
  hours?: number
  players?: number
  /** Copy the map (render, world file, monuments) from this server row. */
  map?: {
    worldSize: number
    seed: number | null
    imagePath: string | null
    worldPath: string | null
    monuments: { name: string; kind: string; x: number; y: number; prefab_id: number | null; height: number | null; radius: number | null }[]
  } | null
  now?: number
}

export interface SimTruth {
  self: string
  team: string[]
  enemies: string[]
  deaths: { encounterAt: string; victim: string; killer: string; shooter: { x: number; y: number } }[]
}

const HANDLES = [
  'RATatouille', 'slug_king', 'pixel.', 'tigerlily', 'mkultra', 'Golden_Potato', 'Jimmy420', 'SILVERstorm',
  'kettle', 'quartz', 'ridgeline', 'harlow', 'nohands', 'daddybaguette', 'fennec', 'lowgrav', 'Kittenz',
  'rockpile', 'otter', 'hazmatHenry', 'crate_goblin', 'quietfox', 'n00bslayer', 'Bushcamper', 'm4ple',
  'dustbin', 'sulfurwife', 'ladderman', 'o7', 'tarpit', 'Kobra', 'riverrat', 'guano', 'froggo', 'sw1ft',
]

/** Deterministic, obviously synthetic 17-digit ids, so combat logs parse. */
function steamIdFor(i: number): string {
  return `7656119900${String(i).padStart(7, '0')}`
}

export function seedSimulation(db: DB, opts: SimOptions = {}): SimTruth {
  const now = opts.now ?? Date.now()
  const hours = opts.hours ?? 72
  const rnd = mulberry32((opts.seed ?? 7) + 1000)
  const start = now - hours * 60 * MIN
  const worldSize = opts.map?.worldSize ?? 3750
  const half = worldSize / 2

  // Optional real terrain: shooters stand on buildable ground and ranges are
  // 3D, as they would be in game.
  let terrain: Terrain | null = null
  if (opts.map?.worldPath && existsSync(opts.map.worldPath)) {
    terrain = openTerrain(readWorldFile(readFileSync(opts.map.worldPath)))
  }
  const heightAt = (x: number, z: number) => (terrain ? terrain.heightAt(x, z) : 10)
  const buildable = (x: number, z: number) =>
    Math.abs(x) < half - 150 && Math.abs(z) < half - 150 && (terrain ? terrain.buildableAt(x, z) : true)

  // --- server ---------------------------------------------------------------
  db.prepare(
    `INSERT INTO servers (id, name, seed, world_size, max_pop, team_limit, map_image_path, map_world_path,
                          map_source, map_parsed_at, created_at)
     VALUES (?, 'SIMULATED · TRIO', ?, ?, 200, 3, ?, ?, ?, ?, ?)`,
  ).run(
    SERVER, opts.map?.seed ?? 1337, worldSize, opts.map?.imagePath ?? null, opts.map?.worldPath ?? null,
    opts.map?.imagePath ? 'parsed' : null, opts.map?.imagePath ? new Date(start).toISOString() : null,
    new Date(start).toISOString(),
  )
  const wipeId = Number(db.prepare(
    `INSERT INTO wipes (server_id, started_at, seed, world_size) VALUES (?, ?, ?, ?)`,
  ).run(SERVER, new Date(start).toISOString(), opts.map?.seed ?? 1337, worldSize).lastInsertRowid)
  for (const m of opts.map?.monuments ?? []) {
    db.prepare(
      `INSERT OR IGNORE INTO monuments (wipe_id, name, kind, x, y, prefab_id, height, radius) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(wipeId, m.name, m.kind, m.x, m.y, m.prefab_id, m.height, m.radius)
  }

  // --- population through the collector --------------------------------------
  const sim = simulateServer({ seed: opts.seed ?? 7, hours, players: opts.players ?? 180 })
  const idOf = new Map<string, string>()
  const nameOf = new Map<string, string>()
  let k = 0
  for (const team of sim.teams) for (const p of team) {
    const sid = steamIdFor(k)
    idOf.set(p, sid)
    nameOf.set(sid, k < HANDLES.length ? HANDLES[k] : `player_${k}`)
    k++
  }
  // The simulator's clock starts at its own t0; shift onto ours.
  const simT0 = Math.min(...sim.spans.map((s) => s.join))
  const shift = start - simT0
  const ticks = Math.floor((now - start) / MIN)
  const online: string[][] = Array.from({ length: ticks + 1 }, () => [])
  for (const s of sim.spans) {
    const a = Math.max(0, Math.round((s.join + shift - start) / MIN))
    // Still playing when the simulation ends → online in the final poll too.
    const end = Math.round((s.leave + shift - start) / MIN)
    const b = end >= ticks ? ticks : end - 1
    for (let t = a; t <= b; t++) online[t].push(idOf.get(s.player)!)
  }
  for (let t = 0; t <= ticks; t++) {
    const at = new Date(start + t * MIN).toISOString()
    recordSnapshot(db, SERVER, wipeId, online[t].map((id) => ({ steamId: id, name: nameOf.get(id)!, steamIdKnown: true })), at)
  }

  // --- who is who --------------------------------------------------------------
  const trios = sim.teams.filter((t) => t.length === 3).map((t) => t.map((p) => idOf.get(p)!))
  const team = trios[0]
  const enemies = trios[1]
  const thirdParty = trios[2]?.[0] ?? idOf.get(sim.teams.find((t) => t.length === 1)![0])!
  const self = team[0]

  // Home: a buildable spot away from the coast.
  const pick = (near?: { x: number; z: number }, minR = 0, maxR = half) => {
    for (let i = 0; i < 400; i++) {
      const r = minR + rnd() * (maxR - minR)
      const a = rnd() * Math.PI * 2
      const x = (near?.x ?? 0) + Math.cos(a) * r
      const z = (near?.z ?? 0) + Math.sin(a) * r
      if (buildable(x, z)) return { x, z }
    }
    return { x: near?.x ?? 0, z: near?.z ?? 0 }
  }
  const home = pick(undefined, 0, half * 0.6)
  const enemyHome = pick(home, 500, 900)
  const toRp = (p: { x: number; z: number }) => ({ x: p.x + half, y: p.z + half })
  const toNorm = (p: { x: number; z: number }) => ({ x: (p.x + half) / worldSize, y: (half - p.z) / worldSize })

  const member = (id: string, p: { x: number; z: number }, alive = true, isOnline = true): TeamMember => ({
    steamId: id, name: nameOf.get(id)!, ...toRp(p), isOnline, isAlive: alive, spawnTime: 0, deathTime: 0,
  })
  const teamInfo = (members: TeamMember[], notes: AppTeamInfo['mapNotes'] = []): AppTeamInfo => ({
    leaderSteamId: self, members, mapNotes: notes, leaderMapNotes: [],
  })
  const around = (p: { x: number; z: number }, r: number) => ({ x: p.x + (rnd() - 0.5) * r, z: p.z + (rnd() - 0.5) * r })

  // --- deaths, fights and the combat logs that describe them -------------------
  const truth: SimTruth = { self, team, enemies, deaths: [] }
  const fmt = (n: number) => n.toFixed(1)
  const line = (t: number, att: string, tgt: string, weapon: string, ammo: string, area: string, dist: number, hpA: number, hpB: number) =>
    `${fmt(t)}s ${nameOf.get(att)} ${att} ${nameOf.get(tgt)} ${tgt} ${weapon} ${ammo} ${area} ${fmt(dist)}m ${fmt(hpA)} ${fmt(hpB)}`

  const deathTimes = [0.35, 0.62, 0.9].map((f) => start + f * (now - start))
  deathTimes.forEach((D, di) => {
    const victim = team[di % team.length]
    const killer = enemies[di % enemies.length]
    // The victim runs a curving line across open ground; the shooter holds
    // still. (A dead-straight run would leave two mirror-image solutions —
    // real players rarely run straight under fire, and the retracer page
    // shows both lobes when they do.)
    const p0 = pick(home, 150, 450)
    const h0 = rnd() * Math.PI * 2
    const at = (s: number) => {
      // integrate a constant turn of ~0.7 degrees a second at 4 m/s
      const w = 0.012
      return {
        x: p0.x + (4 / w) * (Math.sin(h0 + w * s) - Math.sin(h0)),
        z: p0.z - (4 / w) * (Math.cos(h0 + w * s) - Math.cos(h0)),
      }
    }
    const deathPos = at(90)
    // The shooter must have been able to SEE the victim at every hit — the
    // game allows nothing else. Checked on the full-resolution heightmap.
    const sees = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      if (!terrain) return true
      const d = Math.hypot(b.x - a.x, b.z - a.z)
      const n = Math.ceil(d / 2)
      const ha = heightAt(a.x, a.z) + 1.6
      const hb = heightAt(b.x, b.z) + 1.6
      for (let i = 1; i < n; i++) {
        const f = i / n
        if (heightAt(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f) > ha + (hb - ha) * f + 0.3) return false
      }
      return true
    }
    let shooter = pick(deathPos, 90, 190)
    for (let tries = 0; tries < 300; tries++) {
      if ([63, 65, 75, 78, 90].every((s) => sees(shooter, at(s)))) break
      shooter = pick(deathPos, 70, 220)
    }
    const range = (p: { x: number; z: number }) => Math.hypot(
      p.x - shooter.x, p.z - shooter.z, (heightAt(p.x, p.z) + 1.6) - (heightAt(shooter.x, shooter.z) + 1.6),
    )

    // Rust+ team polls every 15 s while the victim moves, then the death.
    for (let s = 0; s < 90; s += 15) {
      const ts = D - (90 - s) * 1000
      syncTeam(db, SERVER, wipeId, teamInfo(team.map((id) => id === victim
        ? member(id, at(s)) : member(id, around(home, 60)))), { worldSize, at: new Date(ts).toISOString() })
    }
    const r = syncTeam(db, SERVER, wipeId, teamInfo(team.map((id) => id === victim
      ? member(id, deathPos, false) : member(id, around(home, 60)))), { worldSize, at: new Date(D).toISOString() })
    for (const d of r.deaths) recordTeammateDeath(db, SERVER, wipeId, d, new Date(D).toISOString())

    // The combat log, as the victim's agent would send it moments later. A
    // client's log only has hits it dealt or took, so everything below is
    // kept consistent the way the game's own HP bookkeeping would be.
    const tK = 40_000 + di * 3_000
    const lines = ['time attacker id target id weapon ammo area distance old_hp new_hp info']
    const hp = new Map<string, number>([[victim, 100], [killer, 100]])
    const hit = (t: number, att: string, tgt: string, weapon: string, ammo: string, area: string, dist: number, dmg: number, unseenBefore = 0) => {
      const before = hp.get(tgt)! - unseenBefore
      const after = Math.max(0, before - dmg)
      lines.push(line(t, att, tgt, weapon, ammo, area, dist, before, after))
      hp.set(tgt, after)
    }
    hit(tK - 27, victim, killer, 'rifle.ak', 'ammo.rifle', 'chest', range(at(63)), 28)
    hit(tK - 25, killer, victim, 'rifle.bolt', 'ammo.rifle.hv', 'chest', range(at(65)), 34)
    if (di === 1) {
      // Ambush: a third party puts 40 into the killer where this log can't
      // see it — the victim's next hit finds him 40 HP lower than it should.
      hit(tK - 15, victim, killer, 'rifle.ak', 'ammo.rifle', 'chest', range(at(75)), 22, 40)
    }
    hit(tK - 12, killer, victim, 'rifle.bolt', 'ammo.rifle.hv', 'chest', range(at(78)), 30)
    if (di === 1) {
      // ...and opens up on the victim too, 19 s after the killer did.
      hit(tK - 6, thirdParty, victim, 'rifle.lr300', 'ammo.rifle', 'arm', 94, 16)
    }
    hit(tK, killer, victim, 'rifle.bolt', 'ammo.rifle.hv', 'head', range(at(90)), 100)
    ingestCombatLog(db, lines.join('\n'), {
      serverId: SERVER, wipeId, reporterId: victim, teamIds: team, at: new Date(D + 20_000).toISOString(),
    })
    // Respawn at home.
    syncTeam(db, SERVER, wipeId, teamInfo(team.map((id) => member(id, around(home, 60)))),
      { worldSize, at: new Date(D + 60_000).toISOString() })
    truth.deaths.push({ encounterAt: new Date(D).toISOString(), victim, killer, shooter: toNorm(shooter) })
  })

  // A fight we won.
  const W = start + 0.78 * (now - start)
  ingestCombatLog(db, [
    line(52_000, self, enemies[2], 'rifle.ak', 'ammo.rifle', 'head', 41, 100, 62),
    line(52_001.2, enemies[2], self, 'smg.mp5', 'ammo.pistol', 'chest', 41, 100, 83),
    line(52_002.1, team[1], enemies[2], 'rifle.ak', 'ammo.rifle', 'chest', 55, 62, 0),
  ].join('\n'), { serverId: SERVER, wipeId, reporterId: self, teamIds: team, at: new Date(W).toISOString() })

  // --- the team right now, and a map note someone dropped ----------------------
  const nowIsoStr = new Date(now).toISOString()
  syncTeam(db, SERVER, wipeId, teamInfo(
    team.map((id, i) => member(id, around(home, 80), true, i !== 2)),
    [{ type: 0, x: toRp(enemyHome).x, y: toRp(enemyHome).y, icon: 0, colourIndex: 0, label: 'big stone base?' } satisfies MapNote],
  ), { worldSize, at: nowIsoStr })
  setServerState(db, SERVER, 'rustplus_team', { members: team.length }, nowIsoStr)

  // --- events: marker polls over the last hour ---------------------------------
  const cargo = (s: number): AppMarker => ({ id: 1, type: MARKER_TYPE.CargoShip, x: 200 + s * 3, y: worldSize - 150, steamId: '0', rotation: 0, radius: 0, name: '', outOfStock: false })
  const heli: AppMarker = { id: 2, type: MARKER_TYPE.PatrolHelicopter, ...toRp(pick(undefined, 0, half * 0.5)), steamId: '0', rotation: 0, radius: 0, name: '', outOfStock: false }
  const wreck: AppMarker = { ...heli, id: 3, type: MARKER_TYPE.Explosion }
  const crate: AppMarker = { id: 4, type: MARKER_TYPE.Crate, ...toRp(pick(undefined, 0, half * 0.7)), steamId: '0', rotation: 0, radius: 0, name: '', outOfStock: false }
  const polls: [number, AppMarker[]][] = [
    [now - 55 * MIN, [heli]],
    [now - 48 * MIN, [heli, cargo(0)]],
    [now - 20 * MIN, [heli, cargo(28)]],
    [now - 6 * MIN, [wreck, cargo(42)]],
    [now - 4 * MIN, [wreck, cargo(44), crate]],
    [now - 30_000, [wreck, cargo(48), crate]],
  ]
  for (const [t, markers] of polls) trackMarkers(db, { wipeId, worldSize, markers, at: new Date(t).toISOString() })
  setServerState(db, SERVER, 'rustplus_markers', { count: 3 }, new Date(now - 30_000).toISOString())
  setServerState(db, SERVER, 'time', { dayLengthMinutes: 60, timeScale: 1, sunrise: 7.5, sunset: 19.6, time: 18.9 }, nowIsoStr)
  db.prepare(`UPDATE servers SET rustplus_paired = 1, rustplus_player_id = ? WHERE id = ?`).run(self, SERVER)

  // --- teams, then bases that reference them -------------------------------------
  buildSessionEvidence(db, SERVER, { at: nowIsoStr })
  rebuildClans(db, SERVER)
  const enemyClan = (db.prepare(
    `SELECT clan_id FROM clan_members WHERE steam_id = ? LIMIT 1`,
  ).get(enemies[0]) as { clan_id: string } | undefined)?.clan_id ?? null

  createBase(db, SERVER, { ...toNorm(home), ours: true, tier: 'stone', turrets: 2, note: 'our base', reportedBy: self }, nowIsoStr)
  createBase(db, SERVER, {
    ...toNorm(enemyHome), status: 'confirmed', tier: 'stone', turrets: 3, ownerClanId: enemyClan,
    ownerSteamId: enemies[0], raidPath: { walls: { stone: 2 }, doors: { sheet: 1, garage: 1 } },
    note: 'loot room north side, 2 turrets on roof', reportedBy: team[1],
  }, nowIsoStr)

  setServerState(db, SERVER, 'simulated', {
    seed: opts.seed ?? 7, createdAt: nowIso(), truth,
    note: 'Synthetic server for testing. Nothing here is real intel.',
  }, nowIsoStr)
  return truth
}

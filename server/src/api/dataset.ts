// ---------------------------------------------------------------------------
// One server's full dataset, in the shape the web app renders.
//
// Everything here is computed from rows the collectors wrote: Battlemetrics
// sessions, Rust+ team and marker polls, agent combat logs, and bases the team
// marked. Where a field has no source yet it is empty or null, never filled —
// the pages have empty states, and an empty state is true.
//
// Queries are batched per table rather than per player: a busy server sees
// well over a thousand players in a wipe, and N+1 queries here would make the
// dashboard the slowest thing on the box.
// ---------------------------------------------------------------------------

import type { DB } from '../db/index.ts'
import { currentWipe } from '../retention.ts'
import { lastPoll, POLL_GAP_MS } from '../collectors/battlemetrics.ts'
import { loadLinks } from '../pairs.ts'
import { scoreThreats, serverHeat, type ThreatInput } from '../threat.ts'
import { serverRecord } from './mapInfo.ts'
import { listDevices, upkeepSummary } from '../rustplus/entities.ts'
import { recentTeamChat } from '../rustplus/sync.ts'
import { itemName } from '../rustplus/items.ts'
import { normToGrid } from '../../../shared/world.ts'
import { calibrate, pairConfidence } from '../../../shared/inference/clanEvidence.ts'
import type {
  BaseRecord, BodyArea, Clan, CombatEvent, DeathRecord, Encounter, GameEvent,
  NameRecord, PairLink, Player, RangeFix, ServerDataset, SteamId, TeamMember, Vec2,
} from '../../../shared/types.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

export interface DatasetOptions {
  /** NABRUST_TEAM — merged with everyone Rust+ reports as a teammate. */
  teamIds?: string[]
  now?: number
  /** Pair links below this calibrated confidence aren't sent to the browser. */
  minLinkConfidence?: number
}

type Span = [number, number]

/** "6d ago", "3h ago", "just now". */
export function ago(iso: string | null, now: number): string {
  if (!iso) return 'unknown'
  const d = now - Date.parse(iso)
  if (!Number.isFinite(d) || d < 0) return 'just now'
  if (d < 60_000) return 'just now'
  if (d < HOUR) return `${Math.floor(d / 60_000)}m ago`
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`
  return `${Math.floor(d / DAY)}d ago`
}

function overlapMs(spans: Span[], from: number, to: number): number {
  let t = 0
  for (const [a, b] of spans) t += Math.max(0, Math.min(b, to) - Math.max(a, from))
  return t
}

/**
 * 7 weekdays (Mon..Sun) x 4 six-hour blocks, UTC, over the last 28 days.
 * Each cell is the share of that block the player was on, quantised to 0..3.
 */
export function activityGrid(spans: Span[], now: number): number[][] {
  const from = now - 28 * DAY
  const mins = Array.from({ length: 7 }, () => [0, 0, 0, 0])
  const BLOCK = 6 * HOUR
  for (const [a0, b0] of spans) {
    let a = Math.max(a0, from)
    const b = Math.min(b0, now)
    while (a < b) {
      const blockStart = Math.floor(a / BLOCK) * BLOCK
      const end = Math.min(b, blockStart + BLOCK)
      const d = new Date(blockStart)
      const day = (d.getUTCDay() + 6) % 7
      const block = Math.floor(d.getUTCHours() / 6)
      mins[day][block] += (end - a) / 60_000
      a = end
    }
  }
  const possible = 4 * 6 * 60 // four weeks of one 6h block, in minutes
  return mins.map((row) => row.map((m) => {
    const f = m / possible
    return f < 0.02 ? 0 : f < 0.1 ? 1 : f < 0.3 ? 2 : 3
  }))
}

/** Longest run of hours (UTC, wrapping midnight) at ≥ half the peak. */
export function activityWindow(spans: Span[], now: number): string {
  const from = now - 7 * DAY
  const hist = new Array(24).fill(0)
  for (const [a0, b0] of spans) {
    let a = Math.max(a0, from)
    const b = Math.min(b0, now)
    while (a < b) {
      const hourStart = Math.floor(a / HOUR) * HOUR
      const end = Math.min(b, hourStart + HOUR)
      hist[new Date(hourStart).getUTCHours()] += end - a
      a = end
    }
  }
  const peak = Math.max(...hist)
  if (peak <= 0) return 'unknown'
  const hot = hist.map((v) => v >= peak / 2)
  if (hot.every(Boolean)) return 'around the clock'
  // Start just after a cold hour so a run crossing midnight stays whole.
  const start0 = hot.findIndex((h, i) => h && !hot[(i + 23) % 24])
  let best = { start: start0, len: 0 }
  for (let s = 0; s < 24; s++) {
    if (!hot[s] || hot[(s + 23) % 24]) continue
    let len = 0
    while (len < 24 && hot[(s + len) % 24]) len++
    if (len > best.len) best = { start: s, len }
  }
  const pad = (h: number) => String(h % 24).padStart(2, '0')
  return `${pad(best.start)}:00–${pad(best.start + best.len)}:00 UTC`
}

/** Most members online at once, over the last 7 days. */
export function peakConcurrent(memberSpans: Span[][], now: number): number {
  const from = now - 7 * DAY
  const edges: [number, number][] = []
  for (const spans of memberSpans) {
    // Collapse each member's own overlapping sessions so one person counts once.
    const merged: Span[] = []
    for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
      const lo = Math.max(a, from)
      const hi = Math.min(b, now)
      if (hi <= lo) continue
      const last = merged[merged.length - 1]
      if (last && lo <= last[1]) last[1] = Math.max(last[1], hi)
      else merged.push([lo, hi])
    }
    for (const [a, b] of merged) edges.push([a, 1], [b, -1])
  }
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  let cur = 0
  let peak = 0
  for (const [, d] of edges) { cur += d; peak = Math.max(peak, cur) }
  return peak
}

function wipeStartOf(lastSeedChange: string | null, wipeStarted: string | undefined, now: number): number {
  const starts = [lastSeedChange, wipeStarted]
    .filter((s): s is string => !!s)
    .map((s) => Date.parse(s))
    .filter((t) => Number.isFinite(t) && t <= now)
  return starts.length ? Math.min(...starts) : now - 30 * DAY
}

const AREAS: ReadonlySet<string> = new Set(['head', 'chest', 'stomach', 'arm', 'leg'])

function asArea(a: string | null): BodyArea {
  if (a && AREAS.has(a)) return a as BodyArea
  if (a && /hand|arm/.test(a)) return 'arm'
  if (a && /foot|leg/.test(a)) return 'leg'
  return 'chest'
}

interface CombatRow {
  encounter_id: string
  t_server: number
  attacker_id: string | null
  target_id: string
  weapon: string | null
  ammo: string | null
  area: string | null
  distance: number | null
  damage: number
  hp_before: number | null
  hp_after: number | null
  third_party: number
}

function toEvent(r: CombatRow): CombatEvent {
  return {
    t: r.t_server,
    attacker: r.attacker_id ?? 'environment',
    target: r.target_id,
    weapon: r.weapon ?? 'unknown',
    ammo: r.ammo,
    area: asArea(r.area),
    distance: r.distance ?? 0,
    damage: r.damage,
    hpBefore: r.hp_before ?? 0,
    hpAfter: r.hp_after ?? 0,
    ...(r.third_party ? { thirdPartyFlag: true } : {}),
  }
}

/**
 * Where the victim was at wall-clock `t`, from Rust+ position samples.
 * Returns the interpolated position and a rough error: Rust+ polls every
 * ~15 s and a sprinting player covers ~5.5 m/s, so the error grows with the
 * distance to the nearest sample.
 */
function positionAt(
  samples: { t: number; x: number; y: number }[], t: number, worldSize: number,
): { pos: Vec2; errorM: number } | null {
  if (!samples.length) return null
  let before: typeof samples[number] | null = null
  let after: typeof samples[number] | null = null
  for (const s of samples) {
    if (s.t <= t) before = s
    else { after = s; break }
  }
  const LIMIT = 20_000
  if (before && after && after.t - before.t <= 2 * LIMIT) {
    const f = (t - before.t) / Math.max(1, after.t - before.t)
    const pos = { x: before.x + (after.x - before.x) * f, y: before.y + (after.y - before.y) * f }
    const half = Math.min(t - before.t, after.t - t) / 1000
    return { pos, errorM: Math.min(60, 2 + 5.5 * half) }
  }
  const near = [before, after].filter((s): s is NonNullable<typeof s> => !!s)
    .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0]
  if (!near || Math.abs(near.t - t) > LIMIT) return null
  void worldSize
  return { pos: { x: near.x, y: near.y }, errorM: Math.min(60, 2 + 5.5 * Math.abs(near.t - t) / 1000) }
}

export function datasetFor(db: DB, serverId: string, opts: DatasetOptions = {}): ServerDataset | null {
  const now = opts.now ?? Date.now()
  const record = serverRecord(db, serverId, now)
  if (!record) return null

  const srv = db.prepare(
    `SELECT rustplus_player_id, last_seed_change FROM servers WHERE id = ?`,
  ).get(serverId) as { rustplus_player_id: string | null; last_seed_change: string | null }
  const wipe = currentWipe(db, serverId)
  const wipeStart = wipeStartOf(srv.last_seed_change, wipe?.startedAt, now)
  const worldSize = record.worldSize || 4250

  // --- team -----------------------------------------------------------------
  const teamRows = db.prepare(
    `SELECT steam_id, name, x, y, alive, online FROM team_state WHERE server_id = ? ORDER BY name`,
  ).all(serverId) as { steam_id: string; name: string | null; x: number | null; y: number | null; alive: number; online: number }[]
  const teamIds = [...new Set([
    ...(opts.teamIds ?? []),
    ...teamRows.map((r) => r.steam_id),
    ...(srv.rustplus_player_id ? [srv.rustplus_player_id] : []),
  ])]
  const isTeam = new Set(teamIds)
  const self = srv.rustplus_player_id ?? opts.teamIds?.[0] ?? null

  const team: TeamMember[] = teamRows.map((r) => {
    const pos = r.x !== null && r.y !== null ? { x: r.x, y: r.y } : null
    return {
      steamId: r.steam_id,
      name: r.name ?? `…${r.steam_id.slice(-5)}`,
      grid: pos ? normToGrid(pos, worldSize) : '—',
      pos,
      alive: r.alive === 1,
      online: r.online === 1,
    }
  })

  // --- sessions -------------------------------------------------------------
  // An open session is only "still online" while the collector is polling. If
  // it has gone quiet, open sessions end at the last poll we actually made.
  const poll = lastPoll(db, serverId)
  const collectorFresh = !!poll && now - Date.parse(poll.at) <= POLL_GAP_MS
  const openEnd = collectorFresh ? now : poll ? Date.parse(poll.at) : now
  const since = Math.min(wipeStart, now - 28 * DAY)

  const spansBy = new Map<string, Span[]>()
  const onlineNow = new Set<string>()
  for (const r of db.prepare(
    `SELECT steam_id, joined_at, left_at FROM sessions
      WHERE server_id = ? AND (left_at IS NULL OR left_at >= ?)`,
  ).all(serverId, new Date(since).toISOString()) as { steam_id: string; joined_at: string; left_at: string | null }[]) {
    const a = Date.parse(r.joined_at)
    const b = r.left_at ? Date.parse(r.left_at) : openEnd
    if (!(b > a)) continue
    let list = spansBy.get(r.steam_id)
    if (!list) spansBy.set(r.steam_id, list = [])
    list.push([a, b])
    if (!r.left_at && collectorFresh) onlineNow.add(r.steam_id)
  }

  // --- combat this wipe -----------------------------------------------------
  const combat = wipe
    ? db.prepare(
      `SELECT c.encounter_id, c.t_server, c.attacker_id, c.target_id, c.weapon, c.ammo, c.area,
              c.distance, c.damage, c.hp_before, c.hp_after, c.third_party
         FROM combat_events c JOIN encounters e ON e.id = c.encounter_id
        WHERE e.server_id = ? AND e.wipe_id = ?
        ORDER BY c.encounter_id, c.t_server`,
    ).all(serverId, wipe.id) as unknown as CombatRow[]
    : []

  const harm = new Map<string, { dmg: number; kills: number }>()
  for (const r of combat) {
    if (!r.attacker_id || !isTeam.has(r.target_id) || isTeam.has(r.attacker_id)) continue
    const h = harm.get(r.attacker_id) ?? { dmg: 0, kills: 0 }
    h.dmg += r.damage
    if ((r.hp_after ?? 1) <= 0) h.kills++
    harm.set(r.attacker_id, h)
  }

  // --- per-opponent combat record ---------------------------------------------
  const encStart = new Map<string, string>()
  if (wipe) {
    for (const r of db.prepare(`SELECT id, started_at FROM encounters WHERE server_id = ? AND wipe_id = ?`)
      .all(serverId, wipe.id) as { id: string; started_at: string }[]) encStart.set(r.id, r.started_at)
  }
  const vsUs = new Map<string, {
    enc: Set<string>; kills: number; deaths: number; hits: number; heads: number; rangeSum: number; rangeN: number
    weapons: Map<string, number>; last: string | null
  }>()
  const rec = (id: string) => {
    let v = vsUs.get(id)
    if (!v) vsUs.set(id, (v = { enc: new Set(), kills: 0, deaths: 0, hits: 0, heads: 0, rangeSum: 0, rangeN: 0, weapons: new Map(), last: null }))
    return v
  }
  for (const r of combat) {
    const theirHit = r.attacker_id && !isTeam.has(r.attacker_id) && isTeam.has(r.target_id)
    const ourHit = r.attacker_id && isTeam.has(r.attacker_id) && !isTeam.has(r.target_id)
    const opp = theirHit ? r.attacker_id! : ourHit ? r.target_id : null
    if (!opp) continue
    const v = rec(opp)
    v.enc.add(r.encounter_id)
    const started = encStart.get(r.encounter_id) ?? null
    if (started && (!v.last || started > v.last)) v.last = started
    if (theirHit) {
      v.hits++
      if (asArea(r.area) === 'head') v.heads++
      if (r.distance) { v.rangeSum += r.distance; v.rangeN++ }
      if (r.weapon) v.weapons.set(r.weapon, (v.weapons.get(r.weapon) ?? 0) + 1)
      if ((r.hp_after ?? 1) <= 0) v.kills++
    } else if ((r.hp_after ?? 1) <= 0) {
      v.deaths++
    }
  }

  // --- clans ------------------------------------------------------------------
  const clanRows = db.prepare(
    `SELECT c.id, c.label, cm.steam_id, cm.confidence, cm.core
       FROM clans c JOIN clan_members cm ON cm.clan_id = c.id
      WHERE c.server_id = ? ORDER BY c.id`,
  ).all(serverId) as { id: string; label: string; steam_id: string; confidence: number; core: number }[]
  const clanMembers = new Map<string, { label: string; members: { steamId: string; confidence: number; core: boolean }[] }>()
  for (const r of clanRows) {
    if (isTeam.has(r.steam_id)) continue
    let c = clanMembers.get(r.id)
    if (!c) clanMembers.set(r.id, c = { label: r.label, members: [] })
    c.members.push({ steamId: r.steam_id, confidence: r.confidence, core: r.core === 1 })
  }
  const groupSizeOf = new Map<string, number>()
  for (const c of clanMembers.values()) for (const m of c.members) groupSizeOf.set(m.steamId, c.members.length)

  // --- population -------------------------------------------------------------
  const population = new Set<string>()
  for (const [id, spans] of spansBy) if (overlapMs(spans, wipeStart, now) > 0) population.add(id)
  for (const r of combat) {
    if (r.attacker_id) population.add(r.attacker_id)
    population.add(r.target_id)
  }
  for (const c of clanMembers.values()) for (const m of c.members) population.add(m.steamId)
  for (const id of teamIds) population.add(id)
  const ids = [...population]
  const idsJson = JSON.stringify(ids)

  const profile = new Map<string, { first_seen: string; hours_played: number | null; account_created_at: string | null; vac_bans: number; game_bans: number }>()
  for (const r of db.prepare(
    `SELECT steam_id, first_seen, hours_played, account_created_at, vac_bans, game_bans
       FROM players WHERE steam_id IN (SELECT value FROM json_each(?))`,
  ).all(idsJson) as { steam_id: string; first_seen: string; hours_played: number | null; account_created_at: string | null; vac_bans: number; game_bans: number }[]) {
    profile.set(r.steam_id, r)
  }

  const namesBy = new Map<string, NameRecord[]>()
  for (const r of db.prepare(
    `SELECT steam_id, name, first_seen, last_seen, source FROM player_names
      WHERE steam_id IN (SELECT value FROM json_each(?)) ORDER BY first_seen DESC`,
  ).all(idsJson) as { steam_id: string; name: string; first_seen: string; last_seen: string | null; source: string }[]) {
    let list = namesBy.get(r.steam_id)
    if (!list) namesBy.set(r.steam_id, list = [])
    list.push({
      name: r.name, firstSeen: r.first_seen, lastSeen: r.last_seen,
      source: r.source as NameRecord['source'],
    })
  }

  // --- threat ---------------------------------------------------------------
  const inputs: ThreatInput[] = ids.filter((id) => !isTeam.has(id)).map((id) => ({
    steamId: id,
    hoursThisWipe: overlapMs(spansBy.get(id) ?? [], wipeStart, now) / HOUR,
    rustHours: profile.get(id)?.hours_played ?? null,
    groupSize: groupSizeOf.get(id) ?? 1,
    damageToUs: harm.get(id)?.dmg ?? 0,
    killsOnUs: harm.get(id)?.kills ?? 0,
  }))
  const threat = new Map(scoreThreats(inputs).map((t) => [t.steamId, t]))

  const players: Record<SteamId, Player> = {}
  for (const id of ids) {
    const p = profile.get(id)
    const spans = spansBy.get(id) ?? []
    const t = threat.get(id)
    const created = p?.account_created_at ? Date.parse(p.account_created_at) : NaN
    players[id] = {
      steamId: id,
      names: namesBy.get(id) ?? [],
      hoursPlayed: p?.hours_played ?? null,
      accountAgeYears: Number.isFinite(created) ? Math.round(((now - created) / (365.25 * DAY)) * 10) / 10 : null,
      vacBans: p?.vac_bans ?? 0,
      gameBans: p?.game_bans ?? 0,
      firstSeen: p?.first_seen ?? new Date(now).toISOString(),
      threatPercentile: isTeam.has(id) ? 0 : t?.percentile ?? 0,
      serverHoursThisWipe: Math.round((overlapMs(spans, wipeStart, now) / HOUR) * 10) / 10,
      online: onlineNow.has(id) || team.some((m) => m.steamId === id && m.online),
      activity: activityGrid(spans, now),
      // Inferring a timezone from play hours is guesswork dressed as data.
      inferredTimezone: null,
      threatFactors: isTeam.has(id) ? [{ label: 'teammate', value: 'not scored' }] : t?.factors,
      vsUs: (() => {
        const v = vsUs.get(id)
        if (!v) return null
        return {
          encounters: v.enc.size,
          killsOnUs: v.kills,
          deathsToUs: v.deaths,
          hitsOnUs: v.hits,
          headshotRate: v.hits ? v.heads / v.hits : 0,
          avgRangeMetres: v.rangeN ? Math.round(v.rangeSum / v.rangeN) : 0,
          weapons: [...v.weapons].map(([weapon, hits]) => ({ weapon, hits })).sort((a, b) => b.hits - a.hits),
          lastSeen: v.last,
        }
      })(),
    }
  }

  const clans: Clan[] = [...clanMembers.entries()].map(([id, c]) => {
    const memberSpans = c.members.map((m) => spansBy.get(m.steamId) ?? [])
    const best = Math.max(0, ...c.members.map((m) => players[m.steamId]?.threatPercentile ?? 0))
    return {
      id,
      label: c.label,
      members: c.members,
      // A group is at least as dangerous as its best member, more so with numbers.
      threat: Math.min(100, Math.round(best * (1 + 0.05 * (c.members.length - 1)))),
      activityWindow: activityWindow(memberSpans.flat(), now),
      peakConcurrent: peakConcurrent(memberSpans, now),
    }
  }).sort((a, b) => b.threat - a.threat)

  // --- pair links -------------------------------------------------------------
  // Session overlap alone produces thousands of weak pairs on a busy server.
  // Only links that mean something go to the browser.
  const minConf = opts.minLinkConfidence ?? 0.25
  const pairLinks: PairLink[] = loadLinks(db, serverId)
    .filter((l) => !isTeam.has(l.a) && !isTeam.has(l.b))
    .filter((l) => calibrate(pairConfidence(l)) >= minConf)

  // --- bases -------------------------------------------------------------------
  const bases: BaseRecord[] = wipe
    ? (db.prepare(
      `SELECT b.*, c.label AS clan_label FROM bases b
         LEFT JOIN clans c ON c.id = b.owner_clan_id
        WHERE b.wipe_id = ? ORDER BY b.last_evidence_at DESC`,
    ).all(wipe.id) as Record<string, unknown>[]).map((r) => {
      const owner = r.owner_steam_id as string | null
      let raidPath: BaseRecord['raidPath'] = null
      try { raidPath = r.raid_path ? JSON.parse(String(r.raid_path)) : null } catch { raidPath = null }
      const observations = (db.prepare(`SELECT COUNT(*) AS n FROM base_observations WHERE base_id = ?`)
        .get(r.id as string) as { n: number }).n
      return {
        id: r.id as string,
        owner: owner ? namesBy.get(owner)?.find((n) => n.lastSeen === null)?.name ?? owner : null,
        ownerSteamId: owner,
        ownerClan: (r.clan_label as string | null) ?? null,
        ownerClanId: (r.owner_clan_id as string | null) ?? null,
        grid: (r.grid as string | null) ?? normToGrid({ x: r.x as number, y: r.y as number }, worldSize),
        pos: { x: r.x as number, y: r.y as number },
        status: r.status as BaseRecord['status'],
        layoutConfidence: r.layout_confidence as number,
        turrets: r.turrets as number,
        tier: ((r.tier as string | null) ?? 'unknown') as BaseRecord['tier'],
        lastEvidence: ago(r.last_evidence_at as string, now),
        ...(r.reported_by ? { reportedBy: r.reported_by as string } : {}),
        ours: r.ours === 1,
        raidPath,
        note: (r.note as string | null) ?? null,
        observations,
      }
    })
    : []
  const home = bases.find((b) => b.ours)

  // --- events ------------------------------------------------------------------
  const liveEvents: GameEvent[] = wipe
    ? (db.prepare(
      `SELECT kind, observed_at, eta_at, confidence, source, label, end_label, x, y, ended_at
         FROM game_events
        WHERE wipe_id = ? AND (ended_at IS NULL OR ended_at >= ?)
        ORDER BY (ended_at IS NULL) DESC, observed_at DESC LIMIT 12`,
    ).all(wipe.id, new Date(now - 10 * 60_000).toISOString()) as {
      kind: GameEvent['kind']; observed_at: string; eta_at: string | null; confidence: number
      source: GameEvent['source']; label: string | null; end_label: string | null
      x: number | null; y: number | null; ended_at: string | null
    }[]).map((e) => ({
      kind: e.kind,
      label: (e.ended_at ? e.end_label : e.label) ?? e.label ?? e.kind,
      etaSeconds: e.eta_at && !e.ended_at ? Math.max(0, Math.round((Date.parse(e.eta_at) - now) / 1000)) : 0,
      confidence: e.confidence,
      source: e.source,
      sinceSeconds: Math.max(0, Math.round((now - Date.parse(e.observed_at)) / 1000)),
      ended: !!e.ended_at,
      ...(e.x !== null && e.y !== null ? { pos: { x: e.x, y: e.y } } : {}),
    }))
    : []

  // --- encounters and deaths -------------------------------------------------
  const byEncounter = new Map<string, CombatRow[]>()
  for (const r of combat) {
    let list = byEncounter.get(r.encounter_id)
    if (!list) byEncounter.set(r.encounter_id, list = [])
    list.push(r)
  }
  const encounterRows = wipe
    ? db.prepare(
      `SELECT id, started_at, label, outcome, parties_detected, victim_id, death_x, death_y
         FROM encounters WHERE wipe_id = ? ORDER BY started_at DESC LIMIT 60`,
    ).all(wipe.id) as {
      id: string; started_at: string; label: string | null; outcome: Encounter['outcome'] | null
      parties_detected: number; victim_id: string | null; death_x: number | null; death_y: number | null
    }[]
    : []

  const recentEncounters: Encounter[] = encounterRows
    .filter((e) => byEncounter.has(e.id))
    .slice(0, 20)
    .map((e) => ({
      id: e.id,
      server: serverId,
      wipe: wipe?.id ?? 0,
      label: e.label ?? 'engagement',
      startedAt: e.started_at,
      events: (byEncounter.get(e.id) ?? []).map(toEvent),
      outcome: e.outcome ?? 'disengaged',
      partiesDetected: e.parties_detected,
    }))

  const deaths: DeathRecord[] = []
  for (const e of encounterRows) {
    if (e.outcome !== 'died') continue
    const events = byEncounter.get(e.id) ?? []
    const kill = events.find((r) => isTeam.has(r.target_id) && (r.hp_after ?? 1) <= 0)
    const victim = kill?.target_id ?? e.victim_id
    if (!victim) continue
    const at = Date.parse(e.started_at)
    const killer = kill?.attacker_id ?? null

    const samples = wipe
      ? (db.prepare(
        `SELECT t, x, y FROM position_samples
          WHERE wipe_id = ? AND steam_id = ? AND t BETWEEN ? AND ? ORDER BY t`,
      ).all(wipe.id, victim, new Date(at - 5 * 60_000).toISOString(), new Date(at + 60_000).toISOString()) as
        { t: string; x: number; y: number }[]).map((s) => ({ t: Date.parse(s.t), x: s.x, y: s.y }))
      : []

    const fixes: RangeFix[] = []
    let worstErr = 0
    if (kill && killer) {
      for (const hit of events) {
        if (hit.attacker_id !== killer || hit.target_id !== victim || !hit.distance) continue
        // Log times are server-uptime seconds; anchor them to the kill, whose
        // wall-clock time Rust+ gave us when the death shell opened.
        const wall = at - (kill.t_server - hit.t_server) * 1000
        let where = positionAt(samples, wall, worldSize)
        if (!where && e.death_x !== null && e.death_y !== null && Math.abs(wall - at) < 10_000) {
          where = { pos: { x: e.death_x, y: e.death_y }, errorM: 5 + 5.5 * Math.abs(wall - at) / 1000 }
        }
        if (!where) continue
        worstErr = Math.max(worstErr, where.errorM)
        fixes.push({ from: where.pos, distance: hit.distance, weight: 1, errorMetres: Math.round(where.errorM) })
      }
    }

    const pos = e.death_x !== null && e.death_y !== null
      ? { x: e.death_x, y: e.death_y }
      : positionAt(samples, at, worldSize)?.pos ?? null
    deaths.push({
      id: e.id,
      at: e.started_at,
      victim,
      grid: pos ? normToGrid(pos, worldSize) : null,
      pos,
      killer,
      weapon: kill?.weapon ?? null,
      distance: kill?.distance ?? null,
      headshot: kill?.area === 'head',
      fixes,
      positionErrorMetres: fixes.length ? Math.round(worstErr) : null,
    })
  }

  // --- clock ----------------------------------------------------------------
  const timeRow = db.prepare(`SELECT value, updated_at FROM server_state WHERE server_id = ? AND key = 'time'`)
    .get(serverId) as { value: string; updated_at: string } | undefined
  let gameTime: ServerDataset['gameTime'] = null
  if (timeRow) {
    try {
      const t = JSON.parse(timeRow.value) as { time: number; sunrise: number; sunset: number }
      gameTime = { time: t.time, sunrise: t.sunrise, sunset: t.sunset, observedAt: timeRow.updated_at }
    } catch { gameTime = null }
  }

  // Heat needs Steam hours; until enough profiles are known it stays unknown.
  record.heat = serverHeat(ids.filter((id) => !isTeam.has(id) && onlineNow.has(id))
    .map((id) => profile.get(id)?.hours_played ?? null))

  return {
    server: record,
    players,
    pairLinks,
    clans,
    bases,
    liveEvents,
    team,
    encounter: recentEncounters[0] ?? null,
    recentEncounters,
    homePos: home?.pos ?? null,
    // The raid planner costs a route in the browser from the base's raid path;
    // there is no layout corpus behind these yet.
    raidRoutes: [],
    candidateLayouts: [],
    self,
    teamIds,
    deaths,
    gameTime,
    teamChat: recentTeamChat(db, wipe?.id ?? null, 40),
    devices: listDevices(db, serverId, wipe?.id ?? null).map((d) => ({
      entityId: d.entityId,
      kind: d.kind,
      name: d.name,
      value: d.value,
      contents: d.items
        .slice()
        .sort((a, b) => b.quantity - a.quantity)
        .map((i) => ({ name: itemName(i.itemId), quantity: i.quantity })),
      capacity: d.capacity,
      upkeep: upkeepSummary(d),
      protectionExpiry: d.protectionExpiry,
      lastSeen: d.lastSeen,
    })),
  }
}

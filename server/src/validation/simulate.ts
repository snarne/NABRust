// ---------------------------------------------------------------------------
// Validation harness for teammate detection.
//
// We can't check rosters against a real server — nobody hands out the team
// list. So we build a server where we DO know the teams, observe it exactly
// the way the collector does (one Battlemetrics poll a minute, starting
// mid-evening with people already online, the odd poll where someone
// flickers offline), and measure how well each model recovers the truth.
//
// The behaviour model is deliberately unkind to the detector: teammates don't
// always log in together, often trickle in late, usually leave one at a time,
// and every one of them also plays solo sessions. If a model does well here it
// is because the signal survives noise, not because the simulation is tidy.
//
// This is a model of player behaviour, not a recording of it — treat the
// numbers as "the method works and here is how it scales with data", not as a
// guarantee for any particular server.
// ---------------------------------------------------------------------------

import type { SessionSpan } from '../../../shared/inference/sessionEvidence.ts'
import {
  coMovementStats, pairPriorLogOdds, sessionEvidenceFrom,
} from '../../../shared/inference/sessionEvidence.ts'
import {
  clusterPairs, logOddsToProb, PRIOR_LOG_ODDS, sessionOverlapEvidence,
} from '../../../shared/inference/clanEvidence.ts'
import type { PairLink } from '../../../shared/types.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Small, fast, seedable PRNG so every run is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SimConfig {
  seed?: number
  /** Approximate player count. */
  players?: number
  /** How long the collector watches, hours. */
  hours?: number
  teamLimit?: number
  /** Share of groups at each size 1..teamLimit. */
  teamMix?: number[]
  pollMs?: number
  /** Chance a teammate joins a group session at the same moment as the group. */
  joinTogether?: number
  /** Chance they leave with the group rather than on their own. */
  leaveTogether?: number
  /** Per-poll chance Battlemetrics briefly loses an online player. */
  flicker?: number
  /**
   * Daily server restart at this UTC hour: everyone online is kicked, and
   * most reconnect over the next few minutes. Real servers do this; it is the
   * single biggest source of false "left together / joined together" events.
   * null disables.
   */
  restartHourUtc?: number | null
}

export interface SimServer {
  spans: SessionSpan[]
  teams: string[][]
  coverageMs: number
  population: number
  teamLimit: number
}

interface Interval { a: number; b: number }

export function simulateServer(cfg: SimConfig = {}): SimServer {
  const rnd = mulberry32(cfg.seed ?? 1)
  const players = cfg.players ?? 300
  const hours = cfg.hours ?? 72
  const teamLimit = cfg.teamLimit ?? 3
  const mix = cfg.teamMix ?? [0.3, 0.3, 0.4]
  const poll = cfg.pollMs ?? MIN
  const joinTogether = cfg.joinTogether ?? 0.65
  const leaveTogether = cfg.leaveTogether ?? 0.45
  const flicker = cfg.flicker ?? 0.0005

  const gauss = () => {
    let u = 0, v = 0
    while (u === 0) u = rnd()
    while (v === 0) v = rnd()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const poisson = (l: number) => {
    const L = Math.exp(-l)
    let k = 0, p = 1
    do { k++; p *= rnd() } while (p > L)
    return k - 1
  }
  const pickSize = () => {
    let r = rnd() * mix.reduce((s, x) => s + x, 0)
    for (let i = 0; i < mix.length; i++) { r -= mix[i]; if (r <= 0) return i + 1 }
    return mix.length
  }

  // Watch window starts 20:00 on day 0, so the first poll already sees a busy
  // server — exactly the start-up situation that fooled the old model.
  const t0 = 20 * HOUR
  const tEnd = t0 + hours * HOUR
  // Simulate from a day earlier so sessions are in progress at start-up.
  const simStart = t0 - DAY

  const teams: string[][] = []
  let id = 0
  while (id < players) {
    const size = Math.min(pickSize(), teamLimit, players - id)
    const team: string[] = []
    for (let i = 0; i < size; i++) team.push(`p${String(id++).padStart(4, '0')}`)
    teams.push(team)
  }

  const truth = new Map<string, Interval[]>()
  const add = (p: string, a: number, b: number) => {
    if (b <= a) return
    const arr = truth.get(p) ?? []
    arr.push({ a, b })
    truth.set(p, arr)
  }

  // Evening-weighted start time within a day, with a per-group timezone skew.
  const startTime = (dayStart: number, skewH: number) => {
    const h = rnd() < 0.7 ? 17 + gauss() * 2.5 : rnd() * 24
    return dayStart + ((((h + skewH) % 24) + 24) % 24) * HOUR
  }
  const sessionLen = () => Math.min(12 * HOUR, Math.max(15 * MIN, Math.exp(Math.log(2.5 * HOUR) + gauss() * 0.7)))

  for (const team of teams) {
    const skew = gauss() * 2
    const days = Math.ceil((tEnd - simStart) / DAY) + 1
    for (let d = 0; d < days; d++) {
      const dayStart = simStart + d * DAY
      // Group sessions (for solos this is just their play)
      const nGroup = poisson(team.length > 1 ? 1.4 : 1.6)
      for (let k = 0; k < nGroup; k++) {
        const gs = startTime(dayStart, skew)
        const ge = gs + sessionLen()
        for (const p of team) {
          if (team.length > 1 && rnd() > 0.85) continue // skipped this one
          const js = team.length > 1 && rnd() < joinTogether
            ? gs + gauss() * 40_000
            : gs + rnd() * 50 * MIN
          const le = team.length > 1 && rnd() < leaveTogether
            ? ge + gauss() * 40_000
            : ge + (rnd() * 90 - 60) * MIN
          add(p, js, le)
        }
      }
      // Solo sessions for team members, independent of the group.
      if (team.length > 1) {
        for (const p of team) {
          const n = poisson(0.35)
          for (let k = 0; k < n; k++) {
            const s = startTime(dayStart, skew + gauss())
            add(p, s, s + sessionLen() * 0.6)
          }
        }
      }
    }
  }

  // Daily restarts: cut every interval spanning the restart, and let 85% of
  // those players reconnect 2-12 minutes later for the rest of their session.
  const restartHour = cfg.restartHourUtc === undefined ? 11 : cfg.restartHourUtc
  if (restartHour !== null) {
    for (let r = simStart - (simStart % DAY) + restartHour * HOUR; r < tEnd; r += DAY) {
      for (const [p, ivs] of truth) {
        const next: Interval[] = []
        for (const iv of ivs) {
          if (iv.a < r && iv.b > r) {
            next.push({ a: iv.a, b: r })
            if (rnd() < 0.85) {
              const back = r + (2 + rnd() * 10) * MIN
              if (back < iv.b) next.push({ a: back, b: iv.b })
            }
          } else next.push(iv)
        }
        truth.set(p, next)
      }
    }
  }

  // Observe the way the collector does: presence at each poll.
  const spans: SessionSpan[] = []
  const ticks: number[] = []
  for (let t = t0; t <= tEnd; t += poll) ticks.push(t)

  for (const [p, ivs] of truth) {
    ivs.sort((x, y) => x.a - y.a)
    const online = (t: number) => ivs.some((iv) => iv.a <= t && t < iv.b)
    let openAt: number | null = null
    let openCensored = false
    for (let i = 0; i < ticks.length; i++) {
      const t = ticks[i]
      const seen = online(t) && !(rnd() < flicker)
      if (seen && openAt === null) {
        openAt = t
        openCensored = i === 0
      } else if (!seen && openAt !== null) {
        spans.push({ player: p, join: openAt, leave: t, joinCensored: openCensored, leaveCensored: false })
        openAt = null
      }
    }
    if (openAt !== null) {
      spans.push({ player: p, join: openAt, leave: tEnd, joinCensored: openCensored, leaveCensored: true })
    }
  }

  return {
    spans,
    teams,
    coverageMs: tEnd - t0,
    population: new Set(spans.map((s) => s.player)).size,
    teamLimit,
  }
}

// --- scoring ---------------------------------------------------------------

export interface ModelReport {
  model: string
  /** Pairs the model calls teammates (posterior >= 0.5). */
  flagged: number
  pairPrecision: number
  pairRecall: number
  /** Co-clustered pairs after roster building, against the true teams. */
  rosterPrecision: number
  rosterRecall: number
  /** True multi-player teams recovered exactly. */
  exactTeams: number
  trueTeams: number
}

const pk = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

function score(model: string, links: PairLink[], prior: number, sim: SimServer, maxTeam: number): ModelReport {
  const truePairs = new Set<string>()
  for (const t of sim.teams) for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) truePairs.add(pk(t[i], t[j]))

  let flagged = 0, tp = 0
  for (const l of links) {
    const p = logOddsToProb(l.evidence.reduce((s, e) => s + e.logOdds, prior))
    if (p >= 0.5) { flagged++; if (truePairs.has(pk(l.a, l.b))) tp++ }
  }

  const groups = clusterPairs(links, { threshold: 0.5, maxTeam, prior })
  let cp = 0, ctp = 0
  const groupSets = new Set<string>()
  for (const g of groups) {
    groupSets.add([...g].sort().join(','))
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      cp++
      if (truePairs.has(pk(g[i], g[j]))) ctp++
    }
  }
  const multi = sim.teams.filter((t) => t.length > 1)
  const exact = multi.filter((t) => groupSets.has([...t].sort().join(','))).length

  return {
    model,
    flagged,
    pairPrecision: flagged ? tp / flagged : 0,
    pairRecall: truePairs.size ? tp / truePairs.size : 0,
    rosterPrecision: cp ? ctp / cp : 0,
    rosterRecall: truePairs.size ? ctp / truePairs.size : 0,
    exactTeams: exact,
    trueTeams: multi.length,
  }
}

/** The model this replaces: overlap over the shorter session, fixed prior, cap 8. */
export function legacyLinks(sim: SimServer, at = '2026-01-01T00:00:00Z'): PairLink[] {
  const by = new Map<string, SessionSpan[]>()
  for (const s of sim.spans) { const a = by.get(s.player) ?? []; a.push(s); by.set(s.player, a) }
  const ids = [...by.keys()].sort()
  const total = (p: string) => by.get(p)!.reduce((t, s) => t + (s.leave - s.join), 0) / MIN
  const links: PairLink[] = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      let ov = 0
      for (const x of by.get(ids[i])!) for (const y of by.get(ids[j])!) {
        const lo = Math.max(x.join, y.join), hi = Math.min(x.leave, y.leave)
        if (hi > lo) ov += hi - lo
      }
      if (ov / MIN < 20) continue // the old builder's minimum
      links.push({ a: ids[i], b: ids[j], evidence: [sessionOverlapEvidence(ov / MIN, total(ids[i]), total(ids[j]), at)] })
    }
  }
  return links
}

export function coMovementLinks(sim: SimServer, at = '2026-01-01T00:00:00Z'): PairLink[] {
  return coMovementStats(sim.spans, { coverageMs: sim.coverageMs })
    .map((s) => ({ a: s.a, b: s.b, evidence: [sessionEvidenceFrom(s, at)] }))
}

export function evaluate(sim: SimServer): { legacy: ModelReport; coMovement: ModelReport } {
  const prior = pairPriorLogOdds(sim.population, sim.teamLimit)
  return {
    legacy: score('legacy overlap', legacyLinks(sim), PRIOR_LOG_ODDS, sim, 8),
    coMovement: score('co-movement', coMovementLinks(sim), prior, sim, sim.teamLimit),
  }
}

/**
 * Reliability table for the co-movement posterior: within each confidence
 * bin, how often the pair really is a team. A calibrated model's rows sit on
 * the diagonal.
 */
export function reliability(sim: SimServer, bins = [0.2, 0.4, 0.6, 0.8, 0.9, 1.0]) {
  const truePairs = new Set<string>()
  for (const t of sim.teams) for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) truePairs.add(pk(t[i], t[j]))
  const prior = pairPriorLogOdds(sim.population, sim.teamLimit)
  const rows = bins.map((hi, i) => ({ lo: i ? bins[i - 1] : 0, hi, n: 0, hits: 0, sumP: 0 }))
  for (const l of coMovementLinks(sim)) {
    const p = logOddsToProb(prior + l.evidence[0].logOdds)
    const r = rows.find((x) => p <= x.hi) ?? rows[rows.length - 1]
    r.n++; r.sumP += p
    if (truePairs.has(pk(l.a, l.b))) r.hits++
  }
  return rows.map((r) => ({
    bin: `${r.lo.toFixed(1)}-${r.hi.toFixed(1)}`,
    pairs: r.n,
    meanPredicted: r.n ? r.sumP / r.n : 0,
    observed: r.n ? r.hits / r.n : 0,
  }))
}

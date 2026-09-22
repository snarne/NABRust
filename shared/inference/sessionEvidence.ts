// ---------------------------------------------------------------------------
// Teammate evidence from server sessions.
//
// What does NOT work: time spent online together. On a busy server, anyone who
// plays evenings overlaps with everyone else who plays evenings. Normalising
// overlap by the shorter session makes it worse — a two-hour session sitting
// inside a twelve-hour one scores 100% — and on a real busy night that
// gave 19,518 of ~53,000 pairs identical "70% teammate" scores.
//
// What does: MOVING together. Teammates join within a minute or two of each
// other and leave together, repeatedly. Strangers do that too, occasionally,
// by chance — so every alignment is scored against how often it would happen
// anyway, given how often the other player joins at all. The result is a
// likelihood ratio, which composes with the combat evidence as ordinary
// log-odds.
//
// Battlemetrics sees the server once a minute, so every time here is already
// quantised to a poll. And the first poll after the collector starts sees
// people who were ALREADY online: those joins are "censored" — we don't know
// when they happened — and are excluded, or everyone online at start-up would
// look like they logged in together.
// ---------------------------------------------------------------------------

import type { PairEvidence } from '../types.ts'

export interface SessionSpan {
  player: string
  /** epoch ms */
  join: number
  /** epoch ms; the collector's last poll for sessions still open */
  leave: number
  /** true when the join was not observed (already online at first poll) */
  joinCensored: boolean
  /** true when the leave was not observed (still online, or collector stopped) */
  leaveCensored: boolean
}

export interface CoMovementOptions {
  /** Two events this close count as together. Two polls either side. */
  windowMs?: number
  /** Chance a teammate joins with you on any given login (fitted by the harness). */
  pTogetherJoin?: number
  /** Chance a teammate leaves with you. Lower: people drop off one at a time. */
  pTogetherLeave?: number
  /** Total time the collector was actually watching, ms. Needed for base rates. */
  coverageMs: number
  /** Clamp on the whole pair's session evidence, both directions. */
  maxAbsLogOdds?: number
  /**
   * A moment where this many players join (or leave) inside one window is a
   * server restart, crash or Battlemetrics outage, not a team moving. Those
   * events are dropped. Default scales with the server's normal event rate.
   */
  massEventThreshold?: number
}

export interface PairSessionStats {
  a: string
  b: string
  joinsAligned: number
  joinOpportunities: number
  leavesAligned: number
  leaveOpportunities: number
  overlapMs: number
  /** overlap divided by what independent players would share by chance */
  overlapLift: number
  logOdds: number
}

const DEFAULTS = {
  windowMs: 150_000,
  pTogetherJoin: 0.55,
  pTogetherLeave: 0.4,
  maxAbsLogOdds: 12,
}

/**
 * Binomial log-likelihood ratio: x successes in n trials under p1 (teammates)
 * versus p0 (chance). Each probability is kept off 0 and 1 so a single
 * observation can't produce infinite evidence.
 */
export function binomialLLR(x: number, n: number, p1: number, p0: number): number {
  if (n <= 0) return 0
  const clamp = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p))
  const a = clamp(p1)
  const b = clamp(p0)
  return x * Math.log(a / b) + (n - x) * Math.log((1 - a) / (1 - b))
}

/**
 * The population-aware prior for "these two are teammates".
 *
 * A fixed 4% is wildly optimistic on a 300-player trio server, where any given
 * player has at most two teammates among 299 others. Assume teams are, on
 * average, 60% full.
 */
export function pairPriorLogOdds(population: number, teamLimit: number): number {
  const others = Math.max(1, population - 1)
  const expected = Math.max(0.05, (Math.max(1, teamLimit) - 1) * 0.6)
  const p = Math.min(0.5, expected / others)
  return Math.log(p / (1 - p))
}

/** For each of `from`'s events, was there an event from `to` within ±w? */
function alignedFlags(from: number[], to: number[], w: number): boolean[] {
  const out: boolean[] = []
  let j = 0
  for (const t of from) {
    while (j < to.length && to[j] < t - w) j++
    out.push(j < to.length && to[j] <= t + w)
  }
  return out
}

/**
 * How much busier than average the server is at each hour of day, measured
 * from the events themselves. A coincidental join at 21:00 is several times
 * likelier than at 05:00, and scoring both the same would flatter evening
 * pairs.
 */
function diurnalFactor(times: number[]): (t: number) => number {
  const counts = new Array(24).fill(1) // +1 smoothing so a quiet hour isn't zero
  for (const t of times) counts[new Date(t).getUTCHours()]++
  const mean = counts.reduce((s, x) => s + x, 0) / 24
  return (t: number) => counts[new Date(t).getUTCHours()] / mean
}

/**
 * Drop events that happen en masse. Returns a predicate: keep this event?
 */
function massFilter(times: number[], w: number, threshold: number): (t: number) => boolean {
  const sorted = [...times].sort((a, b) => a - b)
  const mass = new Set<number>()
  let lo = 0
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] > w) lo++
    if (hi - lo + 1 >= threshold) for (let k = lo; k <= hi; k++) mass.add(sorted[k])
  }
  return (t) => !mass.has(t)
}

function overlapMs(a: SessionSpan[], b: SessionSpan[]): number {
  let total = 0
  for (const x of a) {
    for (const y of b) {
      const lo = Math.max(x.join, y.join)
      const hi = Math.min(x.leave, y.leave)
      if (hi > lo) total += hi - lo
    }
  }
  return total
}

/**
 * Score every pair that moved together at least once.
 *
 * Pairs with no aligned event get no row at all: their evidence is simply the
 * prior. That is what makes this cheap — on a real server a few hundred pairs
 * ever align, out of tens of thousands.
 */
export function coMovementStats(
  spans: SessionSpan[],
  opts: CoMovementOptions,
): PairSessionStats[] {
  const w = opts.windowMs ?? DEFAULTS.windowMs
  const pJ = opts.pTogetherJoin ?? DEFAULTS.pTogetherJoin
  const pL = opts.pTogetherLeave ?? DEFAULTS.pTogetherLeave
  const cap = opts.maxAbsLogOdds ?? DEFAULTS.maxAbsLogOdds
  const T = Math.max(opts.coverageMs, 1)

  // Restarts and outages first: find moments where far more people joined or
  // left at once than the server ever does organically.
  const allJoins = spans.filter((x) => !x.joinCensored).map((x) => x.join)
  const allLeaves = spans.filter((x) => !x.leaveCensored).map((x) => x.leave)
  const perWindow = (n: number) => (n / T) * 2 * w
  const threshold = (n: number) =>
    opts.massEventThreshold ?? Math.max(8, Math.ceil(6 * perWindow(n) + 4))
  const keepJoin = massFilter(allJoins, w, threshold(allJoins.length))
  const keepLeave = massFilter(allLeaves, w, threshold(allLeaves.length))
  const joinRateAt = diurnalFactor(allJoins.filter(keepJoin))
  const leaveRateAt = diurnalFactor(allLeaves.filter(keepLeave))

  const by = new Map<string, { spans: SessionSpan[]; joins: number[]; leaves: number[]; online: number }>()
  for (const s of spans) {
    let p = by.get(s.player)
    if (!p) by.set(s.player, (p = { spans: [], joins: [], leaves: [], online: 0 }))
    p.spans.push(s)
    p.online += Math.max(0, s.leave - s.join)
    if (!s.joinCensored && keepJoin(s.join)) p.joins.push(s.join)
    if (!s.leaveCensored && keepLeave(s.leave)) p.leaves.push(s.leave)
  }
  for (const p of by.values()) {
    p.joins.sort((x, y) => x - y)
    p.leaves.sort((x, y) => x - y)
  }

  // Candidate pairs: anyone whose join or leave fell within the window of
  // someone else's. A sweep over sorted events finds them in O(E log E).
  const candidates = new Set<string>()
  const sweep = (kind: 'joins' | 'leaves') => {
    const ev: { t: number; who: string }[] = []
    for (const [who, p] of by) for (const t of p[kind]) ev.push({ t, who })
    ev.sort((x, y) => x.t - y.t)
    for (let i = 0; i < ev.length; i++) {
      for (let k = i + 1; k < ev.length && ev[k].t - ev[i].t <= w; k++) {
        if (ev[k].who === ev[i].who) continue
        const [a, b] = ev[i].who < ev[k].who ? [ev[i].who, ev[k].who] : [ev[k].who, ev[i].who]
        candidates.add(`${a}\u0000${b}`)
      }
    }
  }
  sweep('joins')
  sweep('leaves')

  const out: PairSessionStats[] = []
  for (const key of candidates) {
    const [a, b] = key.split('\u0000')
    const A = by.get(a)!
    const B = by.get(b)!

    // Count from the player with FEWER events: each of their joins is one
    // trial of "did the other one join too". The chance of a coincidence is
    // the busier player's event rate, scaled to how busy the server is at
    // that hour, over a ±w window.
    const [jf, jt] = A.joins.length <= B.joins.length ? [A.joins, B.joins] : [B.joins, A.joins]
    const [lf, lt] = A.leaves.length <= B.leaves.length ? [A.leaves, B.leaves] : [B.leaves, A.leaves]
    const jFlags = alignedFlags(jf, jt, w)
    const lFlags = alignedFlags(lf, lt, w)

    const trialLLR = (times: number[], flags: boolean[], other: number, p1: number, rateAt: (t: number) => number) => {
      let llr = 0
      for (let i = 0; i < times.length; i++) {
        const p0 = 1 - Math.exp(-(other / T) * rateAt(times[i]) * 2 * w)
        llr += binomialLLR(flags[i] ? 1 : 0, 1, p1, p0)
      }
      return llr
    }
    const llrJ = trialLLR(jf, jFlags, jt.length, pJ, joinRateAt)
    const llrL = trialLLR(lf, lFlags, lt.length, pL, leaveRateAt)
    const xj = jFlags.filter(Boolean).length
    const xl = lFlags.filter(Boolean).length

    // Co-presence is weak on its own, but its ABSENCE is informative: two
    // people who share a login moment yet are almost never online together
    // are not a team. Measured as lift over independence.
    const ov = overlapMs(A.spans, B.spans)
    const expected = (A.online * B.online) / T
    const lift = expected > 0 ? ov / expected : 0
    const liftTerm = expected >= 30 * 60_000
      ? Math.max(-2, Math.min(1, 0.6 * Math.log(Math.max(lift, 0.05))))
      : 0

    const logOdds = Math.max(-cap, Math.min(cap, llrJ + llrL + liftTerm))
    out.push({
      a, b,
      joinsAligned: xj, joinOpportunities: jf.length,
      leavesAligned: xl, leaveOpportunities: lf.length,
      overlapMs: ov, overlapLift: lift, logOdds,
    })
  }
  return out
}

export function sessionEvidenceFrom(s: PairSessionStats, at: string): PairEvidence {
  return {
    kind: 'session-overlap',
    logOdds: s.logOdds,
    at,
    note: `joined together ${s.joinsAligned}/${s.joinOpportunities}, `
      + `left together ${s.leavesAligned}/${s.leaveOpportunities}, `
      + `co-presence ×${s.overlapLift.toFixed(1)}`,
  }
}

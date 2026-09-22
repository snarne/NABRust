// ---------------------------------------------------------------------------
// Team inference.
//
// Co-damage is NOT treated as a binary teammate signal — third parties are
// common. Each player pair carries a running log-odds that accumulates
// independent evidence, so confidence tightens over a wipe instead of
// flipping on a single fight.
// ---------------------------------------------------------------------------

import type { PairEvidence, PairLink, SteamId, Confidence } from '../types.ts'

/**
 * Default prior log-odds that two arbitrary players are teammates (~4%).
 *
 * Only a fallback: the real prior depends on population and team limit — on a
 * 300-player trio server it is closer to 1 in 250 — and the server passes that
 * in (see pairPriorLogOdds in sessionEvidence.ts).
 */
export const PRIOR_LOG_ODDS = -3.2

export function logOddsToProb(lo: number): Confidence {
  return 1 / (1 + Math.exp(-lo))
}

export function accumulate(link: PairLink, prior = PRIOR_LOG_ODDS): number {
  return link.evidence.reduce((acc, e) => acc + e.logOdds, prior)
}

export function pairConfidence(link: PairLink, prior = PRIOR_LOG_ODDS): Confidence {
  return logOddsToProb(accumulate(link, prior))
}

// --- likelihood ratios for individual signals ------------------------------

/**
 * Session overlap from Battlemetrics, normalised against how much either
 * player plays at all, so two heavy players don't look like a team.
 */
export function sessionOverlapEvidence(
  overlapMinutes: number,
  aMinutes: number,
  bMinutes: number,
  at: string,
): PairEvidence {
  const denom = Math.min(aMinutes, bMinutes) || 1
  const ratio = Math.min(overlapMinutes / denom, 1)
  // 0 overlap -> strongly negative, full overlap -> strongly positive
  const logOdds = -1.8 + ratio * 6.0
  return {
    kind: 'session-overlap',
    logOdds,
    at,
    note: `${Math.round(ratio * 100)}% normalised overlap`,
  }
}

/**
 * Teammates open fire together. A late arrival is the signature of a third
 * party, so onset gap is measured in seconds from the first damage event.
 */
export function onsetEvidence(gapSeconds: number, at: string): PairEvidence {
  const logOdds = gapSeconds <= 3 ? 1.6 : gapSeconds <= 8 ? 0.3 : -2.1
  return {
    kind: 'co-onset',
    logOdds,
    at,
    note: `${gapSeconds.toFixed(1)}s onset gap`,
  }
}

/**
 * Teammates pushing together track similar ranges that change together.
 * `r` is the Pearson correlation of the two attackers' distance-over-time.
 */
export function distanceCorrelationEvidence(r: number, at: string): PairEvidence {
  return {
    kind: 'distance-correlation',
    logOdds: r * 1.4,
    at,
    note: `r=${r.toFixed(2)} range correlation`,
  }
}

/**
 * HP accounting. If a target loses more HP than our own hits explain, a
 * shooter outside our party is present — direct evidence AGAINST the odd
 * attacker being on the same team as the others.
 */
export function hpAccountingEvidence(
  observedDrop: number,
  explainedDamage: number,
  at: string,
): PairEvidence {
  const unexplained = observedDrop - explainedDamage
  const strong = unexplained > 15
  return {
    kind: 'hp-accounting',
    logOdds: strong ? -2.6 : 0.2,
    at,
    note: `${unexplained.toFixed(0)} HP unexplained`,
  }
}

/** A roster the user asserted. Weighted heavily but kept separately typed. */
export function manualLabelEvidence(at: string): PairEvidence {
  return { kind: 'manual-label', logOdds: 5.0, at, note: 'user-confirmed' }
}

// --- clustering -------------------------------------------------------------

/**
 * Correlation clustering with a team-size cap.
 *
 * Pairs are merged strongest-first, but two groups only combine if the
 * AVERAGE confidence across every cross pair clears the threshold. Pairs with
 * no evidence count at the prior, and negative evidence (a third party) pulls
 * the average down — so one strong link can't drag a stranger into a team, and
 * someone who shot at a member can't be merged with them through a mutual
 * acquaintance.
 */
export function clusterPairs(
  links: PairLink[],
  opts: { threshold?: number; maxTeam?: number; prior?: number } = {},
): SteamId[][] {
  const threshold = opts.threshold ?? 0.6
  const maxTeam = Math.max(1, opts.maxTeam ?? 8)
  const prior = opts.prior ?? PRIOR_LOG_ODDS
  const priorP = logOddsToProb(prior)

  const conf = new Map<string, number>()
  const key = (a: SteamId, b: SteamId) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)
  for (const l of links) conf.set(key(l.a, l.b), pairConfidence(l, prior))
  const pc = (a: SteamId, b: SteamId) => conf.get(key(a, b)) ?? priorP

  const strong = links
    .map((l) => ({ l, p: conf.get(key(l.a, l.b))! }))
    .filter((x) => x.p >= threshold)
    .sort((a, b) => b.p - a.p)

  const groupOf = new Map<SteamId, SteamId[]>()
  const get = (x: SteamId) => {
    let g = groupOf.get(x)
    if (!g) groupOf.set(x, (g = [x]))
    return g
  }

  for (const { l } of strong) {
    const ga = get(l.a)
    const gb = get(l.b)
    if (ga === gb) continue
    if (ga.length + gb.length > maxTeam) continue // respect the cap
    let sum = 0
    for (const x of ga) for (const y of gb) sum += pc(x, y)
    if (sum / (ga.length * gb.length) < threshold) continue
    const merged = [...ga, ...gb]
    for (const m of merged) groupOf.set(m, merged)
  }

  return [...new Set(groupOf.values())].filter((g) => g.length > 1)
}

/**
 * Calibration hook: maps model confidence onto observed frequency.
 *
 * Currently the identity, on evidence. The validation harness
 * (server/src/validation/simulate.ts) pooled 12 simulated servers and found
 * the co-movement posterior already calibrated — predicted vs observed within
 * 4 points in every band — while the hand-drawn table that used to live here
 * pulled a true 17% down to 8%. Fit a real table here once there are
 * confirmed rosters from live servers to fit it on.
 */
export function calibrate(raw: Confidence): Confidence {
  return Math.min(1, Math.max(0, raw))
}

/**
 * A link's confidence as the UI should show it: the server's value when it
 * sent one (it knows this server's population prior), else recomputed.
 */
export function linkConfidence(link: PairLink): Confidence {
  return link.confidence ?? calibrate(pairConfidence(link))
}

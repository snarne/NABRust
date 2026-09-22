// ---------------------------------------------------------------------------
// Threat model, v1.
//
// A threat number is only worth showing if it can be explained, so this is a
// small weighted score over things we actually observe, ranked into a
// percentile against the people on the SAME server this wipe. "92" means
// "more dangerous than 92% of who's here", which is the question that matters
// when you spawn in — an absolute score would rank a casual server's best
// player the same as a sweat's.
//
// Inputs, and why each is here:
//   time this wipe   people who are on constantly have gear, a base, a group
//   Rust hours       Steam, when the profile is public — skill is mostly hours
//   group size       from the clan inference; a trio beats a solo
//   harm to us       damage dealt to our team this wipe, from our combat logs
//
// Missing inputs don't count against anyone: a private Steam profile scores
// on the other three, and the factor list says "private" rather than zero.
// ---------------------------------------------------------------------------

import type { SteamId } from '../../shared/types.ts'

export interface ThreatInput {
  steamId: SteamId
  hoursThisWipe: number
  /** Null when the Steam profile is private or not fetched. */
  rustHours: number | null
  /** Members in this player's inferred group, including them. 1 = solo. */
  groupSize: number
  damageToUs: number
  killsOnUs: number
}

export interface ThreatResult {
  steamId: SteamId
  score: number
  percentile: number
  factors: { label: string; value: string }[]
}

const WEIGHTS = { wipe: 0.35, hours: 0.25, group: 0.2, harm: 0.2 }

/** Saturating 0..1 transform: `half` is the value that scores 0.5. */
function sat(v: number, half: number): number {
  return v <= 0 ? 0 : v / (v + half)
}

export function scoreThreats(inputs: ThreatInput[]): ThreatResult[] {
  const scored = inputs.map((p) => {
    const parts: [number, number][] = [
      [WEIGHTS.wipe, sat(p.hoursThisWipe, 12)],
      [WEIGHTS.group, sat(p.groupSize - 1, 2)],
      [WEIGHTS.harm, sat(p.damageToUs + p.killsOnUs * 100, 150)],
    ]
    if (p.rustHours !== null) parts.push([WEIGHTS.hours, sat(p.rustHours, 1500)])
    // Renormalise over the inputs we have, so a private profile isn't a discount.
    const wsum = parts.reduce((s, [w]) => s + w, 0)
    const score = parts.reduce((s, [w, v]) => s + w * v, 0) / wsum

    const factors = [
      { label: 'this wipe', value: `${p.hoursThisWipe.toFixed(1)} h on server` },
      { label: 'Rust hours', value: p.rustHours === null ? 'private / unknown' : `${p.rustHours.toLocaleString()} h` },
      { label: 'group', value: p.groupSize > 1 ? `${p.groupSize} (inferred)` : 'solo / unknown' },
      {
        label: 'vs us',
        value: p.damageToUs || p.killsOnUs
          ? `${Math.round(p.damageToUs)} dmg, ${p.killsOnUs} kill${p.killsOnUs === 1 ? '' : 's'}`
          : 'no contact logged',
      },
    ]
    return { steamId: p.steamId, score, factors }
  })

  // Percentile rank: share of the population scoring strictly lower, ties split.
  const sorted = scored.map((s) => s.score).sort((a, b) => a - b)
  const n = sorted.length
  const below = (v: number) => {
    let lo = 0
    let hi = n
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m }
    let eq = lo
    while (eq < n && sorted[eq] === v) eq++
    return lo + (eq - lo - 1) / 2
  }
  return scored.map((s) => ({
    ...s,
    percentile: n <= 1 ? 50 : Math.round((below(s.score) / (n - 1)) * 100),
  }))
}

/**
 * How hard the server is, from the Rust hours of the people on it. Needs a
 * real sample: with fewer than `minProfiles` public profiles it says
 * 'unknown' rather than extrapolating from three people.
 */
export function serverHeat(
  rustHours: (number | null)[], minProfiles = 15,
): 'casual' | 'moderate' | 'sweaty' | 'extreme' | 'unknown' {
  const known = rustHours.filter((h): h is number => h !== null).sort((a, b) => a - b)
  if (known.length < minProfiles) return 'unknown'
  const median = known[known.length >> 1]
  if (median < 500) return 'casual'
  if (median < 1500) return 'moderate'
  if (median < 4000) return 'sweaty'
  return 'extreme'
}

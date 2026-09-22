// ---------------------------------------------------------------------------
// Rust combat log parsing.
//
// `combatlog` in the F1 console prints a whitespace-aligned table:
//
//   time  attacker  id  target  id  weapon  ammo  area  distance  old_hp  new_hp  info
//
// Column count varies between builds and some cells are "N/A" or blank, so the
// parser is tolerant: it splits on runs of whitespace, finds the numeric
// columns by position from the right, and rejects rather than guesses when a
// line doesn't fit.
//
// IMPORTANT: the combat log records DAMAGE EVENTS only. Misses are not in it,
// so true accuracy is not computable from this source — only hit quality
// (headshot rate, body-part distribution, damage per engagement).
//
// The log identifies players by steam id, not by name. Names come from the
// client log's death lines (see clientlog.ts) and from Battlemetrics.
// ---------------------------------------------------------------------------

export interface ParsedCombatLine {
  t: number
  attackerId: string | null   // null = environment / unattributed
  attackerName: string
  targetId: string
  targetName: string
  weapon: string
  ammo: string | null
  area: string
  distance: number
  hpBefore: number
  hpAfter: number
  damage: number
  info: string | null
}

export interface ParseResult {
  rows: ParsedCombatLine[]
  rejected: { line: string; reason: string }[]
}

const STEAM_ID = /^\d{17}$/
const NA = new Set(['n/a', 'na', '-', '', 'none', 'null'])

function num(s: string | undefined): number | null {
  if (s === undefined) return null
  const cleaned = s.replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-') return null
  const v = Number(cleaned)
  return Number.isFinite(v) ? v : null
}

function nullable(s: string | undefined): string | null {
  if (s === undefined) return null
  return NA.has(s.toLowerCase()) ? null : s
}

/**
 * Parse the console output of `combatlog`. Accepts the header line and blank
 * lines and skips them.
 */
export function parseCombatLog(text: string): ParseResult {
  const rows: ParsedCombatLine[] = []
  const rejected: { line: string; reason: string }[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (/^time\s+attacker/i.test(line)) continue      // header
    if (/^[-=\s]+$/.test(line)) continue              // separator

    const c = line.split(/\s+/)
    if (c.length < 9) {
      rejected.push({ line, reason: `too few columns (${c.length})` })
      continue
    }

    // Time is always first and suffixed with 's' in most builds.
    const t = num(c[0])
    if (t === null) {
      rejected.push({ line, reason: 'unparseable time' })
      continue
    }

    // Steam ids anchor the layout: attacker id is the first, target id the
    // second. Anything before the first id is the attacker's display name.
    const idIdx: number[] = []
    for (let i = 1; i < c.length && idIdx.length < 2; i++) {
      if (STEAM_ID.test(c[i])) idIdx.push(i)
    }

    let attackerName: string, attackerId: string | null
    let targetName: string, targetId: string
    let rest: string[]

    if (idIdx.length === 2) {
      attackerName = c.slice(1, idIdx[0]).join(' ') || 'unknown'
      attackerId = c[idIdx[0]]
      targetName = c.slice(idIdx[0] + 1, idIdx[1]).join(' ') || 'unknown'
      targetId = c[idIdx[1]]
      rest = c.slice(idIdx[1] + 1)
    } else if (idIdx.length === 1) {
      // One side is an NPC/environment, which carries a negative or missing id.
      attackerName = c.slice(1, idIdx[0]).join(' ') || 'unknown'
      attackerId = c[idIdx[0]]
      targetName = c[idIdx[0] + 1] ?? 'unknown'
      targetId = c[idIdx[0] + 2] ?? ''
      rest = c.slice(idIdx[0] + 3)
      if (!STEAM_ID.test(targetId)) {
        rejected.push({ line, reason: 'no player target id' })
        continue
      }
    } else {
      rejected.push({ line, reason: 'no steam id found' })
      continue
    }

    // rest = weapon ammo area distance old_hp new_hp [info...]
    const weapon = rest[0] ?? 'unknown'
    const ammo = nullable(rest[1])
    const area = rest[2] ?? 'unknown'
    const distance = num(rest[3])
    const hpBefore = num(rest[4])
    const hpAfter = num(rest[5])
    const info = rest.slice(6).join(' ') || null

    if (hpBefore === null || hpAfter === null) {
      rejected.push({ line, reason: 'missing hp columns' })
      continue
    }

    rows.push({
      t,
      attackerId: attackerId && STEAM_ID.test(attackerId) ? attackerId : null,
      attackerName,
      targetId,
      targetName,
      weapon,
      ammo,
      area,
      distance: distance ?? 0,
      hpBefore,
      hpAfter,
      damage: Math.max(0, hpBefore - hpAfter),
      info,
    })
  }

  return { rows, rejected }
}

/**
 * Group damage events into engagements. A gap longer than `gapSeconds` between
 * consecutive events starts a new one.
 */
export function segmentEncounters(
  rows: ParsedCombatLine[],
  gapSeconds = 45,
): ParsedCombatLine[][] {
  const sorted = [...rows].sort((a, b) => a.t - b.t)
  const out: ParsedCombatLine[][] = []
  let cur: ParsedCombatLine[] = []
  for (const r of sorted) {
    if (cur.length && r.t - cur[cur.length - 1].t > gapSeconds) {
      out.push(cur)
      cur = []
    }
    cur.push(r)
  }
  if (cur.length) out.push(cur)
  return out
}

/**
 * HP accounting. Between two of our own hits on the same target, any HP loss
 * we cannot explain means a shooter outside our party is present. This is the
 * strongest third-party signal available and nothing else in the log provides
 * it.
 */
export function detectThirdParties(
  events: ParsedCombatLine[],
  selfId: string,
): { flagged: Set<ParsedCombatLine>; unexplained: Map<string, number> } {
  const flagged = new Set<ParsedCombatLine>()
  const unexplained = new Map<string, number>()

  const byTarget = new Map<string, ParsedCombatLine[]>()
  for (const e of events) {
    const arr = byTarget.get(e.targetId) ?? []
    arr.push(e)
    byTarget.set(e.targetId, arr)
  }

  for (const [target, arr] of byTarget) {
    arr.sort((a, b) => a.t - b.t)
    let gap = 0
    for (let i = 1; i < arr.length; i++) {
      // HP at the start of this hit should equal HP after the previous one.
      const drop = arr[i - 1].hpAfter - arr[i].hpBefore
      if (drop > 5) {
        flagged.add(arr[i])
        gap += drop
      }
    }
    // Healing shows up as negative drop; only count genuine unexplained loss.
    if (gap > 0) unexplained.set(target, gap)
  }

  return { flagged, unexplained }
}

/** Seconds between the first damage of each attacker in one engagement. */
export function onsetGaps(events: ParsedCombatLine[]): Map<string, number> {
  const first = new Map<string, number>()
  for (const e of events) {
    if (!e.attackerId) continue
    if (!first.has(e.attackerId)) first.set(e.attackerId, e.t)
  }
  const t0 = Math.min(...first.values())
  const out = new Map<string, number>()
  for (const [id, t] of first) out.set(id, t - t0)
  return out
}

/** Pearson correlation of two attackers' distance-over-time in one fight. */
export function distanceCorrelation(
  events: ParsedCombatLine[],
  a: string,
  b: string,
): number | null {
  const sa = events.filter((e) => e.attackerId === a).sort((x, y) => x.t - y.t)
  const sb = events.filter((e) => e.attackerId === b).sort((x, y) => x.t - y.t)
  const n = Math.min(sa.length, sb.length)
  if (n < 2) return null

  const xs = sa.slice(0, n).map((e) => e.distance)
  const ys = sb.slice(0, n).map((e) => e.distance)
  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    dx += (xs[i] - mx) ** 2
    dy += (ys[i] - my) ** 2
  }
  const den = Math.sqrt(dx * dy)
  return den === 0 ? null : num / den
}

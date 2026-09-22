// ---------------------------------------------------------------------------
// Raid costing.
//
// Explosives needed per wall and door, and the sulfur behind each explosive.
// These numbers move with game patches, so they're data with a source and a
// date, not constants to trust forever. Checked 2026-09-22 against three
// independent charts, which agree on C4, rockets and satchels:
//
//   rustly.com/raid-calculator        (Sept 2026, build 2633.288.1)  — used
//   supercraft.host/article/rust-raid-calculator  (Aug 2026)
//   rust.icefuse.com/guides/rust-raid-cost-chart  (Aug 2026)
//
// Explosive-ammo counts differ by a few rounds between charts (ammo damage
// varies with where it lands); the build-stamped figures are used, except wood
// wall and wood door ammo, which only the supercraft chart lists.
//
// Where a chart says one rocket "leaves it nearly destroyed", the count here
// is the number that actually brings it down.
// ---------------------------------------------------------------------------

import type { DoorTier, RaidPath, WallTier } from './types.ts'

export const RAID_TABLE_SOURCE = 'rustly.com raid chart, build 2633.288.1 (Sept 2026)'

export type Explosive = 'c4' | 'rocket' | 'satchel' | 'explo'

export const EXPLOSIVE_LABEL: Record<Explosive, string> = {
  c4: 'C4', rocket: 'Rockets', satchel: 'Satchels', explo: 'Explosive 5.56',
}

/** Sulfur in each explosive's full craft chain. */
export const SULFUR_PER: Record<Explosive, number> = {
  c4: 2200, rocket: 1400, satchel: 480, explo: 25,
}

type Need = Record<Explosive, number>

export const WALLS: Record<WallTier, Need> = {
  wood: { c4: 1, rocket: 2, satchel: 3, explo: 48 },
  stone: { c4: 2, rocket: 4, satchel: 10, explo: 185 },
  metal: { c4: 4, rocket: 8, satchel: 23, explo: 400 },
  armored: { c4: 8, rocket: 15, satchel: 46, explo: 799 },
}

export const DOORS: Record<DoorTier, Need> = {
  wood: { c4: 1, rocket: 1, satchel: 2, explo: 18 },
  sheet: { c4: 1, rocket: 2, satchel: 4, explo: 63 },
  garage: { c4: 2, rocket: 3, satchel: 9, explo: 150 },
  armored: { c4: 3, rocket: 5, satchel: 15, explo: 250 },
}

export interface RaidPlan {
  key: string
  label: string
  description: string
  /** Explosives of each kind to bring. */
  mix: Partial<Record<Explosive, number>>
  sulfur: number
}

interface Element { label: string; need: Need }

function elements(path: RaidPath): Element[] {
  const out: Element[] = []
  for (const [tier, n] of Object.entries(path.walls ?? {}) as [WallTier, number][]) {
    for (let i = 0; i < n; i++) out.push({ label: `${tier} wall`, need: WALLS[tier] })
  }
  for (const [tier, n] of Object.entries(path.doors ?? {}) as [DoorTier, number][]) {
    for (let i = 0; i < n; i++) out.push({ label: `${tier} door`, need: DOORS[tier] })
  }
  return out
}

function planWith(els: Element[], allowed: Explosive[]): { mix: Partial<Record<Explosive, number>>; sulfur: number } {
  const mix: Partial<Record<Explosive, number>> = {}
  let sulfur = 0
  for (const e of els) {
    let best: Explosive = allowed[0]
    for (const x of allowed) {
      if (e.need[x] * SULFUR_PER[x] < e.need[best] * SULFUR_PER[best]) best = x
    }
    mix[best] = (mix[best] ?? 0) + e.need[best]
    sulfur += e.need[best] * SULFUR_PER[best]
  }
  return { mix, sulfur }
}

/**
 * Every sensible way to open this path, cheapest first.
 *
 *   cheapest     the lowest-sulfur explosive for each wall and door
 *   no-satchels  C4, rockets and ammo only — satchels dud and take time
 *   <one type>   everything with a single explosive, for when that's what
 *                you have
 */
export function planRaid(path: RaidPath): RaidPlan[] {
  const els = elements(path)
  if (!els.length) return []
  const plans: RaidPlan[] = []
  const cheapest = planWith(els, ['c4', 'rocket', 'satchel', 'explo'])
  plans.push({ key: 'cheapest', label: 'Cheapest', description: 'lowest-sulfur explosive for each layer', ...cheapest })
  const reliable = planWith(els, ['c4', 'rocket', 'explo'])
  if (reliable.sulfur !== cheapest.sulfur) {
    plans.push({ key: 'no-satchels', label: 'No satchels', description: 'no duds, no waiting on fuses', ...reliable })
  }
  for (const x of ['c4', 'rocket', 'satchel', 'explo'] as Explosive[]) {
    const p = planWith(els, [x])
    plans.push({ key: x, label: `${EXPLOSIVE_LABEL[x]} only`, description: `everything with ${EXPLOSIVE_LABEL[x].toLowerCase()}`, ...p })
  }
  return plans.sort((a, b) => a.sulfur - b.sulfur)
}

export type Inventory = Partial<Record<Explosive | 'sulfur', number>>

/**
 * Can we do this with what we have? Explosives already crafted are used
 * first; any shortfall is covered from raw sulfur if there's enough.
 */
export function affordability(plan: RaidPlan, inv: Inventory): { ok: boolean; shortSulfur: number } {
  let short = 0
  for (const [x, n] of Object.entries(plan.mix) as [Explosive, number][]) {
    const missing = Math.max(0, n - (inv[x] ?? 0))
    short += missing * SULFUR_PER[x]
  }
  const left = short - (inv.sulfur ?? 0)
  return { ok: left <= 0, shortSulfur: Math.max(0, left) }
}

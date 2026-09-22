// ---------------------------------------------------------------------------
// The pair graph — persistence layer for team inference.
//
// The maths lives in shared/inference/clanEvidence.ts so the web app and the
// server agree by construction. This module records evidence, keeps the
// materialised sum current, and turns the graph into rosters.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import type { DB } from './db/index.ts'
import { nowIso, pairKey, tx } from './db/index.ts'
import type { PairEvidence, PairLink, SteamId } from '../../shared/types.ts'
import {
  clusterPairs, logOddsToProb, pairConfidence, PRIOR_LOG_ODDS,
} from '../../shared/inference/clanEvidence.ts'

/**
 * The prior this server's pairs are scored from. Set by the session evidence
 * builder from population and team limit; the generic default until then.
 */
export function pairPrior(db: DB, serverId: string): number {
  const row = db.prepare(`SELECT value FROM server_state WHERE server_id = ? AND key = 'pair_prior'`)
    .get(serverId) as { value: string } | undefined
  const v = row ? Number(JSON.parse(row.value)) : NaN
  return Number.isFinite(v) ? v : PRIOR_LOG_ODDS
}

/** Team size limit from the servers row, else from the name (Solo/Duo/Trio/Quad). */
export function teamLimit(db: DB, serverId: string): number {
  const row = db.prepare(`SELECT name, team_limit FROM servers WHERE id = ?`)
    .get(serverId) as { name: string; team_limit: number | null } | undefined
  if (row?.team_limit) return row.team_limit
  return inferTeamLimit(row?.name ?? '') ?? 8
}

export function inferTeamLimit(name: string): number | null {
  const n = name.toLowerCase()
  if (/\bsolo\b/.test(n)) return 1
  if (/\bduos?\b/.test(n)) return 2
  if (/\btrios?\b/.test(n)) return 3
  if (/\bquads?\b/.test(n)) return 4
  return null
}

export function addEvidence(
  db: DB,
  serverId: string,
  x: SteamId,
  y: SteamId,
  ev: PairEvidence,
  encounterId?: string,
): void {
  if (x === y) return
  const [a, b] = pairKey(x, y)
  tx(db, () => {
    db.prepare(
      `INSERT INTO pair_evidence
         (server_id, a_steam_id, b_steam_id, kind, log_odds, observed_at, note, encounter_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(serverId, a, b, ev.kind, ev.logOdds, ev.at, ev.note ?? null, encounterId ?? null)
    refreshPairState(db, serverId, a, b)
  })
}

/**
 * Recompute one pair's running total from its evidence log. Cheap because a
 * pair accumulates tens of rows, not thousands, and it keeps pair_state honest
 * even if evidence is back-filled out of order.
 */
export function refreshPairState(db: DB, serverId: string, a: SteamId, b: SteamId): void {
  const rows = db
    .prepare(
      `SELECT kind, log_odds, observed_at, note
         FROM pair_evidence
        WHERE server_id = ? AND a_steam_id = ? AND b_steam_id = ?`,
    )
    .all(serverId, a, b) as { kind: string; log_odds: number; observed_at: string; note: string | null }[]

  const link: PairLink = {
    a, b,
    evidence: rows.map((r) => ({
      kind: r.kind as PairEvidence['kind'],
      logOdds: r.log_odds,
      at: r.observed_at,
      note: r.note ?? undefined,
    })),
  }

  // The posterior is used as-is: the validation harness found it already
  // calibrated (predicted vs observed within 4 points in every band), and the
  // old hand-drawn calibration table made it worse.
  const conf = pairConfidence(link, pairPrior(db, serverId))
  const sum = rows.reduce((s, r) => s + r.log_odds, 0)

  db.prepare(
    `INSERT INTO pair_state
       (server_id, a_steam_id, b_steam_id, log_odds, evidence_count, confidence, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, a_steam_id, b_steam_id) DO UPDATE SET
       log_odds = excluded.log_odds,
       evidence_count = excluded.evidence_count,
       confidence = excluded.confidence,
       updated_at = excluded.updated_at`,
  ).run(serverId, a, b, sum, rows.length, conf, nowIso())
}

export function getPairConfidence(db: DB, serverId: string, x: SteamId, y: SteamId): number {
  const [a, b] = pairKey(x, y)
  const row = db
    .prepare(
      `SELECT confidence FROM pair_state
        WHERE server_id = ? AND a_steam_id = ? AND b_steam_id = ?`,
    )
    .get(serverId, a, b) as { confidence: number } | undefined
  return row?.confidence ?? 0
}

export function loadLinks(db: DB, serverId: string): PairLink[] {
  const pairs = db
    .prepare(
      `SELECT a_steam_id, b_steam_id, confidence FROM pair_state WHERE server_id = ?`,
    )
    .all(serverId) as { a_steam_id: string; b_steam_id: string; confidence: number }[]

  return pairs.map(({ a_steam_id: a, b_steam_id: b, confidence }) => {
    const rows = db
      .prepare(
        `SELECT kind, log_odds, observed_at, note FROM pair_evidence
          WHERE server_id = ? AND a_steam_id = ? AND b_steam_id = ?`,
      )
      .all(serverId, a, b) as { kind: string; log_odds: number; observed_at: string; note: string | null }[]
    return {
      a, b,
      confidence,
      evidence: rows.map((r) => ({
        kind: r.kind as PairEvidence['kind'],
        logOdds: r.log_odds,
        at: r.observed_at,
        note: r.note ?? undefined,
      })),
    }
  })
}

/** Recompute every pair's materialised state, e.g. after the prior moved. */
export function refreshAllPairStates(db: DB, serverId: string): number {
  const pairs = db.prepare(
    `SELECT DISTINCT a_steam_id AS a, b_steam_id AS b FROM pair_evidence WHERE server_id = ?`,
  ).all(serverId) as { a: string; b: string }[]
  tx(db, () => {
    // Pairs whose evidence was all removed fall back to the prior: drop them.
    db.prepare(
      `DELETE FROM pair_state WHERE server_id = ? AND NOT EXISTS (
         SELECT 1 FROM pair_evidence e WHERE e.server_id = pair_state.server_id
           AND e.a_steam_id = pair_state.a_steam_id AND e.b_steam_id = pair_state.b_steam_id)`,
    ).run(serverId)
    for (const { a, b } of pairs) refreshPairState(db, serverId, a, b)
  })
  return pairs.length
}

/**
 * Cluster the graph into rosters and persist them. Manual memberships are
 * preserved: if the user asserted someone is in a clan, inference does not
 * silently drop them — the conflict is surfaced instead.
 */
export function rebuildClans(
  db: DB,
  serverId: string,
  opts: { threshold?: number; maxTeam?: number } = {},
): { clans: number; conflicts: string[] } {
  const links = loadLinks(db, serverId)
  const groups = clusterPairs(links, {
    threshold: opts.threshold ?? 0.6,
    maxTeam: opts.maxTeam ?? teamLimit(db, serverId),
    prior: pairPrior(db, serverId),
  })
  const conflicts: string[] = []
  const at = nowIso()

  const manual = db
    .prepare(
      `SELECT cm.steam_id, cm.clan_id FROM clan_members cm
         JOIN clans c ON c.id = cm.clan_id
        WHERE c.server_id = ? AND cm.source = 'manual'`,
    )
    .all(serverId) as { steam_id: string; clan_id: string }[]

  // Match each new group to the existing roster it shares the most members
  // with, so a roster keeps its id (and any name the team gave it) across
  // rebuilds. Positional ids would let a marked base silently change owners
  // when the clusters come back in a different order.
  const existing = new Map<string, Set<SteamId>>()
  for (const r of db.prepare(
    `SELECT c.id, cm.steam_id FROM clans c JOIN clan_members cm ON cm.clan_id = c.id WHERE c.server_id = ?`,
  ).all(serverId) as { id: string; steam_id: string }[]) {
    let set = existing.get(r.id)
    if (!set) existing.set(r.id, (set = new Set()))
    set.add(r.steam_id)
  }
  const claimed = new Set<string>()
  const pairsByOverlap: { gi: number; id: string; shared: number }[] = []
  groups.forEach((g, gi) => {
    for (const [id, set] of existing) {
      const shared = g.filter((m) => set.has(m)).length
      if (shared > 0) pairsByOverlap.push({ gi, id, shared })
    }
  })
  pairsByOverlap.sort((a, b) => b.shared - a.shared)
  const idFor = new Map<number, string>()
  for (const p of pairsByOverlap) {
    if (idFor.has(p.gi) || claimed.has(p.id)) continue
    idFor.set(p.gi, p.id)
    claimed.add(p.id)
  }

  tx(db, () => {
    // Inferred memberships are rebuilt; manual ones are never deleted here.
    db.prepare(
      `DELETE FROM clan_members WHERE source = 'inferred' AND clan_id IN
         (SELECT id FROM clans WHERE server_id = ?)`,
    ).run(serverId)

    groups.forEach((members, i) => {
      const reused = idFor.get(i)
      const clanId = reused ?? `${serverId}:clan-${randomUUID().slice(0, 8)}`
      if (!reused) {
        db.prepare(
          `INSERT INTO clans (id, server_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(clanId, serverId, clanLabel(db, members, i), at, at)
      } else {
        db.prepare(`UPDATE clans SET updated_at = ? WHERE id = ?`).run(at, clanId)
      }

      for (const m of members) {
        // Average confidence to the rest of the group decides core vs fringe.
        const others = members.filter((o) => o !== m)
        const avg = others.length
          ? others.reduce((s, o) => s + getPairConfidence(db, serverId, m, o), 0) / others.length
          : 0
        const owned = manual.find((x) => x.steam_id === m)
        if (owned && owned.clan_id !== clanId) {
          conflicts.push(`${m} is manually in ${owned.clan_id} but clusters into ${clanId}`)
          continue
        }
        db.prepare(
          `INSERT INTO clan_members (clan_id, steam_id, confidence, core, source)
           VALUES (?, ?, ?, ?, 'inferred')
           ON CONFLICT(clan_id, steam_id) DO UPDATE SET
             confidence = excluded.confidence, core = excluded.core`,
        ).run(clanId, m, avg, avg >= 0.75 ? 1 : 0)
      }
    })

    // A roster nobody belongs to any more has dissolved. Bases it owned lose
    // the attribution (ON DELETE SET NULL) rather than pointing at a ghost.
    db.prepare(
      `DELETE FROM clans WHERE server_id = ? AND id NOT IN (SELECT clan_id FROM clan_members)`,
    ).run(serverId)
  })

  return { clans: groups.length, conflicts }
}

/** Name a roster after its most-established member, until the user renames it. */
function clanLabel(db: DB, members: SteamId[], i: number): string {
  const row = db
    .prepare(
      `SELECT name FROM player_names
        WHERE steam_id IN (${members.map(() => '?').join(',')}) AND last_seen IS NULL
        ORDER BY first_seen ASC LIMIT 1`,
    )
    .get(...members) as { name: string } | undefined
  return row?.name ? `${row.name} +${members.length - 1}` : `group ${i + 1}`
}

export function setManualMembership(
  db: DB,
  serverId: string,
  clanId: string,
  label: string,
  members: SteamId[],
): void {
  const at = nowIso()
  tx(db, () => {
    db.prepare(
      `INSERT INTO clans (id, server_id, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
    ).run(clanId, serverId, label, at, at)
    for (const m of members) {
      db.prepare(
        `INSERT INTO clan_members (clan_id, steam_id, confidence, core, source)
         VALUES (?, ?, 1.0, 1, 'manual')
         ON CONFLICT(clan_id, steam_id) DO UPDATE SET
           confidence = 1.0, core = 1, source = 'manual'`,
      ).run(clanId, m)
    }
  })
}

export { logOddsToProb }

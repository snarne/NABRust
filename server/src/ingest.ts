// ---------------------------------------------------------------------------
// Ingest: raw agent output -> encounters, combat events, pair evidence.
//
// This is where a pasted combat log becomes intelligence. Each engagement
// yields several independent signals per attacker pair, which is what keeps
// third parties from being mistaken for teammates.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import type { DB } from './db/index.ts'
import { nowIso, pairKey, POLL_GAP_MS, tx } from './db/index.ts'
import { ensurePlayer, observeName } from './identity.ts'
import { addEvidence, refreshAllPairStates, teamLimit } from './pairs.ts'
import { currentWipe } from './retention.ts'
import { lastPoll } from './collectors/battlemetrics.ts'
import {
  coMovementStats, pairPriorLogOdds, sessionEvidenceFrom, type SessionSpan,
} from '../../shared/inference/sessionEvidence.ts'
import {
  detectThirdParties, distanceCorrelation, onsetGaps,
  parseCombatLog, segmentEncounters, type ParsedCombatLine,
} from './parsers/combatlog.ts'
import {
  distanceCorrelationEvidence, hpAccountingEvidence, onsetEvidence,
} from '../../shared/inference/clanEvidence.ts'

export interface IngestOptions {
  serverId: string
  wipeId: number
  /** Steam id of the teammate whose client produced this log. */
  reporterId: string
  /** Steam ids of our own team, so we never build pair evidence about us. */
  teamIds?: string[]
  at?: string
}

export interface IngestReport {
  linesIn: number
  encounters: number
  events: number
  evidence: number
  rejected: { line: string; reason: string }[]
}

export function ingestCombatLog(db: DB, text: string, opts: IngestOptions): IngestReport {
  const at = opts.at ?? nowIso()
  const team = new Set(opts.teamIds ?? [opts.reporterId])
  const { rows, rejected } = parseCombatLog(text)

  const report: IngestReport = {
    linesIn: text.split(/\r?\n/).filter((l) => l.trim()).length,
    encounters: 0, events: 0, evidence: 0, rejected,
  }

  for (const group of segmentEncounters(rows)) {
    if (!group.length) continue
    const { flagged, unexplained } = detectThirdParties(group, opts.reporterId)
    const gaps = onsetGaps(group)

    const enemyAttackers = [...new Set(
      group.map((e) => e.attackerId).filter((id): id is string => !!id && !team.has(id)),
    )]
    const outcome = died(group, team) ? 'died' : 'disengaged'
    const parties = countParties(enemyAttackers, gaps)
    const label = encounterLabel(db, group, team)

    // A teammate's death was already opened by Rust+ with the exact time and
    // place it happened. The log arrives moments later from the agent; attach
    // to that shell instead of creating a second, placeless encounter.
    const shell = outcome === 'died' ? deathShellFor(db, opts.wipeId, group, team, at) : null
    const encounterId = shell ?? randomUUID()

    tx(db, () => {
      if (shell) {
        db.prepare(
          `UPDATE encounters SET outcome = 'died', parties_detected = ?,
                  label = COALESCE(?, label) WHERE id = ?`,
        ).run(parties, label, shell)
      } else {
        db.prepare(
          `INSERT INTO encounters
             (id, server_id, wipe_id, started_at, label, outcome, parties_detected)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(encounterId, opts.serverId, opts.wipeId, at, label, outcome, parties)
      }
      report.encounters++

      for (const e of group) {
        if (e.attackerId) {
          ensurePlayer(db, e.attackerId, at)
          if (e.attackerName && e.attackerName !== 'unknown') {
            observeName(db, e.attackerId, e.attackerName, 'combatlog', at)
          }
        }
        ensurePlayer(db, e.targetId, at)
        if (e.targetName && e.targetName !== 'unknown') {
          observeName(db, e.targetId, e.targetName, 'combatlog', at)
        }

        const res = db.prepare(
          `INSERT INTO combat_events
             (encounter_id, t_server, attacker_id, target_id, weapon, ammo, area,
              distance, damage, hp_before, hp_after, third_party, reporter_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        ).run(
          encounterId, e.t, e.attackerId, e.targetId, e.weapon, e.ammo, e.area,
          e.distance, e.damage, e.hpBefore, e.hpAfter, flagged.has(e) ? 1 : 0,
          opts.reporterId,
        )
        if (res.changes > 0) report.events++
      }
    })

    // --- pair evidence, one set per enemy attacker pair in this engagement ---
    for (let i = 0; i < enemyAttackers.length; i++) {
      for (let j = i + 1; j < enemyAttackers.length; j++) {
        const a = enemyAttackers[i]
        const b = enemyAttackers[j]

        const ga = gaps.get(a) ?? 0
        const gb = gaps.get(b) ?? 0
        addEvidence(db, opts.serverId, a, b,
          onsetEvidence(Math.abs(ga - gb), at), encounterId)
        report.evidence++

        const r = distanceCorrelation(group, a, b)
        if (r !== null) {
          addEvidence(db, opts.serverId, a, b,
            distanceCorrelationEvidence(r, at), encounterId)
          report.evidence++
        }

        // If our own damage on a target doesn't explain its HP loss, someone
        // outside our party fired — evidence AGAINST the late arrival being on
        // the same team as the rest.
        for (const [target, gap] of unexplained) {
          if (target !== a && target !== b) continue
          const ourDamage = group
            .filter((e) => e.attackerId && team.has(e.attackerId) && e.targetId === target)
            .reduce((s, e) => s + e.damage, 0)
          addEvidence(db, opts.serverId, a, b,
            hpAccountingEvidence(ourDamage + gap, ourDamage, at), encounterId)
          report.evidence++
        }
      }
    }
  }

  db.prepare(
    `INSERT INTO ingest_log (at, reporter, kind, lines_in, rows_out, rejected, note)
     VALUES (?, ?, 'combatlog', ?, ?, ?, ?)`,
  ).run(at, opts.reporterId, report.linesIn, report.events, rejected.length,
    `${report.encounters} encounters, ${report.evidence} evidence`)

  return report
}

/**
 * The Rust+ death shell this log belongs to: same victim, opened in the few
 * minutes before the log arrived, and not yet holding combat events. Agents
 * post when the log is printed, which players do right after dying.
 */
function deathShellFor(
  db: DB, wipeId: number, group: ParsedCombatLine[], team: Set<string>, at: string,
): string | null {
  const kill = group.find((e) => team.has(e.targetId) && e.hpAfter <= 0)
  if (!kill) return null
  const t = Date.parse(at)
  const row = db.prepare(
    `SELECT e.id FROM encounters e
      WHERE e.wipe_id = ? AND e.id LIKE ? AND e.started_at BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM combat_events c WHERE c.encounter_id = e.id)
      ORDER BY e.started_at DESC LIMIT 1`,
  ).get(
    wipeId, `death:${wipeId}:${kill.targetId}:%`,
    new Date(t - 5 * 60_000).toISOString(), new Date(t + 60_000).toISOString(),
  ) as { id: string } | undefined
  return row?.id ?? null
}

/** "killed by slug_king · rifle.bolt 152m" or "fight vs RATatouille +2". */
function encounterLabel(db: DB, group: ParsedCombatLine[], team: Set<string>): string | null {
  const name = (id: string | null, fallback: string | null) =>
    (id && (db.prepare(`SELECT name FROM player_names WHERE steam_id = ? AND last_seen IS NULL`)
      .get(id) as { name: string } | undefined)?.name) || fallback || 'unknown'
  const kill = group.find((e) => team.has(e.targetId) && e.hpAfter <= 0)
  if (kill) {
    const dist = kill.distance ? ` ${Math.round(kill.distance)}m` : ''
    return `killed by ${name(kill.attackerId, kill.attackerName)} · ${kill.weapon ?? '?'}${dist}`
  }
  const enemies = [...new Set(group
    .flatMap((e) => [e.attackerId, e.targetId])
    .filter((id): id is string => !!id && !team.has(id)))]
  if (!enemies.length) return null
  const first = group.find((e) => e.attackerId === enemies[0] || e.targetId === enemies[0])
  const firstName = first?.attackerId === enemies[0] ? first.attackerName : first?.targetName
  return `fight vs ${name(enemies[0], firstName ?? null)}${enemies.length > 1 ? ` +${enemies.length - 1}` : ''}`
}

function died(group: ParsedCombatLine[], team: Set<string>): boolean {
  return group.some((e) => team.has(e.targetId) && e.hpAfter <= 0)
}

/** Attackers whose onset is tightly clustered look like one party. */
function countParties(attackers: string[], gaps: Map<string, number>): number {
  if (attackers.length <= 1) return attackers.length + 1
  const sorted = attackers.map((a) => gaps.get(a) ?? 0).sort((x, y) => x - y)
  let parties = 1
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > 8) parties++
  }
  return parties + 1 // plus our own
}

/**
 * Rebuild teammate evidence from Battlemetrics sessions for the current wipe.
 *
 * Scores join/leave co-movement against chance (shared/inference/
 * sessionEvidence.ts) rather than time online together, which on a busy
 * server made almost everyone look like a team. Replaces all previous
 * session evidence for the server in one go — it is a running state, not a
 * stream of events — then re-derives every pair's confidence under this
 * server's population prior.
 *
 * Returns the number of pairs that moved together at least once.
 */
export function buildSessionEvidence(
  db: DB,
  serverId: string,
  opts: { at?: string } = {},
): number {
  const at = opts.at ?? nowIso()
  const now = Date.parse(at)

  const srv = db.prepare(`SELECT last_seed_change FROM servers WHERE id = ?`)
    .get(serverId) as { last_seed_change: string | null } | undefined
  if (!srv) return 0
  const wipe = currentWipe(db, serverId)
  const starts = [srv.last_seed_change, wipe?.startedAt]
    .filter((s): s is string => !!s).map((s) => Date.parse(s)).filter(Number.isFinite)
  const since = starts.length ? Math.min(...starts) : 0

  // Open sessions end at the last poll we actually made, and that end is not
  // an observed logout.
  const poll = lastPoll(db, serverId)
  const openEnd = poll ? Math.min(now, Date.parse(poll.at)) : now

  const rows = db.prepare(
    `SELECT steam_id, joined_at, left_at, join_censored, leave_censored FROM sessions
      WHERE server_id = ? AND (left_at IS NULL OR left_at >= ?)`,
  ).all(serverId, new Date(since).toISOString()) as {
    steam_id: string; joined_at: string; left_at: string | null
    join_censored: number; leave_censored: number
  }[]

  const spans: SessionSpan[] = []
  for (const r of rows) {
    const join = Date.parse(r.joined_at)
    const leave = r.left_at ? Date.parse(r.left_at) : openEnd
    if (!(leave > join)) continue
    spans.push({
      player: r.steam_id,
      join,
      leave,
      // A session already running when the wipe started wasn't joined "this wipe".
      joinCensored: r.join_censored === 1 || join < since,
      leaveCensored: r.leave_censored === 1 || !r.left_at,
    })
  }

  const coverageMs = watchedMs(db, serverId, since, openEnd)
  const population = new Set(spans.map((s) => s.player)).size
  const prior = pairPriorLogOdds(population, teamLimit(db, serverId))
  const stats = spans.length ? coMovementStats(spans, { coverageMs: Math.max(coverageMs, 60_000) }) : []

  tx(db, () => {
    db.prepare(`DELETE FROM pair_evidence WHERE server_id = ? AND kind = 'session-overlap'`).run(serverId)
    const ins = db.prepare(
      `INSERT INTO pair_evidence (server_id, a_steam_id, b_steam_id, kind, log_odds, observed_at, note)
       VALUES (?, ?, ?, 'session-overlap', ?, ?, ?)`,
    )
    for (const st of stats) {
      // Pairs that met once by chance and got net-negative evidence carry no
      // information beyond the prior; storing them would just grow the table.
      if (st.logOdds <= 0) continue
      const ev = sessionEvidenceFrom(st, at)
      const [a, b] = pairKey(st.a, st.b)
      ins.run(serverId, a, b, ev.logOdds, at, ev.note ?? null)
    }
    db.prepare(
      `INSERT INTO server_state (server_id, key, value, updated_at) VALUES (?, 'pair_prior', ?, ?)
       ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(serverId, JSON.stringify(prior), at)
    db.prepare(
      `INSERT INTO server_state (server_id, key, value, updated_at) VALUES (?, 'session_evidence', ?, ?)
       ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(serverId, JSON.stringify({
      at, population, coverageHours: coverageMs / 3_600_000, pairs: stats.filter((x) => x.logOdds > 0).length,
    }), at)
  })
  refreshAllPairStates(db, serverId)
  return stats.filter((x) => x.logOdds > 0).length
}

/**
 * How long the collector was actually watching between `from` and `to`:
 * the sum of gaps between consecutive polls, ignoring gaps long enough to
 * mean it was down. Uses the poll log, plus session boundaries for data
 * recorded before the poll log existed.
 */
export function watchedMs(db: DB, serverId: string, from: number, to: number): number {
  const f = new Date(from).toISOString()
  const t = new Date(to).toISOString()
  const times = (db.prepare(
    `SELECT at AS x FROM collector_polls WHERE server_id = ? AND at BETWEEN ? AND ?
      UNION SELECT joined_at FROM sessions WHERE server_id = ? AND joined_at BETWEEN ? AND ?
      UNION SELECT left_at FROM sessions WHERE server_id = ? AND left_at BETWEEN ? AND ?
      ORDER BY x`,
  ).all(serverId, f, t, serverId, f, t, serverId, f, t) as { x: string }[]).map((r) => Date.parse(r.x))
  let total = 0
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1]
    if (d <= POLL_GAP_MS) total += d
  }
  return total
}

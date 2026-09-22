// ---------------------------------------------------------------------------
// In-game command surface.
//
// Rust+ lets us read AND write team chat, so the team can query NABRust
// without alt-tabbing — which matters when the alternative is dying while
// reading a dashboard.
//
// Two constraints shape every reply:
//   * chat lines are short, so answers are terse and anything long becomes a
//     "see dashboard" pointer
//   * sendTeamMessage is rate limited, so one command produces ONE message
// ---------------------------------------------------------------------------

import type { DB } from '../db/index.ts'
import { currentName, nameHistory, renameCount } from '../identity.ts'
import { currentWipe } from '../retention.ts'
import { getPairConfidence } from '../pairs.ts'
import { formatGameTime, isNight, minutesUntil, type AppTime } from './messages.ts'
import { normToGrid } from '../../../shared/world.ts'

export interface CommandContext {
  db: DB
  serverId: string
  /** Last known in-game time, refreshed by the poller. */
  time?: AppTime
  /** Steam id of whoever sent the message. */
  senderId: string
  /** Sender's current position, normalised, when known. */
  senderPos?: { x: number; y: number }
  worldSize: number
  dashboardUrl?: string
}

export const PREFIX = '/nab'

export function isCommand(message: string): boolean {
  return message.trim().toLowerCase().startsWith(PREFIX)
}

export function handleCommand(ctx: CommandContext, message: string): string | null {
  if (!isCommand(message)) return null

  const parts = message.trim().slice(PREFIX.length).trim().split(/\s+/).filter(Boolean)
  const cmd = (parts.shift() ?? 'help').toLowerCase()
  const rest = parts.join(' ')

  switch (cmd) {
    case 'help':
      return 'NAB: who <name> | clan <name> | time | base <label> | threat | stats'

    case 'time':
      return timeReply(ctx)

    case 'who':
      return whoReply(ctx, rest)

    case 'clan':
      return clanReply(ctx, rest)

    case 'threat':
      return threatReply(ctx)

    case 'base':
      return markBase(ctx, rest)

    case 'stats':
      return statsReply(ctx)

    default:
      return `NAB: unknown command "${cmd}" — try ${PREFIX} help`
  }
}

function timeReply(ctx: CommandContext): string {
  if (!ctx.time) return 'NAB: no time yet — Rust+ still syncing'
  const t = ctx.time
  const now = formatGameTime(t.time)
  if (isNight(t)) {
    const mins = minutesUntil(t, t.sunrise)
    return `NAB: ${now}, night — sunrise in ~${Math.round(mins)}m`
  }
  const mins = minutesUntil(t, t.sunset)
  return `NAB: ${now}, day — nightfall in ~${Math.round(mins)}m`
}

function findPlayer(ctx: CommandContext, query: string): string | null {
  if (!query) return null
  if (/^\d{17}$/.test(query)) return query
  const row = ctx.db
    .prepare(
      `SELECT steam_id FROM player_names
        WHERE name LIKE ? COLLATE NOCASE
        ORDER BY (last_seen IS NULL) DESC, first_seen DESC LIMIT 1`,
    )
    .get(`%${query}%`) as { steam_id: string } | undefined
  return row?.steam_id ?? null
}

function whoReply(ctx: CommandContext, query: string): string {
  const id = findPlayer(ctx, query)
  if (!id) return `NAB: no player matching "${query}"`

  const p = ctx.db
    .prepare(`SELECT hours_played, vac_bans, game_bans FROM players WHERE steam_id = ?`)
    .get(id) as { hours_played: number | null; vac_bans: number; game_bans: number } | undefined

  const name = currentName(ctx.db, id) ?? id.slice(-5)
  const bits: string[] = [name]

  if (p?.hours_played) bits.push(`${Math.round(p.hours_played).toLocaleString()}h`)
  else bits.push('hrs private')

  const renames = renameCount(ctx.db, id)
  if (renames > 0) {
    const prev = nameHistory(ctx.db, id).find((n) => n.last_seen !== null)
    bits.push(`aka ${prev?.name ?? '?'}${renames > 1 ? ` +${renames - 1}` : ''}`)
  }
  if (p && (p.vac_bans || p.game_bans)) bits.push(`${p.vac_bans + p.game_bans} bans`)

  // Who they run with — the part you actually want before a fight.
  const mates = ctx.db
    .prepare(
      `SELECT CASE WHEN a_steam_id = ? THEN b_steam_id ELSE a_steam_id END AS other, confidence
         FROM pair_state
        WHERE server_id = ? AND (a_steam_id = ? OR b_steam_id = ?) AND confidence >= 0.6
        ORDER BY confidence DESC LIMIT 3`,
    )
    .all(id, ctx.serverId, id, id) as { other: string; confidence: number }[]

  if (mates.length) {
    const names = mates.map((m) => `${currentName(ctx.db, m.other) ?? '?'} ${Math.round(m.confidence * 100)}%`)
    bits.push(`runs with ${names.join(', ')}`)
  } else {
    bits.push('no confirmed team')
  }

  return `NAB: ${bits.join(' · ')}`
}

function clanReply(ctx: CommandContext, query: string): string {
  const row = ctx.db
    .prepare(
      `SELECT id, label FROM clans WHERE server_id = ? AND label LIKE ? COLLATE NOCASE LIMIT 1`,
    )
    .get(ctx.serverId, `%${query}%`) as { id: string; label: string } | undefined
  if (!row) return `NAB: no roster matching "${query}"`

  const members = ctx.db
    .prepare(
      `SELECT steam_id, confidence FROM clan_members WHERE clan_id = ?
        ORDER BY confidence DESC LIMIT 6`,
    )
    .all(row.id) as { steam_id: string; confidence: number }[]

  const names = members.map((m) => currentName(ctx.db, m.steam_id) ?? '?')
  return `NAB: ${row.label} (${members.length}) — ${names.join(', ')}`
}

function threatReply(ctx: CommandContext): string {
  const rows = ctx.db
    .prepare(
      `SELECT c.label, COUNT(cm.steam_id) AS n
         FROM clans c JOIN clan_members cm ON cm.clan_id = c.id
        WHERE c.server_id = ? GROUP BY c.id ORDER BY n DESC LIMIT 3`,
    )
    .all(ctx.serverId) as { label: string; n: number }[]
  if (!rows.length) return 'NAB: no rosters resolved yet — needs more session history'
  return `NAB: top groups — ${rows.map((r) => `${r.label} (${r.n})`).join(', ')}`
}

/**
 * Mark a base at the sender's current position. The in-game map note is the
 * preferred route since it needs no typing, but this exists for the times
 * someone wants to attach a label from chat.
 */
function markBase(ctx: CommandContext, label: string): string {
  if (!ctx.senderPos) return 'NAB: position unknown — Rust+ has not reported you yet'
  const wipe = currentWipe(ctx.db, ctx.serverId)
  if (!wipe) return 'NAB: no open wipe'

  const grid = normToGrid(ctx.senderPos, ctx.worldSize)
  const id = `chat:${wipe.id}:${grid}:${Date.now()}`
  const at = new Date().toISOString()

  ctx.db.prepare(
    `INSERT INTO bases (id, wipe_id, x, y, grid, status, layout_confidence,
                        last_evidence_at, reported_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'confirmed', 0.6, ?, ?, ?)`,
  ).run(id, wipe.id, ctx.senderPos.x, ctx.senderPos.y, grid, at,
    currentName(ctx.db, ctx.senderId) ?? ctx.senderId, at)

  ctx.db.prepare(
    `INSERT INTO base_observations (base_id, kind, at, reporter, note)
     VALUES (?, 'sighting', ?, ?, ?)`,
  ).run(id, at, ctx.senderId, label || null)

  return `NAB: base marked at ${grid}${label ? ` — ${label}` : ''}`
}

function statsReply(ctx: CommandContext): string {
  const players = ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM players`).get() as { n: number }
  const pairs = ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM pair_state WHERE server_id = ? AND confidence >= 0.6`)
    .get(ctx.serverId) as { n: number }
  const bases = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM bases b JOIN wipes w ON w.id = b.wipe_id
        WHERE w.server_id = ? AND w.ended_at IS NULL`,
    )
    .get(ctx.serverId) as { n: number }
  return `NAB: ${players.n} players · ${pairs.n} confirmed pairs · ${bases.n} bases tracked`
}

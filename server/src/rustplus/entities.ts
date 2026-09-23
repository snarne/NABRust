// ---------------------------------------------------------------------------
// Paired Rust+ devices.
//
// A smart switch, smart alarm or storage monitor you pair in game becomes an
// entity id you can poll and (for switches) set. Nothing here touches the
// game client — it is the same companion API the official phone app uses, and
// the devices are ones you built and paired yourself.
//
// Two things make these worth having in an intel tool rather than a toy:
//
//   * a smart alarm on your own base is a raid alert, and it belongs in the
//     same live-events feed as cargo and heli;
//   * a storage monitor on a tool cupboard reports its protection window, so
//     upkeep becomes a number on the dashboard instead of a thing you forget.
// ---------------------------------------------------------------------------

import type { DB } from '../db/index.ts'
import { nowIso } from '../db/index.ts'
import type { AppEntityInfo, EntityKind } from './messages.ts'
import { itemName } from './items.ts'

export interface DeviceRow {
  entityId: number
  kind: EntityKind
  name: string | null
  value: boolean | null
  items: { itemId: number; quantity: number; isBlueprint: boolean }[]
  capacity: number | null
  protectionExpiry: string | null
  lastSeen: string | null
}

export class DeviceError extends Error {}

const KINDS: EntityKind[] = ['switch', 'alarm', 'storage']

export function addDevice(
  db: DB,
  serverId: string,
  wipeId: number,
  input: { entityId: number; kind: string; name?: string | null },
): void {
  if (!Number.isInteger(input.entityId) || input.entityId <= 0) {
    throw new DeviceError('entityId must be a positive integer')
  }
  if (!KINDS.includes(input.kind as EntityKind)) {
    throw new DeviceError(`kind must be one of ${KINDS.join(', ')}`)
  }
  const name = (input.name ?? '').trim().slice(0, 60) || null
  db.prepare(
    `INSERT INTO entities (server_id, wipe_id, entity_id, kind, name, paired_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (server_id, wipe_id, entity_id)
     DO UPDATE SET kind = excluded.kind, name = COALESCE(excluded.name, entities.name)`,
  ).run(serverId, wipeId, input.entityId, input.kind, name, nowIso())
}

export function removeDevice(db: DB, serverId: string, wipeId: number, entityId: number): boolean {
  const r = db.prepare(
    `DELETE FROM entities WHERE server_id = ? AND wipe_id = ? AND entity_id = ?`,
  ).run(serverId, wipeId, entityId)
  return Number(r.changes) > 0
}

export function listDevices(db: DB, serverId: string, wipeId: number | null): DeviceRow[] {
  if (wipeId === null) return []
  const rows = db.prepare(
    `SELECT entity_id, kind, name, value, items, capacity, protection_expiry, last_seen
       FROM entities WHERE server_id = ? AND wipe_id = ? ORDER BY kind, entity_id`,
  ).all(serverId, wipeId) as {
    entity_id: number; kind: string; name: string | null; value: number | null
    items: string | null; capacity: number | null; protection_expiry: string | null
    last_seen: string | null
  }[]
  return rows.map((r) => ({
    entityId: r.entity_id,
    kind: r.kind as EntityKind,
    name: r.name,
    value: r.value === null ? null : r.value === 1,
    items: parseItems(r.items),
    capacity: r.capacity,
    protectionExpiry: r.protection_expiry,
    lastSeen: r.last_seen,
  }))
}

function parseItems(json: string | null): DeviceRow['items'] {
  if (!json) return []
  try {
    const v = JSON.parse(json) as DeviceRow['items']
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

/**
 * Record what a device reported. Returns whether an alarm went from quiet to
 * triggered, which is the only state change worth waking someone for.
 */
export function recordDeviceState(
  db: DB,
  serverId: string,
  wipeId: number,
  entityId: number,
  info: AppEntityInfo,
  at = nowIso(),
): { alarmTriggered: boolean; row: DeviceRow | null } {
  const before = db.prepare(
    `SELECT value, kind FROM entities WHERE server_id = ? AND wipe_id = ? AND entity_id = ?`,
  ).get(serverId, wipeId, entityId) as { value: number | null; kind: string } | undefined
  if (!before) return { alarmTriggered: false, row: null }

  // A device that reports its own type is more trustworthy than what was
  // typed in when it was added.
  const kind = info.kind ?? (before.kind as EntityKind)
  const expiry = info.protectionExpiry > 0
    ? new Date(info.protectionExpiry * 1000).toISOString()
    : null

  db.prepare(
    `UPDATE entities SET kind = ?, value = ?, items = ?, capacity = ?,
            protection_expiry = ?, last_seen = ?
      WHERE server_id = ? AND wipe_id = ? AND entity_id = ?`,
  ).run(
    kind, info.value ? 1 : 0, info.items.length ? JSON.stringify(info.items) : null,
    info.capacity || null, expiry, at, serverId, wipeId, entityId,
  )

  const alarmTriggered = kind === 'alarm' && info.value && before.value !== 1
  const row = listDevices(db, serverId, wipeId).find((d) => d.entityId === entityId) ?? null
  return { alarmTriggered, row }
}

/** "front door alarm" / "alarm #1234" — whatever the device can be called. */
export function deviceLabel(row: { name: string | null; kind: EntityKind; entityId: number }): string {
  return row.name ?? `${row.kind} #${row.entityId}`
}

/**
 * Upkeep, in the words a player uses. A tool cupboard monitor reports the
 * items inside and when protection runs out.
 */
export function upkeepSummary(row: DeviceRow, now = Date.now()): string | null {
  if (row.kind !== 'storage' || !row.protectionExpiry) return null
  const left = Date.parse(row.protectionExpiry) - now
  if (!Number.isFinite(left)) return null
  if (left <= 0) return 'upkeep ran out — the base is decaying'
  const hours = left / 3_600_000
  return hours >= 48
    ? `${Math.round(hours / 24)} days of upkeep left`
    : `${Math.round(hours)} h of upkeep left`
}

/** Contents in readable form: "12,400 wood · 3,200 stones · 900 item #123". */
export function contentsSummary(row: DeviceRow, max = 4): string | null {
  if (!row.items.length) return null
  return [...row.items]
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, max)
    .map((i) => `${i.quantity.toLocaleString()} ${itemName(i.itemId)}`)
    .join(' · ')
}

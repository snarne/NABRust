import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export type DB = DatabaseSync

export const SCHEMA_VERSION = '1'

/**
 * WAL is the right mode for a service that reads while the collector writes,
 * but it needs filesystem locking that network shares and some mounted volumes
 * don't provide — there it fails with "disk I/O error". Fall back rather than
 * refusing to start, and say which mode we ended up in.
 */
function setJournalMode(db: DB): 'wal' | 'delete' {
  try {
    const row = db.prepare(`PRAGMA journal_mode = WAL`).get() as
      { journal_mode?: string } | undefined
    if (row?.journal_mode?.toLowerCase() === 'wal') {
      // WAL can report success and still fail on first write; force one.
      db.exec(`CREATE TABLE IF NOT EXISTS _wal_probe (x INTEGER)`)
      db.exec(`DROP TABLE IF EXISTS _wal_probe`)
      return 'wal'
    }
  } catch {
    // fall through
  }
  db.prepare(`PRAGMA journal_mode = DELETE`).get()
  return 'delete'
}

export function openDb(path: string, opts: { quiet?: boolean } = {}): DB {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
  const db = new DatabaseSync(path)

  const mode = setJournalMode(db)
  if (mode === 'delete' && !opts.quiet && path !== ':memory:') {
    console.warn(
      'sqlite: WAL unavailable on this filesystem, using rollback journal. ' +
      'Fine for a single process; move the db to a local disk for concurrent access.',
    )
  }

  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'))
  migrate(db, opts.quiet === true)
  db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SCHEMA_VERSION)
  return db
}

/**
 * Additive migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` in schema.sql does nothing to a table that
 * already exists, so new columns have to be added explicitly. Each entry is
 * applied only when the column is missing, which makes this safe to run on
 * every open and safe to re-run.
 *
 * Columns only — never drops or rewrites. A destructive change gets a real
 * versioned migration, because the data here cannot be re-collected.
 */
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: 'servers', column: 'rustplus_host', ddl: 'TEXT' },
  { table: 'servers', column: 'rustplus_port', ddl: 'INTEGER' },
  { table: 'servers', column: 'rustplus_player_id', ddl: 'TEXT' },
  { table: 'servers', column: 'rustplus_token', ddl: 'INTEGER' },
  { table: 'servers', column: 'map_page_url', ddl: 'TEXT' },
  { table: 'servers', column: 'map_image_url', ddl: 'TEXT' },
  { table: 'servers', column: 'map_file_url', ddl: 'TEXT' },
  { table: 'servers', column: 'monument_count', ddl: 'INTEGER' },
  { table: 'servers', column: 'next_wipe_at', ddl: 'TEXT' },
  { table: 'servers', column: 'last_seed_change', ddl: 'TEXT' },
  { table: 'servers', column: 'map_world_path', ddl: 'TEXT' },
  { table: 'encounters', column: 'victim_id', ddl: 'TEXT' },
  { table: 'encounters', column: 'death_x', ddl: 'REAL' },
  { table: 'encounters', column: 'death_y', ddl: 'REAL' },
  { table: 'bases', column: 'ours', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'bases', column: 'raid_path', ddl: 'TEXT' },
  { table: 'bases', column: 'note', ddl: 'TEXT' },
  { table: 'servers', column: 'team_limit', ddl: 'INTEGER' },
  { table: 'sessions', column: 'join_censored', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'sessions', column: 'leave_censored', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'monuments', column: 'prefab_id', ddl: 'INTEGER' },
  { table: 'monuments', column: 'height', ddl: 'REAL' },
  { table: 'monuments', column: 'radius', ddl: 'REAL' },
]

/**
 * Pull one CREATE TABLE statement out of schema.sql so the rebuild below uses
 * the same definition as a fresh install — schema.sql stays the single source
 * of truth. Line comments are stripped first so a `--` containing a bracket
 * can't throw off the paren matching.
 */
function extractCreateTable(sql: string, table: string): string | null {
  const stripped = sql.replace(/--[^\n]*/g, '')
  const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(`, 'i')
  const m = re.exec(stripped)
  if (!m) return null

  let i = m.index + m[0].length
  let depth = 1
  while (i < stripped.length && depth > 0) {
    const c = stripped[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    i++
  }
  return depth === 0 ? stripped.slice(m.index, i) : null
}

/**
 * Rebuild a table whose definition can't be patched with ADD COLUMN.
 *
 * SQLite cannot alter or drop a CHECK constraint in place, so a table carrying
 * an outdated one has to be recreated: build the new table, copy the columns
 * both versions share, drop the old, rename. Foreign keys are disabled for the
 * swap — other tables reference `servers` by name, and that name is restored
 * before they're re-enabled.
 *
 * `needsRebuild` inspects the stored DDL, so this runs once and then never
 * again.
 */
function rebuildTable(
  db: DB,
  table: string,
  needsRebuild: (existingDdl: string) => boolean,
  quiet: boolean,
): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined
  if (!row?.sql || !needsRebuild(row.sql)) return false

  const canonical = extractCreateTable(readFileSync(join(here, 'schema.sql'), 'utf8'), table)
  if (!canonical) throw new Error(`cannot rebuild ${table}: no definition in schema.sql`)

  const before = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const tmp = `${table}__rebuild`

  // Copy only columns present in BOTH definitions, so a dropped column can't
  // break the copy and a new one simply starts null.
  const oldCols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name)

  db.exec(`PRAGMA foreign_keys = OFF`)
  db.exec('BEGIN')
  try {
    db.exec(canonical.replace(
      new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}`, 'i'),
      `CREATE TABLE ${tmp}`,
    ))
    const newCols = (db.prepare(`PRAGMA table_info(${tmp})`).all() as { name: string }[])
      .map((c) => c.name)
    const shared = oldCols.filter((c) => newCols.includes(c))
    const list = shared.map((c) => `"${c}"`).join(', ')

    db.exec(`INSERT INTO ${tmp} (${list}) SELECT ${list} FROM ${table}`)
    db.exec(`DROP TABLE ${table}`)
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    db.exec(`PRAGMA foreign_keys = ON`)
    throw e
  }
  db.exec(`PRAGMA foreign_keys = ON`)

  const after = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  if (after !== before) {
    throw new Error(`rebuild of ${table} lost rows: ${before} -> ${after}`)
  }
  if (!quiet) console.log(`db: rebuilt ${table} (${after} rows preserved)`)
  return true
}

export function migrate(db: DB, quiet = false): string[] {
  const applied: string[] = []
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[]
    if (cols.length === 0) continue // table not created yet
    if (cols.some((c) => c.name === m.column)) continue
    db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`)
    applied.push(`${m.table}.${m.column}`)
  }
  if (applied.length && !quiet) {
    console.log(`db: added ${applied.length} column(s): ${applied.join(', ')}`)
  }
  if (applied.includes('sessions.join_censored')) {
    const n = backfillSessionCensoring(db)
    if (n && !quiet) console.log(`db: marked ${n} session edge(s) as unobserved`)
  }

  // Older databases constrain map_source to a fixed list, which rejects every
  // source added since. The constraint is gone from schema.sql; drop it here.
  if (rebuildTable(db, 'servers', (ddl) => /CHECK\s*\(\s*map_source/i.test(ddl), quiet)) {
    applied.push('servers (rebuilt)')
  }
  // Same story for game_events: the old CHECK rejected 'explosion' and the
  // table lacked the marker columns the event tracker needs.
  if (rebuildTable(db, 'game_events', (ddl) => /CHECK\s*\(\s*kind\s+IN/i.test(ddl), quiet)) {
    applied.push('game_events (rebuilt)')
  }
  // Indexes on columns a migration may have just added. They can't live in
  // schema.sql, which runs before the columns exist on an old database.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_open ON game_events(wipe_id) WHERE ended_at IS NULL`)

  return applied
}

/** Gap between polls beyond which the collector is taken to have been down. */
export const POLL_GAP_MS = 10 * 60_000

/**
 * One-time repair for sessions recorded before censoring was tracked.
 *
 * The collector never logged its polls, but on a populated server nearly
 * every poll opens or closes someone's session, so the distinct session
 * boundaries recover the poll timeline. After each gap in it — including the
 * very first poll — joins weren't seen happen; before each gap, leaves were
 * the collector stopping, not the player.
 */
export function backfillSessionCensoring(db: DB): number {
  let changed = 0
  const servers = db.prepare(`SELECT DISTINCT server_id FROM sessions`).all() as { server_id: string }[]
  for (const { server_id } of servers) {
    const times = (db.prepare(
      `SELECT joined_at AS t FROM sessions WHERE server_id = ?
        UNION SELECT left_at FROM sessions WHERE server_id = ? AND left_at IS NOT NULL
        ORDER BY t`,
    ).all(server_id, server_id) as { t: string }[]).map((r) => r.t)
    if (!times.length) continue
    const startsAfterGap = new Set<string>([times[0]])
    const endsBeforeGap = new Set<string>()
    for (let i = 1; i < times.length; i++) {
      if (Date.parse(times[i]) - Date.parse(times[i - 1]) > POLL_GAP_MS) {
        startsAfterGap.add(times[i])
        endsBeforeGap.add(times[i - 1])
      }
    }
    const markJoin = db.prepare(`UPDATE sessions SET join_censored = 1 WHERE server_id = ? AND joined_at = ?`)
    const markLeave = db.prepare(`UPDATE sessions SET leave_censored = 1 WHERE server_id = ? AND left_at = ?`)
    for (const t of startsAfterGap) changed += Number(markJoin.run(server_id, t).changes)
    for (const t of endsBeforeGap) changed += Number(markLeave.run(server_id, t).changes)
  }
  return changed
}

/** Upsert one JSON value into server_state. */
export function setServerState(db: DB, serverId: string, key: string, value: unknown, at = nowIso()): void {
  db.prepare(
    `INSERT INTO server_state (server_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(serverId, key, JSON.stringify(value), at)
}

export function getServerState<T>(db: DB, serverId: string, key: string): { value: T; updatedAt: string } | null {
  const row = db.prepare(`SELECT value, updated_at FROM server_state WHERE server_id = ? AND key = ?`)
    .get(serverId, key) as { value: string; updated_at: string } | undefined
  if (!row) return null
  try { return { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } } catch { return null }
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** Canonical pair ordering — the schema enforces a < b. */
export function pairKey(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x]
}

/** Run fn inside a transaction, rolling back on throw. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

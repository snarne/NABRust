-- ===========================================================================
-- NABRust schema
--
-- Two rules shape everything here:
--
--   IDENTITY  Every row that refers to a person keys on the 64-bit Steam ID.
--             Display names live in player_names as time-ranged records, so a
--             rename never orphans history — it appends.
--
--   SCOPE     Rows are scoped to (server_id, wipe_id) unless they belong to
--             the permanent tier. Retention moves data between tiers on wipe
--             rollover; see retention.ts.
--
-- Tiers:
--   HOT   current wipe, full fidelity       (combat_events, position_samples)
--   WARM  recent wipes, downsampled         (encounter_summary, session_daily)
--   COLD  permanent, per-identity rollups   (players, rival_stats, clans…)
-- ===========================================================================

-- journal_mode is set from index.ts, which falls back when the filesystem
-- cannot support WAL (network shares, some mounted volumes).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- IDENTITY (cold — never cleared by a wipe)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS players (
  steam_id           TEXT PRIMARY KEY,
  first_seen         TEXT NOT NULL,
  last_seen          TEXT,
  -- Steam Web API; null when the profile is private, which is common.
  hours_played       INTEGER,
  account_created_at TEXT,
  vac_bans           INTEGER NOT NULL DEFAULT 0,
  game_bans          INTEGER NOT NULL DEFAULT 0,
  profile_public     INTEGER NOT NULL DEFAULT 0,
  profile_fetched_at TEXT
);

-- A name is a property of an identity with a validity window.
-- last_seen NULL means "current".
CREATE TABLE IF NOT EXISTS player_names (
  steam_id   TEXT NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT,
  source     TEXT NOT NULL CHECK (source IN ('combatlog','battlemetrics','steam','manual')),
  PRIMARY KEY (steam_id, name, first_seen)
);
CREATE INDEX IF NOT EXISTS idx_names_current ON player_names(steam_id) WHERE last_seen IS NULL;
CREATE INDEX IF NOT EXISTS idx_names_lookup  ON player_names(name);

-- ---------------------------------------------------------------------------
-- SERVERS AND WIPES
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS servers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  battlemetrics_id  TEXT UNIQUE,
  max_pop           INTEGER,
  -- Null until read from the server browser or Rust+.
  seed              INTEGER,
  world_size        INTEGER,
  -- Rust+ pairing. playerToken is an int32 and is frequently NEGATIVE.
  rustplus_paired    INTEGER NOT NULL DEFAULT 0,
  rustplus_host      TEXT,
  rustplus_port      INTEGER,
  rustplus_player_id TEXT,
  rustplus_token     INTEGER,
  -- Local path of the map image, once Rust+ or the parser has produced one.
  map_image_path    TEXT,
  -- Local path of the downloaded .map world file the render was made from.
  -- The terrain endpoint re-reads it for the shooter solver.
  map_world_path    TEXT,
  -- No CHECK here on purpose: the set of map sources grows as we add ways to
  -- obtain a map, and SQLite cannot alter a CHECK constraint in place — every
  -- new value would force a full table rebuild. The TypeScript MapSource union
  -- is the real guard.
  map_source        TEXT,
  map_parsed_at     TEXT,
  -- From Battlemetrics details.rust_maps: a rendered map for this seed plus
  -- the actual .map world file, both available without Rust+ pairing.
  map_page_url      TEXT,
  map_image_url     TEXT,
  map_file_url      TEXT,
  monument_count    INTEGER,
  -- Wipe schedule, so a wipe can be anticipated rather than only detected.
  next_wipe_at      TEXT,
  last_seed_change  TEXT,
  -- Max team size (1 solo, 2 duo, 3 trio...). Caps inferred rosters and sets
  -- the base rate for "these two are teammates". Null = infer from the name.
  team_limit        INTEGER,
  created_at        TEXT NOT NULL
);

-- A wipe is the unit of scope. Detected from seed change or Rust+ uptime.
CREATE TABLE IF NOT EXISTS wipes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  seed       INTEGER,
  world_size INTEGER,
  tier       TEXT NOT NULL DEFAULT 'hot' CHECK (tier IN ('hot','warm','cold')),
  UNIQUE (server_id, started_at)
);
CREATE INDEX IF NOT EXISTS idx_wipes_current ON wipes(server_id) WHERE ended_at IS NULL;

-- Seed-derived spatial data, parsed from the server's own .map world file.
-- Cleared on wipe: a new seed is a new world.
CREATE TABLE IF NOT EXISTS monuments (
  wipe_id INTEGER NOT NULL REFERENCES wipes(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  x       REAL NOT NULL,          -- normalised 0..1
  y       REAL NOT NULL,
  -- StringPool id from the world file. Constant for a given monument across
  -- every map and every wipe, so it is the join key once a manifest lets us
  -- put real names to these.
  prefab_id INTEGER,
  height    REAL,                 -- ground elevation, metres
  radius    REAL,                 -- equivalent-circle radius of the footprint
  PRIMARY KEY (wipe_id, name, x, y)
);

CREATE TABLE IF NOT EXISTS ore_density (
  wipe_id  INTEGER NOT NULL REFERENCES wipes(id) ON DELETE CASCADE,
  resource TEXT NOT NULL CHECK (resource IN ('sulfur','metal','stone')),
  x        REAL NOT NULL,
  y        REAL NOT NULL,
  radius   REAL NOT NULL,
  weight   REAL NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
-- SESSIONS (hot raw -> warm daily aggregate)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  wipe_id   INTEGER REFERENCES wipes(id) ON DELETE SET NULL,
  steam_id  TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at   TEXT,
  source    TEXT NOT NULL DEFAULT 'battlemetrics',
  -- 1 when the moment wasn't actually observed: already online at the first
  -- poll after the collector (re)started, or cut short when it stopped.
  -- Teammate detection scores joins and leaves, so an unobserved one must
  -- not count — or everyone online at start-up "joined together".
  join_censored  INTEGER NOT NULL DEFAULT 0,
  leave_censored INTEGER NOT NULL DEFAULT 0,
  UNIQUE (server_id, steam_id, joined_at)
);

-- Every successful Battlemetrics poll. Tells teammate detection how long the
-- server was actually being watched, which sets how often a coincidental
-- "joined together" would happen.
CREATE TABLE IF NOT EXISTS collector_polls (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  at        TEXT NOT NULL,
  online    INTEGER NOT NULL,
  PRIMARY KEY (server_id, at)
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(steam_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_sessions_open   ON sessions(server_id) WHERE left_at IS NULL;

-- Warm tier: raw sessions collapse into this and are deleted.
CREATE TABLE IF NOT EXISTS session_daily (
  server_id TEXT NOT NULL,
  steam_id  TEXT NOT NULL,
  day       TEXT NOT NULL,           -- YYYY-MM-DD
  minutes   INTEGER NOT NULL,
  sessions  INTEGER NOT NULL,
  PRIMARY KEY (server_id, steam_id, day)
);

-- ---------------------------------------------------------------------------
-- COMBAT (hot raw -> warm summary)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS encounters (
  id               TEXT PRIMARY KEY,
  server_id        TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  wipe_id          INTEGER NOT NULL REFERENCES wipes(id) ON DELETE CASCADE,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  label            TEXT,
  outcome          TEXT CHECK (outcome IN ('won','died','disengaged')),
  parties_detected INTEGER NOT NULL DEFAULT 1,
  -- Set on Rust+ death shells: who died and where, at the moment it happened.
  victim_id        TEXT,
  death_x          REAL,
  death_y          REAL
);
CREATE INDEX IF NOT EXISTS idx_encounters_wipe ON encounters(wipe_id, started_at);

CREATE TABLE IF NOT EXISTS combat_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id  TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  t_server      REAL NOT NULL,        -- seconds since server start (log clock)
  attacker_id   TEXT,                 -- null for environment damage
  target_id     TEXT NOT NULL,
  weapon        TEXT,
  ammo          TEXT,
  area          TEXT,
  distance      REAL,
  damage        REAL NOT NULL,
  hp_before     REAL,
  hp_after      REAL,
  third_party   INTEGER NOT NULL DEFAULT 0,
  -- which teammate's agent reported this, for dedupe across agents
  reporter_id   TEXT NOT NULL,
  UNIQUE (encounter_id, t_server, attacker_id, target_id, damage, reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_combat_attacker ON combat_events(attacker_id);
CREATE INDEX IF NOT EXISTS idx_combat_target   ON combat_events(target_id);

-- Warm tier: per-encounter, per-attacker rollup; raw events are then dropped.
CREATE TABLE IF NOT EXISTS encounter_summary (
  encounter_id TEXT NOT NULL,
  steam_id     TEXT NOT NULL,
  hits         INTEGER NOT NULL,
  damage       REAL NOT NULL,
  headshots    INTEGER NOT NULL,
  avg_distance REAL,
  weapons      TEXT,                  -- JSON array
  PRIMARY KEY (encounter_id, steam_id)
);

-- ---------------------------------------------------------------------------
-- TEAM INFERENCE
-- ---------------------------------------------------------------------------

-- Append-only evidence log. a < b enforced so a pair has one canonical row set.
CREATE TABLE IF NOT EXISTS pair_evidence (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    TEXT NOT NULL,
  a_steam_id   TEXT NOT NULL,
  b_steam_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'session-overlap','co-onset','distance-correlation',
                 'hp-accounting','gear-tier','manual-label')),
  log_odds     REAL NOT NULL,
  observed_at  TEXT NOT NULL,
  note         TEXT,
  encounter_id TEXT REFERENCES encounters(id) ON DELETE SET NULL,
  CHECK (a_steam_id < b_steam_id)
);
CREATE INDEX IF NOT EXISTS idx_pair_evidence ON pair_evidence(server_id, a_steam_id, b_steam_id);

-- Materialised sum so the graph doesn't need a full replay on every read.
CREATE TABLE IF NOT EXISTS pair_state (
  server_id     TEXT NOT NULL,
  a_steam_id    TEXT NOT NULL,
  b_steam_id    TEXT NOT NULL,
  log_odds      REAL NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  confidence    REAL NOT NULL,        -- calibrated 0..1
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (server_id, a_steam_id, b_steam_id),
  CHECK (a_steam_id < b_steam_id)
);

CREATE TABLE IF NOT EXISTS clans (
  id         TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  threat     REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clan_members (
  clan_id    TEXT NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  steam_id   TEXT NOT NULL,
  confidence REAL NOT NULL,
  core       INTEGER NOT NULL DEFAULT 0,
  -- 'manual' memberships outrank inference and are never silently overwritten.
  source     TEXT NOT NULL DEFAULT 'inferred' CHECK (source IN ('inferred','manual')),
  PRIMARY KEY (clan_id, steam_id)
);

-- ---------------------------------------------------------------------------
-- SPATIAL
-- ---------------------------------------------------------------------------

-- Hot only. Deleted once the retraces that depend on them are computed —
-- this is the table that would otherwise dominate disk.
CREATE TABLE IF NOT EXISTS position_samples (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  wipe_id  INTEGER NOT NULL REFERENCES wipes(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  t        TEXT NOT NULL,
  x        REAL NOT NULL,
  y        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pos ON position_samples(wipe_id, steam_id, t);

-- The conclusions we keep after position samples are purged.
CREATE TABLE IF NOT EXISTS localizations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  wipe_id      INTEGER NOT NULL REFERENCES wipes(id) ON DELETE CASCADE,
  encounter_id TEXT REFERENCES encounters(id) ON DELETE SET NULL,
  attacker_id  TEXT,
  kind         TEXT NOT NULL DEFAULT 'shooter' CHECK (kind IN ('shooter','turret')),
  best_x       REAL NOT NULL,
  best_y       REAL NOT NULL,
  sigma_m      REAL NOT NULL,
  fixes_used   INTEGER NOT NULL,
  computed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bases (
  id                TEXT PRIMARY KEY,
  wipe_id           INTEGER NOT NULL REFERENCES wipes(id) ON DELETE CASCADE,
  owner_steam_id    TEXT,
  owner_clan_id     TEXT REFERENCES clans(id) ON DELETE SET NULL,
  x                 REAL NOT NULL,
  y                 REAL NOT NULL,
  grid              TEXT,
  status            TEXT NOT NULL CHECK (status IN ('confirmed','inferred','weak')),
  layout_confidence REAL NOT NULL DEFAULT 0,
  turrets           INTEGER NOT NULL DEFAULT 0,
  tier              TEXT,
  last_evidence_at  TEXT NOT NULL,
  reported_by       TEXT,
  created_at        TEXT NOT NULL,
  -- 1 for our own base: drawn as HOME and never offered as a raid target.
  ours              INTEGER NOT NULL DEFAULT 0,
  -- What stands between the outside and the loot, as the team estimates it:
  -- JSON {"walls": {"stone": 2, ...}, "doors": {"sheet": 1, ...}}. Feeds the
  -- raid cost calculator.
  raid_path         TEXT,
  note              TEXT
);

CREATE TABLE IF NOT EXISTS base_observations (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id  TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('sighting','map-note','raided','destroyed','turret-fire')),
  at       TEXT NOT NULL,
  reporter TEXT,
  note     TEXT
);

-- ---------------------------------------------------------------------------
-- EVENTS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS game_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wipe_id     INTEGER NOT NULL REFERENCES wipes(id) ON DELETE CASCADE,
  -- No CHECK: the event vocabulary grows with the marker types we watch, and
  -- SQLite can't alter a CHECK in place. EventKind in rustplus/events.ts is the
  -- real guard.
  kind        TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  eta_at      TEXT,
  confidence  REAL NOT NULL DEFAULT 0.5,
  source      TEXT NOT NULL,
  label       TEXT,
  -- Rust+ marker id while the event is open; the marker vanishing ends it.
  marker_id   INTEGER,
  x           REAL,
  y           REAL,
  ended_at    TEXT,
  end_label   TEXT
);
-- idx_events_open is created in migrate(): it names a column older databases
-- only gain there, and schema.sql runs first.

-- ---------------------------------------------------------------------------
-- COLD ROLLUPS — permanent, survive every wipe
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rival_stats (
  self_id        TEXT NOT NULL,
  other_id       TEXT NOT NULL,
  encounters     INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  damage_dealt   REAL NOT NULL DEFAULT 0,
  damage_taken   REAL NOT NULL DEFAULT 0,
  headshots_taken INTEGER NOT NULL DEFAULT 0,
  avg_distance   REAL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (self_id, other_id)
);

CREATE TABLE IF NOT EXISTS player_skill (
  steam_id   TEXT PRIMARY KEY,
  rating     REAL NOT NULL,
  games      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Roster memory across wipes, with decay applied on rollover.
CREATE TABLE IF NOT EXISTS clan_memory (
  a_steam_id TEXT NOT NULL,
  b_steam_id TEXT NOT NULL,
  log_odds   REAL NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (a_steam_id, b_steam_id),
  CHECK (a_steam_id < b_steam_id)
);

-- ---------------------------------------------------------------------------
-- LIVE STATE (Rust+ derived, hot, overwritten in place)
-- ---------------------------------------------------------------------------

-- Small key/value for per-server live values: in-game time, population.
CREATE TABLE IF NOT EXISTS server_state (
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,             -- JSON
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, key)
);

-- Our OWN team only. Rust+ never exposes other players' positions.
CREATE TABLE IF NOT EXISTS team_state (
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  steam_id   TEXT NOT NULL,
  name       TEXT,
  x          REAL,
  y          REAL,
  alive      INTEGER NOT NULL DEFAULT 1,
  online     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, steam_id)
);

-- Pairing credentials from the in-game menu. Kept per server.
CREATE TABLE IF NOT EXISTS rustplus_credentials (
  server_id    TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  ip           TEXT NOT NULL,
  port         INTEGER NOT NULL,
  player_id    TEXT NOT NULL,
  player_token INTEGER NOT NULL,
  paired_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  reporter   TEXT,
  kind       TEXT NOT NULL,
  lines_in   INTEGER NOT NULL DEFAULT 0,
  rows_out   INTEGER NOT NULL DEFAULT 0,
  rejected   INTEGER NOT NULL DEFAULT 0,
  note       TEXT
);

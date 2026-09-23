// ---------------------------------------------------------------------------
// NABRust domain model.
//
// Identity rule: everything keys on the 64-bit Steam ID, never a display name.
// Names are a time-ranged property of an identity, so a rename never orphans
// history.
//
// Scope rule: every collection below is scoped to (server, wipe). Switching
// servers swaps the whole dataset, including the map.
// ---------------------------------------------------------------------------

export type SteamId = string

export type Confidence = number // 0..1

/** A display name observed during a validity window. */
export interface NameRecord {
  name: string
  firstSeen: string // ISO
  lastSeen: string | null // null = current
  source: 'combatlog' | 'battlemetrics' | 'steam' | 'manual'
}

/** One opponent, as seen from our side of the combat log. */
export interface PlayerCombat {
  encounters: number
  /** Times they killed one of us / we killed them. */
  killsOnUs: number
  deathsToUs: number
  /** Their hits on us. Misses aren't logged, so this is hit quality, not accuracy. */
  hitsOnUs: number
  headshotRate: number
  avgRangeMetres: number
  weapons: { weapon: string; hits: number }[]
  lastSeen: string | null
}

export interface Player {
  steamId: SteamId
  names: NameRecord[]
  /** Steam-derived, may be absent when the profile is private. */
  hoursPlayed: number | null
  accountAgeYears: number | null
  vacBans: number
  gameBans: number
  firstSeen: string
  /** Percentile against the CURRENT server population, not an absolute score. */
  threatPercentile: number
  /** Hours this player has been on this server this wipe. */
  serverHoursThisWipe: number
  online: boolean
  /** 7 x 4 activity buckets (weekday x 6h block), 0..3 intensity. */
  activity: number[][]
  inferredTimezone: string | null
  /**
   * What the threat percentile was built from, in words, so a number on the
   * screen can always be traced back to observations.
   */
  threatFactors?: { label: string; value: string }[]
  /** Everything our combat logs say about this player this wipe. */
  vsUs?: PlayerCombat | null
}

export type EvidenceKind =
  | 'session-overlap'
  | 'co-onset'
  | 'distance-correlation'
  | 'hp-accounting'
  | 'gear-tier'
  | 'manual-label'

/** One piece of evidence for/against two players being teammates. */
export interface PairEvidence {
  kind: EvidenceKind
  /** Positive log-odds support teammate, negative supports third-party. */
  logOdds: number
  at: string
  note?: string
}

export interface PairLink {
  a: SteamId
  b: SteamId
  evidence: PairEvidence[]
  /**
   * Posterior from the server, which knows this server's population prior.
   * Prefer it over recomputing from `evidence`, which can only use the
   * generic default prior.
   */
  confidence?: number
}

export interface Clan {
  id: string
  label: string
  members: { steamId: SteamId; confidence: Confidence; core: boolean }[]
  /** Derived from members' individual percentiles + concurrency. */
  threat: number
  activityWindow: string
  peakConcurrent: number
}

export type BodyArea = 'head' | 'chest' | 'stomach' | 'arm' | 'leg'

/** One damage event as the client combat log records it. */
export interface CombatEvent {
  t: number // seconds since server start
  attacker: SteamId | 'environment'
  target: SteamId
  weapon: string
  ammo: string | null
  area: BodyArea
  distance: number // metres
  damage: number
  hpBefore: number
  hpAfter: number
  /** Set by the HP-accounting pass when damage is unexplained. */
  thirdPartyFlag?: boolean
}

export interface Encounter {
  id: string
  server: string
  wipe: number
  label: string
  startedAt: string
  events: CombatEvent[]
  outcome: 'won' | 'died' | 'disengaged'
  partiesDetected: number
}

export interface Vec2 {
  x: number
  y: number
}

/**
 * A point in the game's own axes: x east, z north, y UP. Rust world files and
 * Unity use this; everything in the UI works in Vec2 where `y` means north, so
 * converting from a Vec3 means taking x and z, never x and y.
 */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/** A range measurement: attacker was `distance` from a known point. */
export interface RangeFix {
  from: Vec2 // your position at the moment of the hit (Rust+ derived)
  distance: number
  weight: number
  /** How far off `from` may be, metres — Rust+ samples every ~15 s. */
  errorMetres?: number
}

export interface Localization {
  best: Vec2
  /** Radius in metres containing ~68% of posterior mass. */
  sigma: number
  /** Probability field, row-major, for heat rendering. */
  field?: number[]
}

export type BaseStatus = 'confirmed' | 'inferred' | 'weak'

export type WallTier = 'wood' | 'stone' | 'metal' | 'armored'
export type DoorTier = 'wood' | 'sheet' | 'garage' | 'armored'

/** What stands between outside and the loot room, as the team estimates it. */
export interface RaidPath {
  walls: Partial<Record<WallTier, number>>
  doors: Partial<Record<DoorTier, number>>
}

export interface BaseRecord {
  id: string
  owner: string | null
  ownerClan: string | null
  grid: string
  /** Normalised 0..1 position on the world square. */
  pos: Vec2
  status: BaseStatus
  layoutConfidence: Confidence
  turrets: number
  tier: WallTier | 'unknown'
  lastEvidence: string
  reportedBy?: string
  ownerSteamId?: SteamId | null
  ownerClanId?: string | null
  /** Our own base — drawn as HOME, never a raid target. */
  ours?: boolean
  raidPath?: RaidPath | null
  note?: string | null
  observations?: number
}

/**
 * 'tier3' | 'safezone' | 'water' | 'small' are named monuments (Rust+ markers,
 * or a manifest lookup). 'large' | 'medium' | 'offshore' come from the world
 * file parser, which can MEASURE a monument's footprint but cannot name it
 * without the game's StringPool table.
 */
export type MonumentKind =
  | 'tier3' | 'safezone' | 'water' | 'small'
  | 'large' | 'medium' | 'offshore'

/**
 * Monuments are NOT hardcoded — they come from the parsed .map file for the
 * server's seed, or from Rust+ map markers.
 */
export interface Monument {
  name: string
  pos: Vec2 // normalised
  kind: MonumentKind
  /** Footprint radius, normalised to the world edge. Parsed monuments only. */
  radius?: number
  /** StringPool id — constant for a monument type across every map. */
  prefabId?: number
  /** Ground elevation in metres. */
  height?: number
  /** False when only the size is known, so the name is a measurement. */
  named?: boolean
}

/** A paired Rust+ device: smart switch, smart alarm or storage monitor. */
export interface DeviceRecord {
  entityId: number
  kind: 'switch' | 'alarm' | 'storage'
  name: string | null
  /** Switch/alarm state. null until the device has been read once. */
  value: boolean | null
  /** Storage monitor contents, already named. */
  contents: { name: string; quantity: number }[]
  capacity: number | null
  /** Human phrasing of the tool cupboard's remaining upkeep, when known. */
  upkeep: string | null
  protectionExpiry: string | null
  lastSeen: string | null
}

export interface ServerMapInfo {
  /** Rust+ getMap() JPEG, once paired and downloaded. */
  rustPlusImageUrl: string | null
  /** Rendered from the server's own .map world file by the NABRust parser. */
  parsedRenderUrl: string | null
  /** True once the parsed heightmap can be fetched for the shooter solver. */
  terrainAvailable?: boolean
  pairedWithRustPlus: boolean
  /** Populated by the map parser; empty until the seed has been parsed. */
  monuments: Monument[]
  /** Ore density blobs, also seed-derived. */
  oreDensity: { pos: Vec2; radius: number; resource: 'sulfur' | 'metal' | 'stone' }[]
  parsedAt: string | null
}

export interface ServerRecord {
  id: string
  name: string
  pop: number
  maxPop: number
  wipeDay: number
  /**
   * Median hours of the active population — scales the threat scale.
   * 'unknown' until the threat model has enough sessions to rate the server.
   */
  heat: 'casual' | 'moderate' | 'sweaty' | 'extreme' | 'unknown'
  /** Null until we've read it from the server browser or Rust+. */
  seed: number | null
  worldSize: number
  populationCurve: number[]
  map: ServerMapInfo
  /** A synthetic server from `nab simulate` — never real intel. */
  simulated?: boolean
  /** Max team size on this server, when known. */
  teamLimit?: number
}

export interface GameEvent {
  kind: 'cargo' | 'heli' | 'crate' | 'chinook' | 'explosion' | 'alarm'
  label: string
  /** Seconds remaining, derived from one observation + fixed duration. */
  etaSeconds: number
  confidence: Confidence
  source: 'observed' | 'rf-alarm' | 'inferred'
  /** Live events only: seconds since it appeared, and whether it has ended. */
  sinceSeconds?: number
  ended?: boolean
  pos?: Vec2
}

/**
 * One of our team's deaths, with the range measurements the retracer needs.
 * `fixes` is empty when there were no Rust+ positions around the time — the
 * death is still listed, but can't be localised.
 */
export interface DeathRecord {
  id: string
  at: string
  victim: SteamId
  grid: string | null
  pos: Vec2 | null
  killer: SteamId | null
  weapon: string | null
  distance: number | null
  headshot: boolean
  /** Hits from the killer, each paired with where the victim was at that moment. */
  fixes: RangeFix[]
  /** Metres of uncertainty in the victim positions behind the fixes. */
  positionErrorMetres: number | null
}

export interface RaidRoute {
  name: 'cheapest' | 'fastest' | 'quietest'
  expectedSulfur: number
  worstCaseSulfur: number
  wallsBreached: number
  description: string
  mix: { item: string; count: number }[]
}

export interface TeamMember {
  steamId?: SteamId
  name: string
  grid: string
  /** Null until Rust+ has seen them online this wipe. */
  pos: Vec2 | null
  alive: boolean
  online?: boolean
}

export interface AgentStatus {
  name: string
  host: string
  last: string
  online: boolean
}

/**
 * Everything the app shows for one server. Swapping servers swaps this whole
 * object — nothing from another server leaks through.
 */
export interface ServerDataset {
  server: ServerRecord
  players: Record<SteamId, Player>
  pairLinks: PairLink[]
  clans: Clan[]
  bases: BaseRecord[]
  liveEvents: GameEvent[]
  team: TeamMember[]
  encounter: Encounter | null
  homePos: Vec2 | null
  raidRoutes: RaidRoute[]
  candidateLayouts: { name: string; probability: number }[]
  /** Our own steam id on this server, when known. */
  self?: SteamId | null
  /** Our team — excluded from every threat list. */
  teamIds?: SteamId[]
  deaths?: DeathRecord[]
  /** Most recent first; `encounter` is the head of this list. */
  recentEncounters?: Encounter[]
  /** In-game clock from Rust+, if paired. */
  gameTime?: { time: number; sunrise: number; sunset: number; observedAt: string } | null
  /** Paired smart switches, alarms and storage monitors. */
  devices?: DeviceRecord[]
  /** Team chat as Rust+ saw it, oldest first. */
  teamChat?: { steamId: SteamId; name: string; message: string; at: string }[]
}

// ---------------------------------------------------------------------------
// Rust+ message encoding and decoding.
//
// Field numbers come from Facepunch's rustplus.proto (as published by the
// community libraries). Only the subset NABRust needs is implemented; unknown
// fields are skipped rather than erroring, so a game update that adds fields
// does not break the client.
//
// AppRequest {
//   uint32 seq = 1; uint64 playerId = 2; int32 playerToken = 3;
//   uint32 entityId = 4;
//   AppEmpty getInfo = 8; getTime = 9; getMap = 10; getTeamInfo = 11;
//   getTeamChat = 12; AppSendMessage sendTeamMessage = 13;
//   AppEmpty getEntityInfo = 14; AppSetEntityValue setEntityValue = 15;
//   AppEmpty checkSubscription = 16; AppFlag setSubscription = 17;
//   AppEmpty getMapMarkers = 18; AppEmpty getClanInfo = 21;
// }
// AppResponse { ... AppMapMarkers mapMarkers = 13; }
// AppMapMarkers { repeated AppMarker markers = 1; }
// AppMarker { uint32 id = 1; AppMarkerType type = 2; float x = 3; float y = 4;
//             uint64 steamId = 5; float rotation = 6; float radius = 7;
//             string name = 11; bool outOfStock = 12; }
// (verified against rustplus.proto, Sept 2026)
// AppMessage { AppResponse response = 1; AppBroadcast broadcast = 2; }
// ---------------------------------------------------------------------------

import {
  Reader, Writer, asBool, asInt32, asNumber, asString, type Field,
} from './protobuf.ts'

export type RequestKind =
  | 'getInfo' | 'getTime' | 'getMap' | 'getTeamInfo'
  | 'getTeamChat' | 'getMapMarkers' | 'sendTeamMessage'
  | 'getEntityInfo' | 'setEntityValue' | 'checkSubscription' | 'setSubscription'
  | 'getClanInfo'

const REQUEST_FIELD: Record<RequestKind, number> = {
  getInfo: 8,
  getTime: 9,
  getMap: 10,
  getTeamInfo: 11,
  getTeamChat: 12,
  sendTeamMessage: 13,
  getEntityInfo: 14,
  setEntityValue: 15,
  checkSubscription: 16,
  setSubscription: 17,
  getMapMarkers: 18,
  getClanInfo: 21,
}

/** AppEntityType. A paired device is exactly one of these. */
export const ENTITY_TYPE = { switch: 1, alarm: 2, storage: 3 } as const
export type EntityKind = keyof typeof ENTITY_TYPE

export function entityKindOf(type: number): EntityKind | null {
  return (Object.keys(ENTITY_TYPE) as EntityKind[]).find((k) => ENTITY_TYPE[k] === type) ?? null
}

export interface Credentials {
  playerId: bigint      // your 64-bit steam id
  playerToken: number   // int32, frequently NEGATIVE
}

export function encodeRequest(
  seq: number,
  cred: Credentials,
  kind: RequestKind,
  payload?: { message?: string; entityId?: number; value?: boolean },
): Uint8Array {
  const w = new Writer()
  w.uint32Always(1, seq)
  w.uint64(2, cred.playerId)
  w.int32(3, cred.playerToken)
  // Entity requests address one paired device; the id rides on the request
  // itself rather than inside the sub-message.
  if (payload?.entityId !== undefined) w.uint32Always(4, payload.entityId)

  const field = REQUEST_FIELD[kind]
  if (kind === 'sendTeamMessage') {
    w.message(field, (m) => m.string(1, payload?.message ?? ''))
  } else if (kind === 'setEntityValue' || kind === 'setSubscription') {
    w.message(field, (m) => m.bool(1, payload?.value ?? false))
  } else {
    w.empty(field) // AppEmpty
  }
  return w.finish()
}

// --- decoded shapes ---------------------------------------------------------

export interface AppInfo {
  name: string
  map: string
  mapSize: number
  wipeTime: number
  players: number
  maxPlayers: number
  queuedPlayers: number
  seed: number
  salt: number
  url: string
  headerImage: string
}

export interface AppTime {
  dayLengthMinutes: number
  timeScale: number
  sunrise: number
  sunset: number
  time: number
}

export interface TeamMember {
  steamId: string
  name: string
  x: number
  y: number
  isOnline: boolean
  spawnTime: number
  isAlive: boolean
  deathTime: number
}

export interface MapNote {
  type: number
  x: number
  y: number
  icon: number
  colourIndex: number
  label: string
}

export interface AppTeamInfo {
  leaderSteamId: string
  members: TeamMember[]
  mapNotes: MapNote[]
  leaderMapNotes: MapNote[]
}

export interface MapMonument {
  token: string
  x: number
  y: number
}

export interface AppMap {
  width: number
  height: number
  jpgImage: Uint8Array
  oceanMargin: number
  monuments: MapMonument[]
  background: string
}

export interface TeamMessage {
  steamId: string
  name: string
  message: string
  color: string
  time: number
}

/**
 * Server-wide map markers. Rust+ gives every paired player the same set:
 * cargo, patrol heli, Chinook, locked crates, explosions, vending machines —
 * plus Player markers for your OWN team only. It never exposes enemy players.
 */
export const MARKER_TYPE = {
  Player: 1,
  Explosion: 2,
  VendingMachine: 3,
  CH47: 4,
  CargoShip: 5,
  Crate: 6,
  GenericRadius: 7,
  PatrolHelicopter: 8,
} as const

export interface AppMarker {
  id: number
  type: number
  /** Metres from the map's bottom-left corner, like team positions. */
  x: number
  y: number
  steamId: string
  rotation: number
  radius: number
  name: string
  outOfStock: boolean
}

export interface EntityItem {
  itemId: number
  quantity: number
  isBlueprint: boolean
}

/**
 * State of one paired device.
 *
 * `value` is the switch/alarm state; storage monitors report contents. A tool
 * cupboard monitor also reports its protection window, which is how upkeep
 * shows up here.
 */
export interface AppEntityInfo {
  type: number
  kind: EntityKind | null
  value: boolean
  items: EntityItem[]
  capacity: number
  hasProtection: boolean
  /** Unix seconds when protection runs out; 0 when not reported. */
  protectionExpiry: number
}

export interface AppResponse {
  seq: number
  /** Your own server-side clan, when the server runs clans. */
  clanInfo?: { name: string; members: number }
  entityInfo?: AppEntityInfo
  /** Subscription flag from checkSubscription / setSubscription. */
  flag?: boolean
  mapMarkers?: AppMarker[]
  error?: string
  info?: AppInfo
  time?: AppTime
  map?: AppMap
  teamInfo?: AppTeamInfo
  teamChat?: TeamMessage[]
  success?: boolean
}

export interface AppBroadcast {
  teamChanged?: { playerId: string; teamInfo: AppTeamInfo }
  teamMessage?: TeamMessage
  entityChanged?: { entityId: number; payload: AppEntityInfo }
}

export interface AppMessage {
  response?: AppResponse
  broadcast?: AppBroadcast
}

// --- decoders ---------------------------------------------------------------

function sub(f: Field): Reader {
  return new Reader(f.bytes ?? new Uint8Array(0))
}

function decodeInfo(f: Field): AppInfo {
  const out: AppInfo = {
    name: '', map: '', mapSize: 0, wipeTime: 0, players: 0, maxPlayers: 0,
    queuedPlayers: 0, seed: 0, salt: 0, url: '', headerImage: '',
  }
  sub(f).each((x) => {
    switch (x.field) {
      case 1: out.name = asString(x); break
      case 2: out.headerImage = asString(x); break
      case 3: out.url = asString(x); break
      case 4: out.map = asString(x); break
      case 5: out.mapSize = asNumber(x); break
      case 6: out.wipeTime = asNumber(x); break
      case 7: out.players = asNumber(x); break
      case 8: out.maxPlayers = asNumber(x); break
      case 9: out.queuedPlayers = asNumber(x); break
      case 10: out.seed = asNumber(x); break
      case 11: out.salt = asNumber(x); break
    }
  })
  return out
}

function decodeTime(f: Field): AppTime {
  const out: AppTime = { dayLengthMinutes: 0, timeScale: 0, sunrise: 0, sunset: 0, time: 0 }
  sub(f).each((x) => {
    switch (x.field) {
      case 1: out.dayLengthMinutes = x.float ?? 0; break
      case 2: out.timeScale = x.float ?? 0; break
      case 3: out.sunrise = x.float ?? 0; break
      case 4: out.sunset = x.float ?? 0; break
      case 5: out.time = x.float ?? 0; break
    }
  })
  return out
}

function decodeMember(f: Field): TeamMember {
  const out: TeamMember = {
    steamId: '', name: '', x: 0, y: 0,
    isOnline: false, spawnTime: 0, isAlive: false, deathTime: 0,
  }
  sub(f).each((x) => {
    switch (x.field) {
      case 1: out.steamId = String(x.varint ?? 0n); break
      case 2: out.name = asString(x); break
      case 3: out.x = x.float ?? 0; break
      case 4: out.y = x.float ?? 0; break
      case 5: out.isOnline = asBool(x); break
      case 6: out.spawnTime = asNumber(x); break
      case 7: out.isAlive = asBool(x); break
      case 8: out.deathTime = asNumber(x); break
    }
  })
  return out
}

function decodeNote(f: Field): MapNote {
  const out: MapNote = { type: 0, x: 0, y: 0, icon: 0, colourIndex: 0, label: '' }
  sub(f).each((x) => {
    switch (x.field) {
      case 2: out.type = asInt32(x); break
      case 3: out.x = x.float ?? 0; break
      case 4: out.y = x.float ?? 0; break
      case 5: out.icon = asInt32(x); break
      case 6: out.colourIndex = asInt32(x); break
      case 7: out.label = asString(x); break
    }
  })
  return out
}

function decodeTeamInfo(f: Field): AppTeamInfo {
  const out: AppTeamInfo = {
    leaderSteamId: '', members: [], mapNotes: [], leaderMapNotes: [],
  }
  sub(f).each((x) => {
    switch (x.field) {
      case 1: out.leaderSteamId = String(x.varint ?? 0n); break
      case 2: out.members.push(decodeMember(x)); break
      case 3: out.mapNotes.push(decodeNote(x)); break
      case 4: out.leaderMapNotes.push(decodeNote(x)); break
    }
  })
  return out
}

function decodeMap(f: Field): AppMap {
  const out: AppMap = {
    width: 0, height: 0, jpgImage: new Uint8Array(0),
    oceanMargin: 0, monuments: [], background: '',
  }
  sub(f).each((x) => {
    switch (x.field) {
      case 1: out.width = asNumber(x); break
      case 2: out.height = asNumber(x); break
      case 3: out.jpgImage = x.bytes ? Uint8Array.from(x.bytes) : new Uint8Array(0); break
      case 4: out.oceanMargin = asInt32(x); break
      case 5: {
        const m: MapMonument = { token: '', x: 0, y: 0 }
        sub(x).each((y) => {
          switch (y.field) {
            case 1: m.token = asString(y); break
            case 2: m.x = y.float ?? 0; break
            case 3: m.y = y.float ?? 0; break
          }
        })
        out.monuments.push(m)
        break
      }
      case 6: out.background = asString(x); break
    }
  })
  return out
}

function decodeTeamMessage(f: Field): TeamMessage {
  const out: TeamMessage = { steamId: '', name: '', message: '', color: '', time: 0 }
  sub(f).each((x) => {
    switch (x.field) {
      case 1: out.steamId = String(x.varint ?? 0n); break
      case 2: out.name = asString(x); break
      case 3: out.message = asString(x); break
      case 4: out.color = asString(x); break
      case 5: out.time = asNumber(x); break
    }
  })
  return out
}

function decodeMarker(f: Field): AppMarker {
  const out: AppMarker = {
    id: 0, type: 0, x: 0, y: 0, steamId: '0', rotation: 0, radius: 0, name: '', outOfStock: false,
  }
  sub(f).each((x) => {
    switch (x.field) {
      case 1: out.id = asNumber(x); break
      case 2: out.type = asInt32(x); break
      case 3: out.x = x.float ?? 0; break
      case 4: out.y = x.float ?? 0; break
      case 5: out.steamId = String(x.varint ?? 0n); break
      case 6: out.rotation = x.float ?? 0; break
      case 7: out.radius = x.float ?? 0; break
      case 11: out.name = asString(x); break
      case 12: out.outOfStock = asBool(x); break
    }
  })
  return out
}

function decodeEntityItem(f: Field): EntityItem {
  const out: EntityItem = { itemId: 0, quantity: 0, isBlueprint: false }
  sub(f).each((x) => {
    switch (x.field) {
      case 1: out.itemId = asInt32(x); break
      case 2: out.quantity = asInt32(x); break
      case 3: out.isBlueprint = asBool(x); break
    }
  })
  return out
}

/**
 * AppEntityPayload: value, items, capacity, protection window.
 *
 * Merged into the AppEntityInfo shape rather than nested, because every caller
 * wants "what is this device doing" in one object.
 */
function decodePayloadInto(f: Field, out: AppEntityInfo): void {
  sub(f).each((x) => {
    switch (x.field) {
      case 1: out.value = asBool(x); break
      case 2: out.items.push(decodeEntityItem(x)); break
      case 3: out.capacity = asInt32(x); break
      case 4: out.hasProtection = asBool(x); break
      case 5: out.protectionExpiry = asNumber(x); break
    }
  })
}

/**
 * The payload's field number inside AppEntityInfo has moved between published
 * copies of the proto (2 in some, 3 in others), so any length-delimited field
 * that isn't the type enum is treated as the payload. Reading a field that
 * turns out to be something else costs nothing; missing the payload would
 * leave every device blank.
 */
function decodeEntityInfo(f: Field): AppEntityInfo {
  const out: AppEntityInfo = {
    type: 0, kind: null, value: false, items: [], capacity: 0,
    hasProtection: false, protectionExpiry: 0,
  }
  sub(f).each((x) => {
    if (x.field === 1 && x.varint !== undefined) { out.type = asInt32(x); return }
    if (x.bytes) decodePayloadInto(x, out)
  })
  out.kind = entityKindOf(out.type)
  return out
}

function decodeResponse(f: Field): AppResponse {
  const out: AppResponse = { seq: 0 }
  sub(f).each((x) => {
    switch (x.field) {
      case 1: out.seq = asNumber(x); break
      case 4: out.success = true; break
      case 5: {
        sub(x).each((y) => { if (y.field === 1) out.error = asString(y) })
        break
      }
      case 6: out.info = decodeInfo(x); break
      case 7: out.time = decodeTime(x); break
      case 8: out.map = decodeMap(x); break
      case 9: out.teamInfo = decodeTeamInfo(x); break
      case 11: out.entityInfo = decodeEntityInfo(x); break
      case 15: { // AppClanInfo { AppClan clan = 1 }
        let name = ''
        let members = 0
        sub(x).each((y) => {
          if (!y.bytes) return
          sub(y).each((z) => {
            if (z.field === 2 && z.bytes) name = asString(z)
            if (z.field === 7 && z.bytes) members++
          })
        })
        if (name) out.clanInfo = { name, members }
        break
      }
      case 12: {
        sub(x).each((y) => { if (y.field === 1) out.flag = asBool(y) })
        break
      }
      case 13: {
        const markers: AppMarker[] = []
        sub(x).each((y) => { if (y.field === 1) markers.push(decodeMarker(y)) })
        out.mapMarkers = markers
        break
      }
      case 10: {
        const msgs: TeamMessage[] = []
        sub(x).each((y) => { if (y.field === 1) msgs.push(decodeTeamMessage(y)) })
        out.teamChat = msgs
        break
      }
    }
  })
  return out
}

function decodeBroadcast(f: Field): AppBroadcast {
  const out: AppBroadcast = {}
  sub(f).each((x) => {
    switch (x.field) {
      case 4: { // AppTeamChanged
        let playerId = ''
        let teamInfo: AppTeamInfo | undefined
        sub(x).each((y) => {
          if (y.field === 1) playerId = String(y.varint ?? 0n)
          if (y.field === 2) teamInfo = decodeTeamInfo(y)
        })
        if (teamInfo) out.teamChanged = { playerId, teamInfo }
        break
      }
      case 5: out.teamMessage = decodeTeamMessage(unwrapMessage(x)); break
      case 6: { // AppEntityChanged { entityId = 1; payload = 2 }
        let entityId = 0
        const payload: AppEntityInfo = {
          type: 0, kind: null, value: false, items: [], capacity: 0,
          hasProtection: false, protectionExpiry: 0,
        }
        sub(x).each((y) => {
          if (y.field === 1 && y.varint !== undefined) entityId = asNumber(y)
          else if (y.bytes) decodePayloadInto(y, payload)
        })
        if (entityId) out.entityChanged = { entityId, payload }
        break
      }
    }
  })
  return out
}

/** AppNewTeamMessage wraps a single AppTeamMessage in field 1. */
function unwrapMessage(f: Field): Field {
  let inner: Field | null = null
  sub(f).each((y) => { if (y.field === 1) inner = y })
  return inner ?? f
}

export function decodeMessage(buf: Uint8Array): AppMessage {
  const out: AppMessage = {}
  new Reader(buf).each((f) => {
    if (f.field === 1) out.response = decodeResponse(f)
    if (f.field === 2) out.broadcast = decodeBroadcast(f)
  })
  return out
}

/** Rust+ in-game time is decimal hours: 12.5 -> "12:30". */
export function formatGameTime(t: number): string {
  const h = Math.floor(t) % 24
  const m = Math.floor((t - Math.floor(t)) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Minutes of real time until sunset (or sunrise if already night). */
export function minutesUntil(time: AppTime, target: number): number {
  const dayLength = time.dayLengthMinutes || 60
  let delta = target - time.time
  if (delta < 0) delta += 24
  return (delta / 24) * dayLength
}

export function isNight(time: AppTime): boolean {
  return time.time < time.sunrise || time.time >= time.sunset
}

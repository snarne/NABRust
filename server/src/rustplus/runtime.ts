// ---------------------------------------------------------------------------
// Rust+ runtime: connect, keep in sync, answer in-game commands.
//
// Poll budget matters. Rust+ rate limits per method, and this runs for hours,
// so:
//   getTime      every 60s   (cheap; drives night warnings)
//   getTeamInfo  every 15s   (positions for the retracer + death detection)
//   getInfo      every 5m    (wipe detection, population)
//   getMapMarkers every 15s  (cargo, heli, Chinook, locked crates, explosions)
//   getMap       once per wipe (expensive — carries the full JPEG)
//   entities     subscribed (pushed), with a 5m poll as a safety net
// ---------------------------------------------------------------------------

import type { DB } from '../db/index.ts'
import { nowIso, setServerState } from '../db/index.ts'
import { currentWipe } from '../retention.ts'
import { RustPlusClient, connectWithRetry } from './client.ts'
import {
  recordTeamChat, recordTeammateDeath, syncMap, syncServerInfo, syncTeam,
} from './sync.ts'
import { handleCommand, isCommand } from './commands.ts'
import { trackMarkers, recordDeviceEvent } from './events.ts'
import { deviceLabel, listDevices, recordDeviceState } from './entities.ts'
import { isNight, minutesUntil, type AppTime, type AppTeamInfo } from './messages.ts'
import { rustPlusToNorm } from '../../../shared/world.ts'

export interface RuntimeOptions {
  db: DB
  serverId: string
  host: string
  port: number
  playerId: string
  playerToken: number
  dataDir: string
  dashboardUrl?: string
  webSocketImpl?: typeof WebSocket
  intervals?: { time?: number; team?: number; info?: number; markers?: number; devices?: number }
  /** Post crate / heli-down / cargo events to team chat. Default on. */
  announceEvents?: boolean
  log?: (msg: string) => void
  /** Fired on notable events so Discord/TeamSpeak sinks can subscribe. */
  onAlert?: (a: { kind: string; text: string }) => void
}

export interface RuntimeHandle {
  stop: () => void
  /** Latest in-game time, for the command handler and night warnings. */
  time: () => AppTime | undefined
  /**
   * Flip a paired smart switch and read back what it reports. Rejects when
   * Rust+ isn't connected, rather than pretending the switch moved.
   */
  setSwitch: (entityId: number, value: boolean) => Promise<void>
  /** Read one device now, whatever its kind. */
  readDevice: (entityId: number) => Promise<void>
}

export function startRustPlus(opts: RuntimeOptions): RuntimeHandle {
  const log = opts.log ?? (() => {})
  const timers: ReturnType<typeof setInterval>[] = []
  let lastTime: AppTime | undefined
  let lastTeam: AppTeamInfo | undefined
  let worldSize = 4250
  let nightWarned = false
  let active: RustPlusClient | null = null

  const wipeId = (): number | null => currentWipe(opts.db, opts.serverId)?.id ?? null

  /** Position of one of our own players, for `/nab base`. */
  const posOf = (steamId: string): { x: number; y: number } | undefined => {
    const m = lastTeam?.members.find((x) => x.steamId === steamId)
    return m ? rustPlusToNorm({ x: m.x, y: m.y }, worldSize) : undefined
  }

  const onConnect = async (client: RustPlusClient) => {
    // A reconnect must not stack a second set of polls on top of the first,
    // still pointed at the dead socket.
    for (const t of timers.splice(0)) clearInterval(t)
    active = client
    log(`rust+ connected to ${opts.host}:${opts.port}`)

    // 1. Server info first — it decides the wipe and carries the seed.
    const info = await client.getInfo()
    worldSize = info.mapSize || worldSize
    const sync = syncServerInfo(opts.db, opts.serverId, info)
    if (sync.wiped) {
      log(`wipe detected (${sync.reason}) — map and spatial state cleared`)
      opts.onAlert?.({ kind: 'wipe', text: `Wipe detected on ${info.name}: ${sync.reason}` })
    }

    // 2. Fetch the real map if we don't have one for this wipe.
    const haveMap = opts.db
      .prepare(`SELECT map_image_path FROM servers WHERE id = ?`)
      .get(opts.serverId) as { map_image_path: string | null } | undefined

    if (!haveMap?.map_image_path) {
      log('fetching server map…')
      const map = await client.getMap()
      const r = syncMap(opts.db, opts.serverId, map, {
        dataDir: opts.dataDir, worldSize, wipeId: sync.wipeId,
      })
      log(`map stored (${r.monuments} monuments) — placeholder mode off`)
      opts.onAlert?.({ kind: 'map', text: `Loaded the real map for ${info.name}` })
    }

    // 3. Team chat is the command surface.
    client.on('teamMessage', (msg) => {
      const wid = wipeId()
      if (wid !== null) recordTeamChat(opts.db, wid, [msg])
      if (!isCommand(msg.message)) return
      const reply = handleCommand({
        db: opts.db,
        serverId: opts.serverId,
        senderId: msg.steamId,
        senderPos: posOf(msg.steamId),
        worldSize,
        time: lastTime,
        dashboardUrl: opts.dashboardUrl,
      }, msg.message)
      if (reply) void client.sendTeamMessage(reply).catch((e) => log(`reply failed: ${e.message}`))
    })

    client.on('teamChanged', (team) => { applyTeam(team) })

    // 3a. Backfill the chat we missed while disconnected.
    try {
      const wid = wipeId()
      const history = await client.getTeamChat()
      if (wid !== null && history.length) recordTeamChat(opts.db, wid, history)
    } catch (e) { log(`getTeamChat: ${(e as Error).message}`) }

    // 3b. Paired devices: subscribe so the server pushes changes, and keep a
    // slow poll as a safety net for pushes that never arrive.
    client.on('entityChanged', (ev) => {
      const wid = wipeId()
      if (wid === null) return
      const r = recordDeviceState(opts.db, opts.serverId, wid, ev.entityId, ev.payload)
      if (!r.row) return
      if (r.alarmTriggered) announceAlarm(client, wid, r.row)
    })
    await subscribeDevices(client)

    // 4. Polls.
    const pollTeam = async () => {
      try {
        applyTeam(await client.getTeamInfo())
      } catch (e) { log(`getTeamInfo: ${(e as Error).message}`) }
    }
    const pollTime = async () => {
      try {
        lastTime = await client.getTime()
        checkNightfall(lastTime)
        // The dashboard reads in-game time from here.
        opts.db.prepare(
          `INSERT INTO server_state (server_id, key, value, updated_at) VALUES (?, 'time', ?, ?)
           ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(opts.serverId, JSON.stringify(lastTime), nowIso())
      } catch (e) { log(`getTime: ${(e as Error).message}`) }
    }
    const pollMarkers = async () => {
      const wid = wipeId()
      if (wid === null) return
      try {
        const markers = await client.getMapMarkers()
        const diff = trackMarkers(opts.db, { wipeId: wid, worldSize, markers })
        setServerState(opts.db, opts.serverId, 'rustplus_markers', { count: markers.length })
        for (const e of [...diff.started, ...diff.ended]) {
          log(e.label)
          opts.onAlert?.({ kind: e.kind, text: e.label })
          // Only the events worth a teammate's attention mid-fight go to chat.
          if (opts.announceEvents !== false && /Locked crate|downed|Cargo Ship on/.test(e.label)) {
            void client.sendTeamMessage(`NAB: ${e.label}`).catch(() => {})
          }
        }
      } catch (e) { log(`getMapMarkers: ${(e as Error).message}`) }
    }
    const pollDevices = async () => {
      const wid = wipeId()
      if (wid === null) return
      for (const d of listDevices(opts.db, opts.serverId, wid)) {
        try {
          const info = await client.getEntityInfo(d.entityId)
          const r = recordDeviceState(opts.db, opts.serverId, wid, d.entityId, info)
          if (r.row && r.alarmTriggered) announceAlarm(client, wid, r.row)
        } catch (e) {
          // A device that was destroyed or unpaired answers with an error;
          // that is information, not a failure, so it is logged and skipped.
          log(`entity ${d.entityId}: ${(e as Error).message}`)
        }
      }
    }
    const pollInfo = async () => {
      try {
        const i = await client.getInfo()
        worldSize = i.mapSize || worldSize
        const r = syncServerInfo(opts.db, opts.serverId, i)
        if (r.wiped) {
          log(`wipe detected (${r.reason})`)
          opts.onAlert?.({ kind: 'wipe', text: `Wipe detected: ${r.reason}` })
        }
      } catch (e) { log(`getInfo: ${(e as Error).message}`) }
    }

    await pollTeam()
    await pollTime()
    await pollMarkers()
    await pollDevices()

    timers.push(setInterval(() => void pollTeam(), opts.intervals?.team ?? 15_000))
    timers.push(setInterval(() => void pollTime(), opts.intervals?.time ?? 60_000))
    timers.push(setInterval(() => void pollInfo(), opts.intervals?.info ?? 300_000))
    timers.push(setInterval(() => void pollMarkers(), opts.intervals?.markers ?? 15_000))
    timers.push(setInterval(() => void pollDevices(), opts.intervals?.devices ?? 300_000))
  }

  /** Ask the server to push changes for every device we know about. */
  const subscribeDevices = async (client: RustPlusClient) => {
    const wid = wipeId()
    if (wid === null) return
    for (const d of listDevices(opts.db, opts.serverId, wid)) {
      try { await client.setSubscription(d.entityId, true) } catch { /* poll covers it */ }
    }
  }

  /**
   * An alarm going off on your own base is the one device event that can't
   * wait for someone to look at a dashboard: it goes to the event feed, to
   * team chat, and to any alert sink.
   */
  const announceAlarm = (
    client: RustPlusClient,
    wid: number,
    row: { entityId: number; kind: 'switch' | 'alarm' | 'storage'; name: string | null },
  ) => {
    const label = `ALARM · ${deviceLabel(row)}`
    recordDeviceEvent(opts.db, wid, { kind: 'alarm', label, markerId: row.entityId })
    log(label)
    opts.onAlert?.({ kind: 'alarm', text: label })
    if (opts.announceEvents !== false) {
      void client.sendTeamMessage(`NAB: ${label}`).catch(() => {})
    }
  }

  /** Read a device and store what it says. Shared by the API and the poll. */
  const readDevice = async (entityId: number) => {
    const client = active
    const wid = wipeId()
    if (!client) throw new Error('rust+ is not connected')
    if (wid === null) throw new Error('no current wipe')
    const info = await client.getEntityInfo(entityId)
    const r = recordDeviceState(opts.db, opts.serverId, wid, entityId, info)
    if (r.row && r.alarmTriggered) announceAlarm(client, wid, r.row)
  }

  const setSwitch = async (entityId: number, value: boolean) => {
    const client = active
    if (!client) throw new Error('rust+ is not connected')
    await client.setEntityValue(entityId, value)
    // Read back rather than assuming: the switch may be unpowered.
    await readDevice(entityId)
  }

  const applyTeam = (team: AppTeamInfo) => {
    lastTeam = team
    const wid = wipeId()
    if (wid === null) return
    const r = syncTeam(opts.db, opts.serverId, wid, team, { worldSize })
    setServerState(opts.db, opts.serverId, 'rustplus_team', { members: team.members.length })
    for (const d of r.deaths) {
      recordTeammateDeath(opts.db, opts.serverId, wid, d, nowIso())
      log(`${d.name} died in ${d.grid}`)
      opts.onAlert?.({ kind: 'death', text: `${d.name} died in ${d.grid}` })
    }
  }

  /** One warning per night, not one per poll. */
  const checkNightfall = (t: AppTime) => {
    if (isNight(t)) {
      nightWarned = false
      return
    }
    const mins = minutesUntil(t, t.sunset)
    if (mins <= 5 && !nightWarned) {
      nightWarned = true
      const text = mins < 1 ? 'Nightfall imminent' : `Nightfall in ~${Math.round(mins)}m`
      opts.onAlert?.({ kind: 'night', text })
      void active?.sendTeamMessage(`NAB: ${text}`).catch(() => {})
    }
  }

  const retry = connectWithRetry(
    {
      host: opts.host, port: opts.port,
      playerId: opts.playerId, playerToken: opts.playerToken,
      webSocketImpl: opts.webSocketImpl,
    },
    {
      onConnect,
      onError: (e) => log(`rust+ ${e.message}`),
    },
  )

  return {
    stop: () => {
      for (const t of timers) clearInterval(t)
      void retry.then((h) => h.stop())
    },
    time: () => lastTime,
    setSwitch,
    readDevice,
  }
}

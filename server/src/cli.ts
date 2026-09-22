#!/usr/bin/env node
// ---------------------------------------------------------------------------
// nabrust CLI
//
//   init      create the database and register a server
//   serve     run the API (and the Battlemetrics collector if configured)
//   collect   one-shot collector poll, for cron or testing
//   ingest    read a combat log from a file or stdin
//   clans     rebuild rosters from the pair graph
//   wipe      force a wipe rollover
//   stats     retention and coverage summary
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { openDb, nowIso } from './db/index.ts'
import { ingestWorldFile } from './parsers/mapIngest.ts'
import { currentWipe, detectWipe, retentionStats, rolloverWipe } from './retention.ts'
import { ingestCombatLog, buildSessionEvidence } from './ingest.ts'
import { pairPrior, rebuildClans, teamLimit } from './pairs.ts'
import { currentName } from './identity.ts'
import { createApi } from './api/server.ts'
import {
  closeStaleSessions, downloadTo, fetchOnline, fetchServerInfo, recordSnapshot,
  searchServers, startCollector,
} from './collectors/battlemetrics.ts'
import { startRustPlus } from './rustplus/runtime.ts'
import { RustPlusClient } from './rustplus/client.ts'
import { formatGameTime, isNight } from './rustplus/messages.ts'

const env = (k: string, fallback?: string): string => {
  const v = process.env[k] ?? fallback
  if (v === undefined) throw new Error(`missing env ${k}`)
  return v
}

const DB_PATH = process.env.NABRUST_DB ?? './nabrust.db'
const TOKEN = process.env.NABRUST_TOKEN ?? 'change-me'
const TEAM = (process.env.NABRUST_TEAM ?? '').split(',').filter(Boolean)

const [, , cmd, ...args] = process.argv

function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function main() {
  const db = openDb(DB_PATH)

  switch (cmd) {
    case 'init': {
      const id = arg('id') ?? 'server-1'
      const name = arg('name') ?? id
      const seed = arg('seed') ? Number(arg('seed')) : null
      const world = arg('world') ? Number(arg('world')) : null
      const bm = arg('battlemetrics') ?? null
      const limit = arg('team-limit') ? Number(arg('team-limit')) : null

      // Re-running init updates what was passed and leaves the rest alone.
      db.prepare(
        `INSERT INTO servers (id, name, battlemetrics_id, seed, world_size, team_limit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           battlemetrics_id = COALESCE(excluded.battlemetrics_id, battlemetrics_id),
           seed = COALESCE(excluded.seed, seed),
           world_size = COALESCE(excluded.world_size, world_size),
           team_limit = COALESCE(excluded.team_limit, team_limit)`,
      ).run(id, name, bm, seed, world, limit, nowIso())
      console.log(`team limit: ${teamLimit(db, id)}${limit ? '' : ' (from the name — pass --team-limit to set it)'}`)

      if (!currentWipe(db, id)) {
        db.prepare(
          `INSERT INTO wipes (server_id, started_at, seed, world_size) VALUES (?, ?, ?, ?)`,
        ).run(id, nowIso(), seed, world)
      }
      console.log(`registered ${id} (${name}) in ${DB_PATH}`)
      if (seed === null) {
        console.log('no seed yet — the map stays a placeholder until one is read')
      }
      break
    }

    case 'serve': {
      const api = createApi({ db, token: TOKEN, port: Number(process.env.PORT ?? 8787), teamIds: TEAM })
      const port = await api.listen()
      console.log(`api listening on :${port}`)
      if (TOKEN === 'change-me' || TOKEN === 'nab-local-dev-change-me') {
        console.warn('warning: NABRUST_TOKEN is still the default — set your own in server/.env before anything else can reach this port')
      }

      // --- Battlemetrics: the history that cannot be backfilled ---
      const bmToken = process.env.BATTLEMETRICS_TOKEN
      const bmServers = db.prepare(
        `SELECT id, battlemetrics_id FROM servers WHERE battlemetrics_id IS NOT NULL`,
      ).all() as { id: string; battlemetrics_id: string }[]

      if (bmToken && bmServers.length) {
        for (const s of bmServers) {
          startCollector(db, {
            serverId: s.id,
            battlemetricsId: s.battlemetrics_id,
            cfg: { token: bmToken },
            wipeId: () => currentWipe(db, s.id)?.id ?? null,
            onError: (e) => console.error(`[bm ${s.id}]`, (e as Error).message),
            onTick: (r) => console.log(`[bm ${s.id}] ${r.online} online +${r.opened} -${r.closed}`),
          })
          console.log(`collector started for ${s.id}`)
        }
        // Teammate evidence is a running state, not an event: rebuild it and
        // the rosters from it on a timer.
        const refreshTeams = () => {
          for (const s of bmServers) {
            try {
              const n = buildSessionEvidence(db, s.id)
              const r = rebuildClans(db, s.id)
              console.log(`[teams ${s.id}] ${n} pairs moved together · ${r.clans} rosters`)
            } catch (e) {
              console.error(`[teams ${s.id}]`, (e as Error).message)
            }
          }
        }
        setTimeout(refreshTeams, 2 * 60_000)
        setInterval(refreshTeams, 15 * 60_000)
      } else {
        console.log(
          bmToken ? 'no servers have a battlemetrics id — run init --battlemetrics'
                  : 'BATTLEMETRICS_TOKEN unset — session collection disabled',
        )
      }

      // --- Steam: bans, account age, public Rust hours for real steam ids ---
      const steamKey = process.env.STEAM_API_KEY
      if (steamKey) {
        const { refreshSteamProfiles } = await import('./collectors/steam.ts')
        const steamTick = async () => {
          try {
            const n = await refreshSteamProfiles(db, { key: steamKey, pauseMs: 1100 })
            if (n) console.log(`[steam] ${n} profiles refreshed`)
          } catch (e) { console.error('[steam]', (e as Error).message) }
        }
        void steamTick()
        setInterval(() => void steamTick(), 10 * 60_000)
        console.log('steam profile collector started')
      } else {
        console.log('STEAM_API_KEY unset — Steam profiles (bans, hours) disabled')
      }

      // --- Rust+: live map, team positions, in-game commands ---
      const paired = db.prepare(
        `SELECT id, rustplus_host, rustplus_port, rustplus_player_id, rustplus_token
           FROM servers WHERE rustplus_host IS NOT NULL AND rustplus_token IS NOT NULL`,
      ).all() as {
        id: string; rustplus_host: string; rustplus_port: number
        rustplus_player_id: string; rustplus_token: number
      }[]

      if (!paired.length) console.log('no Rust+ pairing stored — run `pair` to add one')
      for (const s of paired) {
        startRustPlus({
          db,
          serverId: s.id,
          host: s.rustplus_host,
          port: s.rustplus_port,
          playerId: s.rustplus_player_id,
          playerToken: s.rustplus_token,
          dataDir: process.env.NABRUST_DATA ?? './data',
          log: (m) => console.log(`[rust+ ${s.id}] ${m}`),
          onAlert: (a) => console.log(`[alert ${s.id}] ${a.kind}: ${a.text}`),
        })
        console.log(`rust+ runtime started for ${s.id}`)
      }
      break
    }

    case 'pair': {
      // Credentials come from pairing in-game once; Rust delivers the token by
      // push notification, so capture it with an FCM listener (rustplus.js
      // `fcm-listen`, or the Rust+ desktop app) and paste the values here.
      const id = arg('id') ?? 'server-1'
      const host = arg('host')
      const rpPort = Number(arg('port') ?? 28082)
      const playerId = arg('player')
      const playerToken = arg('token') ? Number(arg('token')) : undefined

      if (!host || !playerId || playerToken === undefined) {
        console.log(`pair --id <server> --host <ip> [--port 28082] --player <steamid> --token <int>

The token is an int32 and is often negative — quote it: --token -- -1717986918
Obtain all four by pairing from the in-game menu and capturing the FCM
notification (rustplus.js fcm-listen, or the Rust+ desktop app).`)
        break
      }

      db.prepare(
        `UPDATE servers SET rustplus_host = ?, rustplus_port = ?,
                rustplus_player_id = ?, rustplus_token = ?, rustplus_paired = 1
          WHERE id = ?`,
      ).run(host, rpPort, playerId, playerToken, id)
      console.log(`paired ${id} → ${host}:${rpPort}`)
      console.log('run `serve` (or `rustplus --id ' + id + '`) to pull the map')
      break
    }

    case 'rustplus': {
      // One-shot connectivity check: proves the pairing works and shows what
      // the server actually reports.
      const id = arg('id') ?? 'server-1'
      const s = db.prepare(
        `SELECT rustplus_host, rustplus_port, rustplus_player_id, rustplus_token
           FROM servers WHERE id = ?`,
      ).get(id) as {
        rustplus_host: string | null; rustplus_port: number | null
        rustplus_player_id: string | null; rustplus_token: number | null
      } | undefined

      if (!s?.rustplus_host || s.rustplus_token === null) {
        throw new Error(`${id} has no Rust+ pairing — run \`pair\` first`)
      }

      const client = new RustPlusClient({
        host: s.rustplus_host, port: s.rustplus_port ?? 28082,
        playerId: s.rustplus_player_id!, playerToken: s.rustplus_token!,
      })
      await client.connect()
      const info = await client.getInfo()
      const time = await client.getTime()
      const team = await client.getTeamInfo()
      client.close()

      console.log(`\n  ${info.name}`)
      console.log(`  seed ${info.seed} · ${info.mapSize} · ${info.players}/${info.maxPlayers}`)
      console.log(`  in-game ${formatGameTime(time.time)} (${isNight(time) ? 'night' : 'day'})`)
      console.log(`  team of ${team.members.length}, ${team.members.filter((m) => m.isOnline).length} online`)
      console.log(`  map notes: ${team.mapNotes.length + team.leaderMapNotes.length}\n`)
      break
    }

    case 'find': {
      const q = args.filter((a) => !a.startsWith('--')).join(' ')
      if (!q) throw new Error('usage: find <server name>')
      const results = await searchServers(q, { token: env('BATTLEMETRICS_TOKEN') })
      for (const r of results) {
        console.log(`  ${r.id.padStart(9)}  ${r.players}/${r.maxPlayers}  ${r.name}`)
      }
      console.log('\nuse the id with: init --battlemetrics <id>')
      break
    }

    case 'server-info': {
      const id = arg('id') ?? 'server-1'
      const row = db.prepare(`SELECT battlemetrics_id FROM servers WHERE id = ?`).get(id) as
        { battlemetrics_id: string | null } | undefined
      if (!row?.battlemetrics_id) throw new Error(`no battlemetrics id for ${id}`)
      const info = await fetchServerInfo(row.battlemetrics_id, { token: env('BATTLEMETRICS_TOKEN') })
      console.log(`\n  ${info.name} — ${info.players}/${info.maxPlayers} (${info.status})`)
      console.log(`  seed ${info.seed ?? 'not exposed'} · size ${info.worldSize ?? 'not exposed'}`)
      console.log(`  last wipe ${info.lastWipe ?? 'unknown'}`)
      if (info.nextWipe) console.log(`  next wipe ${info.nextWipe}`)
      if (info.map.imageUrl) console.log(`  map render available (${info.map.monumentCount ?? '?'} monuments)`)
      if (info.map.fileUrl) console.log(`  .map world file available`)
      if (!args.includes('--quiet')) {
        console.log(`  detail keys: ${info.detailKeys.join(', ') || 'none'}`)
      }
      console.log()

      db.prepare(
        `UPDATE servers SET seed = COALESCE(?, seed), world_size = COALESCE(?, world_size),
                map_page_url = ?, map_image_url = ?, map_file_url = ?, monument_count = ?,
                next_wipe_at = ?, last_seed_change = ?
          WHERE id = ?`,
      ).run(
        info.seed, info.worldSize,
        info.map.pageUrl, info.map.imageUrl, info.map.fileUrl, info.map.monumentCount,
        info.nextWipe, info.lastSeedChange, id,
      )
      if (info.seed) console.log('  seed saved')
      if (info.map.imageUrl) console.log('  run `map --id ' + id + '` to pull the real map')
      break
    }

    case 'collect': {
      const id = arg('id') ?? 'server-1'
      const row = db.prepare(`SELECT battlemetrics_id FROM servers WHERE id = ?`).get(id) as
        { battlemetrics_id: string | null } | undefined
      if (!row?.battlemetrics_id) throw new Error(`no battlemetrics id for ${id}`)
      const online = await fetchOnline(row.battlemetrics_id, { token: env('BATTLEMETRICS_TOKEN') })
      const wipe = currentWipe(db, id)
      const r = recordSnapshot(db, id, wipe?.id ?? null, online)
      closeStaleSessions(db, id)
      console.log(`${online.length} online · +${r.opened} sessions · -${r.closed} closed`)
      break
    }

    case 'ingest': {
      const id = arg('id') ?? 'server-1'
      const reporter = arg('reporter') ?? TEAM[0]
      if (!reporter) throw new Error('pass --reporter <steamid> or set NABRUST_TEAM')
      const file = arg('file')
      const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
      const wipe = currentWipe(db, id)
      if (!wipe) throw new Error(`no open wipe for ${id} — run init first`)
      const r = ingestCombatLog(db, text, {
        serverId: id, wipeId: wipe.id, reporterId: reporter, teamIds: TEAM,
      })
      console.log(
        `${r.linesIn} lines → ${r.encounters} encounters, ${r.events} events, ` +
        `${r.evidence} evidence, ${r.rejected.length} rejected`,
      )
      for (const rej of r.rejected.slice(0, 5)) console.log(`  rejected: ${rej.reason}`)
      break
    }

    case 'evidence': {
      // Rebuild teammate evidence and rosters now, and say what they rest on.
      const id = arg('id') ?? 'server-1'
      const n = buildSessionEvidence(db, id)
      const r = rebuildClans(db, id)
      const meta = db.prepare(`SELECT value FROM server_state WHERE server_id = ? AND key = 'session_evidence'`)
        .get(id) as { value: string } | undefined
      const m = meta ? JSON.parse(meta.value) as { population: number; coverageHours: number } : null
      const prior = pairPrior(db, id)
      const strong = db.prepare(`SELECT COUNT(*) AS n FROM pair_state WHERE server_id = ? AND confidence >= 0.6`)
        .get(id) as { n: number }
      console.log(`watched ${m?.coverageHours.toFixed(1) ?? '?'} h · ${m?.population ?? '?'} players · team limit ${teamLimit(db, id)}`)
      console.log(`prior: 1 in ${Math.round(1 + Math.exp(-prior))} pairs are teammates before any evidence`)
      console.log(`${n} pairs moved together at least once · ${strong.n} at ≥60% · ${r.clans} rosters`)
      if ((m?.coverageHours ?? 0) < 48) {
        console.log('under two days of data — expect few rosters yet; they sharpen every session')
      }
      break
    }

    case 'validate': {
      // Score the teammate model on simulated servers where the teams are known.
      const { simulateServer, evaluate } = await import('./validation/simulate.ts')
      const seeds = [1, 2, 3]
      console.log('simulated trio servers, 300 players, daily restarts, 1-minute polling\n')
      console.log('data   model           flagged  pair precision/recall  roster precision/recall  exact teams')
      for (const hours of [24, 72, 168]) {
        const acc = { legacy: [0, 0, 0, 0, 0, 0], coMovement: [0, 0, 0, 0, 0, 0] }
        for (const seed of seeds) {
          const r = evaluate(simulateServer({ seed, hours }))
          for (const k of ['legacy', 'coMovement'] as const) {
            const x = r[k]
            ;[x.flagged, x.pairPrecision, x.pairRecall, x.rosterPrecision, x.rosterRecall, x.exactTeams / Math.max(1, x.trueTeams)]
              .forEach((v, i) => { acc[k][i] += v / seeds.length })
          }
        }
        const pct = (v: number) => `${(v * 100).toFixed(0)}%`.padStart(4)
        for (const [k, label] of [['legacy', 'old (overlap)'], ['coMovement', 'co-movement']] as const) {
          const a = acc[k]
          console.log(`${String(hours).padStart(3)} h  ${label.padEnd(15)} ${a[0].toFixed(0).padStart(7)}  ${pct(a[1])} / ${pct(a[2])}            ${pct(a[3])} / ${pct(a[4])}              ${pct(a[5])}`)
        }
      }
      console.log('\nA model of player behaviour, not a recording: it shows the method works and')
      console.log('how it scales with data, not a guarantee for any particular server.')
      break
    }

    case 'simulate': {
      // Build a simulated server in its OWN database, fed through the real
      // pipeline, so every page can be exercised without being in game.
      const target = arg('db') ?? './sim.db'
      if (resolvePath(target) === resolvePath(DB_PATH)) {
        throw new Error('refusing to put simulated data in your real database — pass --db ./sim.db')
      }
      if (existsSync(target) && !args.includes('--force')) {
        throw new Error(`${target} exists — pass --force to replace it`)
      }
      if (existsSync(target)) {
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          if (existsSync(target + suffix)) unlinkSync(target + suffix)
        }
      }
      // Borrow a real map, so the simulation plays out on actual terrain.
      const from = arg('map-from')
      const src = db.prepare(
        `SELECT s.id, s.world_size, s.seed, s.map_image_path, s.map_world_path, w.id AS wipe_id
           FROM servers s LEFT JOIN wipes w ON w.server_id = s.id AND w.ended_at IS NULL
          WHERE s.map_source = 'parsed' ${from ? 'AND s.id = ?' : ''} ORDER BY s.map_parsed_at DESC LIMIT 1`,
      ).get(...(from ? [from] : [])) as {
        id: string; world_size: number; seed: number | null; map_image_path: string | null
        map_world_path: string | null; wipe_id: number | null
      } | undefined
      if (from && !src) {
        throw new Error(`no parsed map for "${from}" in ${DB_PATH} — run \`nab parse-map --id ${from}\` first`)
      }
      const monuments = src?.wipe_id
        ? db.prepare(`SELECT name, kind, x, y, prefab_id, height, radius FROM monuments WHERE wipe_id = ?`).all(src.wipe_id) as never[]
        : []
      const { seedSimulation } = await import('./validation/simServer.ts')
      const simDb = openDb(target)
      const t0 = Date.now()
      const truth = seedSimulation(simDb, {
        seed: arg('seed') ? Number(arg('seed')) : 7,
        hours: arg('hours') ? Number(arg('hours')) : 72,
        players: arg('players') ? Number(arg('players')) : 180,
        map: src ? {
          worldSize: src.world_size, seed: src.seed, imagePath: src.map_image_path,
          worldPath: src.map_world_path, monuments,
        } : null,
      })
      console.log(`simulated server written to ${target} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      console.log(`  map: ${src ? `borrowed from ${src.id}` : 'none — run parse-map on a real server first for terrain'}`)
      console.log(`  ${truth.deaths.length} deaths with known shooter positions, team of ${truth.team.length}`)
      console.log(`\nbrowse it:  NABRUST_DB=${target} ./nab serve   (then npm run dev)`)
      console.log('it is labelled SIMULATED everywhere and never touches your real database')
      break
    }

    case 'clans': {
      const id = arg('id') ?? 'server-1'
      const r = rebuildClans(db, id)
      console.log(`${r.clans} rosters`)
      for (const c of db.prepare(`SELECT id, label FROM clans WHERE server_id = ?`).all(id) as
        { id: string; label: string }[]) {
        const members = db.prepare(
          `SELECT steam_id, confidence, source FROM clan_members WHERE clan_id = ? ORDER BY confidence DESC`,
        ).all(c.id) as { steam_id: string; confidence: number; source: string }[]
        console.log(`\n  ${c.label}`)
        for (const m of members) {
          console.log(
            `    ${(currentName(db, m.steam_id) ?? m.steam_id).padEnd(22)}` +
            ` ${(m.confidence * 100).toFixed(0).padStart(3)}%  ${m.source}`,
          )
        }
      }
      for (const c of r.conflicts) console.log(`  conflict: ${c}`)
      break
    }

    case 'wipe': {
      const id = arg('id') ?? 'server-1'
      const seed = arg('seed') ? Number(arg('seed')) : null
      const world = arg('world') ? Number(arg('world')) : null
      const check = detectWipe(db, id, { seed, worldSize: world })
      if (!check.wiped && !args.includes('--force')) {
        console.log(`no wipe detected (${check.reason ?? 'seed unchanged'}) — pass --force to roll over anyway`)
        break
      }
      const r = rolloverWipe(db, id, { seed, worldSize: world })
      console.log(`wipe ${r.closed} closed, wipe ${r.opened} opened${check.reason ? ` (${check.reason})` : ''}`)
      console.log('map cleared — re-pair Rust+ or re-parse the seed')
      break
    }

    case 'stats': {
      const s = retentionStats(db)
      const servers = db.prepare(`SELECT id, name, seed, world_size FROM servers`).all() as
        { id: string; name: string; seed: number | null; world_size: number | null }[]
      console.log('\nservers')
      for (const sv of servers) {
        const w = currentWipe(db, sv.id)
        console.log(
          `  ${sv.name.padEnd(24)} seed ${String(sv.seed ?? 'unknown').padEnd(10)}` +
          ` ${sv.world_size ?? '?'}  wipe ${w?.id ?? '-'}`,
        )
      }
      console.log('\nhot  ', s.hot)
      console.log('warm ', s.warm)
      console.log('cold ', s.cold)
      console.log()
      break
    }

    case 'map': {
      // Pull the rendered map Battlemetrics publishes for this seed. No Rust+
      // pairing needed — this is usually the fastest way out of placeholder mode.
      const id = arg('id') ?? 'server-1'
      const row = db.prepare(
        `SELECT battlemetrics_id, map_image_url, map_file_url, seed, world_size
           FROM servers WHERE id = ?`,
      ).get(id) as {
        battlemetrics_id: string | null; map_image_url: string | null
        map_file_url: string | null; seed: number | null; world_size: number | null
      } | undefined
      if (!row) throw new Error(`unknown server ${id}`)

      let imageUrl = row.map_image_url
      let fileUrl = row.map_file_url

      // Refresh from Battlemetrics if we haven't looked yet.
      if (!imageUrl && row.battlemetrics_id) {
        const info = await fetchServerInfo(row.battlemetrics_id, { token: env('BATTLEMETRICS_TOKEN') })
        imageUrl = info.map.imageUrl
        fileUrl = info.map.fileUrl
        db.prepare(
          `UPDATE servers SET map_image_url = ?, map_file_url = ?, map_page_url = ?,
                  monument_count = ?, seed = COALESCE(?, seed), world_size = COALESCE(?, world_size)
            WHERE id = ?`,
        ).run(imageUrl, fileUrl, info.map.pageUrl, info.map.monumentCount,
          info.seed, info.worldSize, id)
      }
      if (!imageUrl) throw new Error('battlemetrics exposes no map render for this server')

      const wipe = currentWipe(db, id)
      const dataDir = process.env.NABRUST_DATA ?? './data'
      const ext = imageUrl.split('?')[0].match(/\.(\w+)$/)?.[1] ?? 'webp'
      const dest = `${dataDir}/maps/${id}-${wipe?.id ?? 0}.${ext}`

      const r = await downloadTo(imageUrl, dest)
      db.prepare(
        `UPDATE servers SET map_image_path = ?, map_source = 'battlemetrics', map_parsed_at = ?
          WHERE id = ?`,
      ).run(dest, nowIso(), id)
      console.log(`map saved → ${dest} (${Math.round(r.bytes / 1024)} KB, ${r.contentType ?? '?'})`)
      console.log('placeholder mode off for this server')

      if (args.includes('--world') && fileUrl) {
        const wf = `${dataDir}/maps/${id}-${wipe?.id ?? 0}.map`
        const w = await downloadTo(fileUrl, wf)
        console.log(`world file → ${wf} (${Math.round(w.bytes / 1024 / 1024)} MB)`)
        console.log(`now run: parse-map --id ${id}`)
      } else if (fileUrl) {
        console.log('pass --world to also download the .map world file')
      }
      break
    }

    case 'parse-map': {
      // The .map file IS the world: heightmap, biomes, topology, every
      // monument and road. Parsing it gives a real render instead of the
      // 250x250 thumbnail the server browser hands out, and gives the
      // localization solver terrain to work against.
      const id = arg('id') ?? 'server-1'
      const wipe = currentWipe(db, id)
      const dataDir = process.env.NABRUST_DATA ?? './data'
      const src = arg('file') ?? `${dataDir}/maps/${id}-${wipe?.id ?? 0}.map`
      const res = arg('res') ? Number(arg('res')) : 2048
      const dest = `${dataDir}/maps/${id}-${wipe?.id ?? 0}.png`

      if (!existsSync(src)) {
        throw new Error(`no world file at ${src} — run: map --id ${id} --world`)
      }

      const t0 = Date.now()
      const r = ingestWorldFile(db, id, src, dest, wipe?.id ?? null, { resolution: res })
      const secs = ((Date.now() - t0) / 1000).toFixed(1)

      console.log(`parsed world v${r.version}: ${r.worldSize}m, ${r.prefabs} prefabs, ${r.monuments.length} monuments (${secs}s)`)
      if (r.headerStamp) console.log(`  file stamp ${r.headerStamp}`)
      console.log(`  elevation  ${r.terrain.minHeight.toFixed(0)}m .. ${r.terrain.maxHeight.toFixed(0)}m`)
      console.log(`  land       ${(r.terrain.landFraction * 100).toFixed(0)}%  buildable ${(r.terrain.buildableFraction * 100).toFixed(0)}%`)
      console.log(`  render     ${dest} (${res}x${res}, ${Math.round(r.renderBytes / 1024)} KB)`)

      const tiers = r.monuments.reduce<Record<string, number>>((acc, m) => {
        acc[m.size] = (acc[m.size] ?? 0) + 1
        return acc
      }, {})
      console.log(`  monuments  ${Object.entries(tiers).map(([k, v]) => `${v} ${k}`).join(', ')}`)
      for (const m of r.monuments.slice(0, 5)) {
        console.log(`    ${m.label.padEnd(30)} r=${m.radius.toFixed(0)}m`)
      }
      console.log('map_source = parsed; the UI is on the real map now')
      break
    }

    default:
      console.log(`nabrust <command>

  setup
    init        --id <id> --name <name> [--seed N --world N --battlemetrics ID --team-limit N]
    find        <server name>              find a battlemetrics id
    pair        --id --host --player --token    store Rust+ credentials

  running
    serve                                  api + collectors + rust+
    collect     --id <id>                  one-shot battlemetrics poll
    rustplus    --id <id>                  one-shot rust+ connectivity check
    server-info --id <id>                  read seed/size/map urls from battlemetrics
    map         --id <id> [--world]        download the real map for this seed
    parse-map   --id <id> [--res 2048]     parse the .map world file: render,
                                           monuments, terrain for the solver

  data
    ingest      --id --reporter [--file]   combat log (else stdin)
    evidence    --id <id>                  rebuild teammate evidence + rosters now
    clans       --id <id>                  rebuild rosters and list them
    validate                               score the teammate model on simulated servers
    simulate    [--db ./sim.db --hours 72 --map-from <id> --force]  a fake server for testing every page
    wipe        --id [--seed N --world N] [--force]
    stats

env: NABRUST_DB, NABRUST_DATA, NABRUST_TOKEN,
     NABRUST_TEAM (comma-separated steam ids), NABRUST_TEAM_NAME,
     BATTLEMETRICS_TOKEN, STEAM_API_KEY, PORT`)
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`)
  process.exit(1)
})

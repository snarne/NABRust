// ---------------------------------------------------------------------------
// HTTP API — zero dependencies, node:http only.
//
// Two audiences:
//   agents    POST raw log text from each teammate's gaming PC
//   the web   GET the server-scoped dataset the React app renders
//
// Auth is a shared bearer token. This service is meant to sit behind a
// Cloudflare Tunnel on a box you control, not on the open internet.
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import type { DB } from '../db/index.ts'
import { nowIso } from '../db/index.ts'
import { ingestCombatLog } from '../ingest.ts'
import { currentWipe } from '../retention.ts'
import { rebuildClans } from '../pairs.ts'
import { serverRecords, terrainFor } from './mapInfo.ts'
import { datasetFor } from './dataset.ts'
import { statusFor } from './status.ts'
import { addDevice, DeviceError, removeDevice } from '../rustplus/entities.ts'
import { BaseInputError, createBase, deleteBase, updateBase, type BaseInput } from './bases.ts'

export interface ApiOptions {
  db: DB
  token: string
  port?: number
  teamIds?: string[]
  /**
   * Flip a paired smart switch. Supplied by `serve`, which owns the live Rust+
   * connection; absent when the API runs on its own, and then the route says
   * so instead of failing silently.
   */
  setSwitch?: (serverId: string, entityId: number, value: boolean) => Promise<void>
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limitBytes) throw new Error('payload too large')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createApi(opts: ApiOptions) {
  const { db, token } = opts

  const authed = (req: IncomingMessage): boolean =>
    req.headers.authorization === `Bearer ${token}`

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type',
      })
      return res.end()
    }

    if (path === '/health') return json(res, 200, { ok: true, at: nowIso() })

    // The map image is fetched by an <img>, which cannot carry an
    // Authorization header, so this one route also accepts the token as a
    // query parameter. It is the same map RustMaps publishes for the seed —
    // nothing here is private — but it still needs a token so the endpoint
    // can't be used to probe which servers a deployment is watching.
    if (req.method === 'GET' && path.startsWith('/api/map/')) {
      const qToken = url.searchParams.get('token')
      if (!authed(req) && qToken !== token) return json(res, 401, { error: 'unauthorized' })
      const serverId = decodeURIComponent(path.slice('/api/map/'.length))
      const row = db.prepare(
        `SELECT map_image_path, map_source FROM servers WHERE id = ?`,
      ).get(serverId) as { map_image_path: string | null; map_source: string | null } | undefined
      if (!row?.map_image_path || !existsSync(row.map_image_path)) {
        return json(res, 404, { error: 'no map image for this server' })
      }
      const ext = row.map_image_path.split('.').pop()?.toLowerCase() ?? ''
      const type = ext === 'png' ? 'image/png'
        : ext === 'webp' ? 'image/webp'
        : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : 'application/octet-stream'
      const body = readFileSync(row.map_image_path)
      res.writeHead(200, {
        'content-type': type,
        'content-length': body.length,
        'access-control-allow-origin': '*',
        // Maps only change on wipe, and the path is wipe-stamped.
        'cache-control': 'public, max-age=86400',
        'x-nabrust-map-source': row.map_source ?? 'unknown',
      })
      return res.end(body)
    }

    if (!authed(req)) return json(res, 401, { error: 'unauthorized' })

    try {
      // --- agent ingest ---------------------------------------------------
      if (req.method === 'POST' && path === '/ingest/combatlog') {
        const body = JSON.parse(await readBody(req)) as {
          serverId: string; reporterId: string; text: string
        }
        if (!body.serverId || !body.reporterId || typeof body.text !== 'string') {
          return json(res, 400, { error: 'serverId, reporterId and text are required' })
        }
        const wipe = currentWipe(db, body.serverId)
        if (!wipe) return json(res, 409, { error: 'no open wipe for this server' })

        const report = ingestCombatLog(db, body.text, {
          serverId: body.serverId,
          wipeId: wipe.id,
          reporterId: body.reporterId,
          teamIds: opts.teamIds,
        })
        return json(res, 200, report)
      }

      if (req.method === 'POST' && path === '/ingest/positions') {
        const body = JSON.parse(await readBody(req)) as {
          serverId: string
          samples: { steamId: string; t: string; x: number; y: number }[]
        }
        const wipe = currentWipe(db, body.serverId)
        if (!wipe) return json(res, 409, { error: 'no open wipe for this server' })
        const stmt = db.prepare(
          `INSERT INTO position_samples (wipe_id, steam_id, t, x, y) VALUES (?, ?, ?, ?, ?)`,
        )
        for (const s of body.samples ?? []) stmt.run(wipe.id, s.steamId, s.t, s.x, s.y)
        return json(res, 200, { stored: body.samples?.length ?? 0 })
      }

      // --- reads ------------------------------------------------------------
      if (req.method === 'GET' && path === '/api/servers') {
        const rows = db.prepare(
          `SELECT s.id, s.name, s.seed, s.world_size, s.max_pop, s.rustplus_paired,
                  s.map_image_path, s.map_source, s.map_parsed_at,
                  w.id AS wipe_id, w.started_at AS wipe_started
             FROM servers s
             LEFT JOIN wipes w ON w.server_id = s.id AND w.ended_at IS NULL
            ORDER BY s.name`,
        ).all()
        // `servers` is the raw row view kept for scripts; `records` is the
        // shape the web app renders.
        return json(res, 200, { servers: rows, records: serverRecords(db) })
      }

      if (req.method === 'GET' && path.startsWith('/api/terrain/')) {
        const serverId = decodeURIComponent(path.slice('/api/terrain/'.length))
        const gridRes = Math.max(32, Math.min(256, Number(url.searchParams.get('res') ?? 128) || 128))
        const t = terrainFor(db, serverId, gridRes)
        if (!t) return json(res, 404, { error: 'no parsed world file for this server — run parse-map' })
        return json(res, 200, t)
      }

      if (req.method === 'GET' && path.startsWith('/api/dataset/')) {
        const serverId = decodeURIComponent(path.slice('/api/dataset/'.length))
        const ds = datasetFor(db, serverId, { teamIds: opts.teamIds })
        if (!ds) return json(res, 404, { error: 'unknown server' })
        return json(res, 200, ds)
      }

      if (req.method === 'GET' && path.startsWith('/api/status/')) {
        const serverId = decodeURIComponent(path.slice('/api/status/'.length))
        const st = statusFor(db, serverId, { teamIds: opts.teamIds })
        if (!st) return json(res, 404, { error: 'unknown server' })
        return json(res, 200, st)
      }

      // --- bases the team marks ---------------------------------------------
      if (path === '/api/bases' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 64 * 1024)) as BaseInput & { serverId?: string }
        if (!body.serverId) return json(res, 400, { error: 'serverId is required' })
        try {
          return json(res, 201, { id: createBase(db, body.serverId, body) })
        } catch (e) {
          if (e instanceof BaseInputError) return json(res, 400, { error: e.message })
          throw e
        }
      }
      const baseMatch = path.match(/^\/api\/bases\/([^/]+)$/)
      if (baseMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const id = decodeURIComponent(baseMatch[1])
        const serverId = url.searchParams.get('serverId')
        if (!serverId) return json(res, 400, { error: 'serverId query parameter is required' })
        if (req.method === 'DELETE') {
          return deleteBase(db, serverId, id) ? json(res, 200, { deleted: id }) : json(res, 404, { error: 'no such base' })
        }
        const body = JSON.parse(await readBody(req, 64 * 1024)) as BaseInput
        try {
          return updateBase(db, serverId, id, body) ? json(res, 200, { updated: id }) : json(res, 404, { error: 'no such base' })
        } catch (e) {
          if (e instanceof BaseInputError) return json(res, 400, { error: e.message })
          throw e
        }
      }

      // --- paired Rust+ devices ---------------------------------------------
      if (path === '/api/devices' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 16 * 1024)) as
          { serverId?: string; entityId?: number; kind?: string; name?: string | null }
        if (!body.serverId) return json(res, 400, { error: 'serverId is required' })
        const wipe = currentWipe(db, body.serverId)
        if (!wipe) return json(res, 404, { error: 'unknown server' })
        try {
          addDevice(db, body.serverId, wipe.id, {
            entityId: Number(body.entityId), kind: String(body.kind), name: body.name ?? null,
          })
          return json(res, 201, { entityId: Number(body.entityId) })
        } catch (e) {
          if (e instanceof DeviceError) return json(res, 400, { error: e.message })
          throw e
        }
      }

      const devMatch = path.match(/^\/api\/devices\/(\d+)$/)
      if (devMatch && req.method === 'DELETE') {
        const serverId = url.searchParams.get('serverId')
        if (!serverId) return json(res, 400, { error: 'serverId query parameter is required' })
        const wipe = currentWipe(db, serverId)
        if (!wipe) return json(res, 404, { error: 'unknown server' })
        return removeDevice(db, serverId, wipe.id, Number(devMatch[1]))
          ? json(res, 200, { removed: Number(devMatch[1]) })
          : json(res, 404, { error: 'no such device' })
      }

      const setMatch = path.match(/^\/api\/devices\/(\d+)\/set$/)
      if (setMatch && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 16 * 1024)) as { serverId?: string; value?: boolean }
        if (!body.serverId) return json(res, 400, { error: 'serverId is required' })
        if (!opts.setSwitch) {
          return json(res, 503, { error: 'Rust+ is not running in this process — start `nab serve`' })
        }
        try {
          await opts.setSwitch(body.serverId, Number(setMatch[1]), !!body.value)
          return json(res, 200, { entityId: Number(setMatch[1]), value: !!body.value })
        } catch (e) {
          return json(res, 503, { error: (e as Error).message })
        }
      }

      if (req.method === 'POST' && path === '/api/clans/rebuild') {
        const body = JSON.parse(await readBody(req)) as { serverId: string }
        return json(res, 200, rebuildClans(db, body.serverId))
      }

      return json(res, 404, { error: 'not found' })
    } catch (e) {
      // A malformed body is the caller's mistake, not ours.
      if (e instanceof SyntaxError) return json(res, 400, { error: 'request body is not valid JSON' })
      if ((e as Error).message === 'payload too large') return json(res, 413, { error: 'payload too large' })
      return json(res, 500, { error: (e as Error).message })
    }
  }

  const server = createServer((req, res) => { void handler(req, res) })
  return {
    server,
    handler,
    listen: () => new Promise<number>((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        reject(e.code === 'EADDRINUSE'
          ? new Error(`port ${opts.port ?? 8787} is already in use — is another \`nab serve\` running? Stop it or set PORT`)
          : e)
      })
      server.listen(opts.port ?? 8787, () => {
        const addr = server.address()
        resolve(typeof addr === 'object' && addr ? addr.port : (opts.port ?? 8787))
      })
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** The server-scoped payload the web app renders. */
/**
 * The server's full dataset in the shape the web app renders. Kept under its
 * old name for callers and tests; the work lives in dataset.ts.
 */
export function buildDataset(db: DB, serverId: string, teamIds?: string[]) {
  return datasetFor(db, serverId, { teamIds }) ?? { error: 'unknown server' }
}

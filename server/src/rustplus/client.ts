// ---------------------------------------------------------------------------
// Rust+ websocket client.
//
// Uses Node 22's global WebSocket, so still no dependencies. The socket talks
// to the port set as `app.port` in the server's config (28082 by default),
// which Facepunch's own companion app uses — nothing here touches the game
// client, its memory or its traffic.
//
// PAIRING: playerId is your 64-bit steam id and playerToken is issued when you
// pair from the in-game menu. Rust delivers that token as a push notification
// through Google FCM, so capturing it needs an FCM listener — the standard
// route is to pair once with an existing helper (rustplus.js's `fcm-listen`,
// or the Rust+ desktop app) and copy the four values into config. NABRust does
// not re-implement the Google sign-in dance.
//
// Rate limits are real and per-method; the client serialises requests and
// leaves a gap between them so a burst never trips the server's limiter.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events'
import {
  decodeMessage, encodeRequest,
  type AppBroadcast, type AppEntityInfo, type AppInfo, type AppMap, type AppMarker, type AppResponse,
  type AppTeamInfo, type AppTime, type Credentials, type RequestKind,
  type TeamMessage,
} from './messages.ts'

export interface RustPlusOptions {
  host: string
  port: number
  playerId: string | bigint
  playerToken: number
  /** Injected for tests; defaults to the global WebSocket. */
  webSocketImpl?: typeof WebSocket
  /** Minimum gap between outbound requests, ms. */
  minRequestGapMs?: number
  requestTimeoutMs?: number
  useSsl?: boolean
}

interface Pending {
  resolve: (r: AppResponse) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface RustPlusEvents {
  connected: []
  disconnected: [{ code: number; reason: string }]
  error: [Error]
  teamChanged: [AppTeamInfo]
  teamMessage: [TeamMessage]
  broadcast: [AppBroadcast]
}

export class RustPlusClient extends EventEmitter {
  private ws: WebSocket | null = null
  private seq = 1
  private pending = new Map<number, Pending>()
  private queue: Promise<unknown> = Promise.resolve()
  private lastSend = 0
  private closed = false

  private readonly cred: Credentials
  private readonly gap: number
  private readonly timeout: number

  private opts: RustPlusOptions

  constructor(opts: RustPlusOptions) {
    super()
    this.opts = opts
    this.cred = {
      playerId: BigInt(opts.playerId),
      playerToken: opts.playerToken,
    }
    this.gap = opts.minRequestGapMs ?? 250
    this.timeout = opts.requestTimeoutMs ?? 10_000
  }

  get url(): string {
    const scheme = this.opts.useSsl ? 'wss' : 'ws'
    return `${scheme}://${this.opts.host}:${this.opts.port}`
  }

  connect(): Promise<void> {
    const Impl = this.opts.webSocketImpl ?? globalThis.WebSocket
    if (!Impl) throw new Error('no WebSocket implementation (needs Node >= 22)')

    return new Promise((resolve, reject) => {
      const ws = new Impl(this.url)
      this.ws = ws
      ws.binaryType = 'arraybuffer'

      const onOpen = () => {
        this.emit('connected')
        resolve()
      }
      const onError = () => {
        const err = new Error(`rust+ connection failed: ${this.url}`)
        this.emit('error', err)
        reject(err)
      }

      ws.addEventListener('open', onOpen, { once: true })
      ws.addEventListener('error', onError, { once: true })

      ws.addEventListener('message', (ev: MessageEvent) => {
        try {
          this.handle(toBytes(ev.data))
        } catch (e) {
          this.emit('error', e as Error)
        }
      })

      ws.addEventListener('close', (ev: CloseEvent) => {
        this.failAllPending(new Error('socket closed'))
        this.emit('disconnected', { code: ev.code, reason: ev.reason })
      })
    })
  }

  private handle(bytes: Uint8Array): void {
    const msg = decodeMessage(bytes)

    if (msg.response) {
      const p = this.pending.get(msg.response.seq)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(msg.response.seq)
        if (msg.response.error) p.reject(new Error(msg.response.error))
        else p.resolve(msg.response)
      }
    }

    if (msg.broadcast) {
      this.emit('broadcast', msg.broadcast)
      if (msg.broadcast.teamChanged) this.emit('teamChanged', msg.broadcast.teamChanged.teamInfo)
      if (msg.broadcast.teamMessage) this.emit('teamMessage', msg.broadcast.teamMessage)
      if (msg.broadcast.entityChanged) this.emit('entityChanged', msg.broadcast.entityChanged)
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /** Requests are serialised and spaced — bursts trip the server's limiter. */
  private send(
    kind: RequestKind,
    payload?: { message?: string; entityId?: number; value?: boolean },
  ): Promise<AppResponse> {
    const run = async (): Promise<AppResponse> => {
      if (this.closed) throw new Error('client closed')
      const ws = this.ws
      if (!ws || ws.readyState !== 1) throw new Error('not connected')

      const wait = this.gap - (Date.now() - this.lastSend)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      this.lastSend = Date.now()

      const seq = this.seq++
      const bytes = encodeRequest(seq, this.cred, kind, payload)

      return new Promise<AppResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(seq)
          reject(new Error(`rust+ ${kind} timed out`))
        }, this.timeout)
        this.pending.set(seq, { resolve, reject, timer })
        ws.send(bytes as Uint8Array<ArrayBuffer>)
      })
    }

    const next = this.queue.then(run, run)
    // Keep the chain alive even when a request rejects.
    this.queue = next.catch(() => undefined)
    return next
  }

  async getInfo(): Promise<AppInfo> {
    const r = await this.send('getInfo')
    if (!r.info) throw new Error('no info in response')
    return r.info
  }

  async getTime(): Promise<AppTime> {
    const r = await this.send('getTime')
    if (!r.time) throw new Error('no time in response')
    return r.time
  }

  async getTeamInfo(): Promise<AppTeamInfo> {
    const r = await this.send('getTeamInfo')
    if (!r.teamInfo) throw new Error('no teamInfo in response')
    return r.teamInfo
  }

  /** Expensive — the payload carries the full map JPEG. Call once per wipe. */
  async getMap(): Promise<AppMap> {
    const r = await this.send('getMap')
    if (!r.map) throw new Error('no map in response')
    return r.map
  }

  /** Cargo, heli, Chinook, crates, explosions — polled to detect events. */
  async getMapMarkers(): Promise<AppMarker[]> {
    const r = await this.send('getMapMarkers')
    return r.mapMarkers ?? []
  }

  async getTeamChat(): Promise<TeamMessage[]> {
    const r = await this.send('getTeamChat')
    return r.teamChat ?? []
  }

  /**
   * State of one paired device (smart switch, smart alarm, storage monitor).
   * The entity id comes from pairing that device in game.
   */
  async getEntityInfo(entityId: number): Promise<AppEntityInfo> {
    const r = await this.send('getEntityInfo', { entityId })
    if (!r.entityInfo) throw new Error('no entityInfo in response')
    return r.entityInfo
  }

  /** Flip a smart switch. Alarms and storage monitors ignore this. */
  async setEntityValue(entityId: number, value: boolean): Promise<void> {
    await this.send('setEntityValue', { entityId, value })
  }

  /** Ask the server to push entityChanged broadcasts for this device. */
  async setSubscription(entityId: number, value = true): Promise<void> {
    await this.send('setSubscription', { entityId, value })
  }

  async checkSubscription(entityId: number): Promise<boolean> {
    const r = await this.send('checkSubscription', { entityId })
    return r.flag ?? false
  }

  /**
   * The server-side clan you belong to, when the server runs clans. Rust+
   * only ever returns your own clan, never anyone else's.
   */
  async getClanInfo(): Promise<{ name: string; members: number } | null> {
    const r = await this.send('getClanInfo')
    return r.clanInfo ?? null
  }

  async sendTeamMessage(message: string): Promise<void> {
    // In-game chat has a length cap; long answers belong on the dashboard.
    await this.send('sendTeamMessage', { message: message.slice(0, 250) })
  }

  close(): void {
    this.closed = true
    this.failAllPending(new Error('client closed'))
    this.ws?.close()
    this.ws = null
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  }
  if (typeof data === 'string') return Buffer.from(data, 'binary')
  throw new Error('unexpected websocket payload')
}

/**
 * Reconnecting wrapper. Rust+ sockets drop on server restarts and lag spikes,
 * and a collector that gives up on the first blip is useless overnight.
 */
export async function connectWithRetry(
  opts: RustPlusOptions,
  hooks: {
    onConnect?: (c: RustPlusClient) => void | Promise<void>
    onError?: (e: Error) => void
    maxDelayMs?: number
  } = {},
): Promise<{ stop: () => void }> {
  let stopped = false
  let client: RustPlusClient | null = null
  let delay = 1000
  const maxDelay = hooks.maxDelayMs ?? 60_000

  const attempt = async (): Promise<void> => {
    if (stopped) return
    client = new RustPlusClient(opts)
    client.on('error', (e) => hooks.onError?.(e))
    client.once('disconnected', () => {
      if (!stopped) setTimeout(attempt, delay)
    })
    try {
      await client.connect()
      delay = 1000 // reset backoff on a good connection
      await hooks.onConnect?.(client)
    } catch (e) {
      hooks.onError?.(e as Error)
      delay = Math.min(delay * 2, maxDelay)
      if (!stopped) setTimeout(attempt, delay)
    }
  }

  void attempt()
  return {
    stop: () => {
      stopped = true
      client?.close()
    },
  }
}

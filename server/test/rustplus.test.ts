// ---------------------------------------------------------------------------
// Rust+ and Battlemetrics tests. Fully offline: the websocket and fetch are
// both injected, so these exercise the real codec and sync logic without
// touching the network.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, nowIso } from '../src/db/index.ts'
import { Reader, Writer, asNumber, asString } from '../src/rustplus/protobuf.ts'
import {
  decodeMessage, encodeRequest, formatGameTime, isNight, minutesUntil,
} from '../src/rustplus/messages.ts'
import { RustPlusClient } from '../src/rustplus/client.ts'
import { startRustPlus } from '../src/rustplus/runtime.ts'
import { syncMap, syncServerInfo, syncTeam, syncMapNotes } from '../src/rustplus/sync.ts'
import { handleCommand, isCommand } from '../src/rustplus/commands.ts'
import { extractServerInfo, reconcileBmIdentity, recordSnapshot } from '../src/collectors/battlemetrics.ts'
import { currentWipe } from '../src/retention.ts'
import { observeName } from '../src/identity.ts'
import { addEvidence } from '../src/pairs.ts'
import { sessionOverlapEvidence, onsetEvidence } from '../../shared/inference/clanEvidence.ts'
import { rustPlusToNorm } from '../../shared/world.ts'

export function run(test: (name: string, fn: () => void | Promise<void>) => void) {
  const ME = '76561198000000001'
  const MATE = '76561198000000002'

  const freshDb = () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO servers (id, name, seed, world_size, created_at) VALUES (?,?,?,?,?)`)
      .run('srv', 'TEST', 1994823, 4250, nowIso())
    db.prepare(`INSERT INTO wipes (server_id, started_at, seed, world_size) VALUES (?,?,?,?)`)
      .run('srv', '2026-09-16T00:00:00Z', 1994823, 4250)
    return db
  }

  console.log('\nprotobuf codec')

  test('varint round-trips including multi-byte values', () => {
    for (const v of [0, 1, 127, 128, 300, 16384, 1_000_000, 2 ** 31]) {
      const buf = new Writer().uint32Always(1, v).finish()
      const f = new Reader(buf).next()
      assert.equal(asNumber(f), v, `failed for ${v}`)
    }
  })

  test('negative int32 survives the round trip', () => {
    // playerToken is int32 and routinely negative — this is the classic bug.
    const buf = new Writer().int32(3, -1717986918).finish()
    const f = new Reader(buf).next()
    const signed = Number(BigInt.asIntN(32, BigInt.asIntN(64, f.varint!)))
    assert.equal(signed, -1717986918)
    assert.ok(buf.length >= 10, 'negative int32 must be sign-extended to 10 bytes')
  })

  test('uint64 steam ids keep full precision', () => {
    const id = 76561198000000042n
    const buf = new Writer().uint64(2, id).finish()
    assert.equal(new Reader(buf).next().varint, id)
  })

  test('floats round-trip at 32-bit precision', () => {
    const buf = new Writer().float(3, 1234.5).finish()
    assert.equal(new Reader(buf).next().float, 1234.5)
  })

  test('strings and nested messages decode', () => {
    const buf = new Writer()
      .message(1, (m) => m.string(2, 'EXAMPLE · TRIO').uint32(5, 4250))
      .finish()
    const outer = new Reader(buf).next()
    const inner = new Reader(outer.bytes!)
    const fields: Record<number, unknown> = {}
    inner.each((f) => { fields[f.field] = f.bytes ? asString(f) : asNumber(f) })
    assert.equal(fields[2], 'EXAMPLE · TRIO')
    assert.equal(fields[5], 4250)
  })

  test('encodeRequest places the right field for each method', () => {
    const cred = { playerId: 76561198000000001n, playerToken: -5 }
    const seen = (kind: Parameters<typeof encodeRequest>[2]) => {
      const buf = encodeRequest(7, cred, kind)
      const fields: number[] = []
      new Reader(buf).each((f) => fields.push(f.field))
      return fields
    }
    assert.ok(seen('getInfo').includes(8))
    assert.ok(seen('getTime').includes(9))
    assert.ok(seen('getMap').includes(10))
    assert.ok(seen('getTeamInfo').includes(11))
    assert.ok(seen('getMapMarkers').includes(18))
    // seq, playerId and playerToken are always present
    assert.ok(seen('getInfo').includes(1) && seen('getInfo').includes(2) && seen('getInfo').includes(3))
  })

  console.log('\nrust+ message decoding')

  // Build a server-shaped AppMessage the way the game would.
  const encodeAppInfo = (seq: number) =>
    new Writer().message(1, (resp) => {
      resp.uint32Always(1, seq)
      resp.message(6, (info) => {
        info.string(1, 'EXAMPLE · TRIO')
        info.string(4, 'Procedural Map')
        info.uint32(5, 4250)
        info.uint32(6, 1789000000)
        info.uint32(7, 182)
        info.uint32(8, 250)
        info.uint32(10, 1994823)
      })
    }).finish()

  test('decodes AppInfo including seed and wipe time', () => {
    const msg = decodeMessage(encodeAppInfo(1))
    assert.equal(msg.response?.seq, 1)
    assert.equal(msg.response?.info?.name, 'EXAMPLE · TRIO')
    assert.equal(msg.response?.info?.seed, 1994823)
    assert.equal(msg.response?.info?.mapSize, 4250)
    assert.equal(msg.response?.info?.players, 182)
    assert.equal(msg.response?.info?.wipeTime, 1789000000)
  })

  test('decodes AppTeamInfo with float positions and liveness', () => {
    const buf = new Writer().message(1, (resp) => {
      resp.uint32Always(1, 2)
      resp.message(9, (team) => {
        team.uint64(1, 76561198000000001n)
        team.message(2, (m) => {
          m.uint64(1, 76561198000000001n)
          m.string(2, 'nomad')
          m.float(3, 2125)
          m.float(4, 3187.5)
          m.bool(5, true)
          m.bool(7, true)
        })
        team.message(2, (m) => {
          m.uint64(1, 76561198000000002n)
          m.string(2, 'ridgeline')
          m.float(3, 1000)
          m.float(4, 500)
          m.bool(5, true)
          m.bool(7, false)   // dead
        })
      })
    }).finish()

    const info = decodeMessage(buf).response?.teamInfo
    assert.equal(info?.members.length, 2)
    assert.equal(info?.members[0].name, 'nomad')
    assert.equal(info?.members[0].x, 2125)
    assert.equal(info?.members[0].isAlive, true)
    assert.equal(info?.members[1].isAlive, false)
    assert.equal(info?.leaderSteamId, '76561198000000001')
  })

  test('an error response decodes as an error', () => {
    const buf = new Writer().message(1, (resp) => {
      resp.uint32Always(1, 3)
      resp.message(5, (err) => err.string(1, 'not_found'))
    }).finish()
    assert.equal(decodeMessage(buf).response?.error, 'not_found')
  })

  test('unknown fields are skipped rather than throwing', () => {
    // A future game update adding a field must not break the client.
    const buf = new Writer().message(1, (resp) => {
      resp.uint32Always(1, 4)
      resp.string(99, 'something new')
      resp.message(6, (info) => info.string(1, 'still works'))
    }).finish()
    assert.equal(decodeMessage(buf).response?.info?.name, 'still works')
  })

  console.log('\nrust+ client')

  /** Fake socket that answers getInfo the way the server would. */
  class FakeSocket extends EventEmitter {
    readyState = 1
    binaryType = 'arraybuffer'
    sent: Uint8Array[] = []
    url: string
    constructor(url: string) {
      super()
      this.url = url
      setTimeout(() => this.dispatch('open', {}), 0)
    }
    addEventListener(type: string, fn: (ev: unknown) => void, opts?: { once?: boolean }) {
      if (opts?.once) this.once(type, fn as never)
      else this.on(type, fn as never)
    }
    dispatch(type: string, ev: unknown) { this.emit(type, ev) }
    send(data: Uint8Array) {
      this.sent.push(data)
      let seq = 0
      new Reader(data).each((f) => { if (f.field === 1) seq = asNumber(f) })
      setTimeout(() => {
        this.dispatch('message', { data: encodeAppInfo(seq).buffer })
      }, 1)
    }
    close() { this.readyState = 3; this.dispatch('close', { code: 1000, reason: 'bye' }) }
  }

  test('client correlates a response to its request by seq', async () => {
    const client = new RustPlusClient({
      host: '127.0.0.1', port: 28082,
      playerId: '76561198000000001', playerToken: -5,
      webSocketImpl: FakeSocket as unknown as typeof WebSocket,
      minRequestGapMs: 0,
    })
    await client.connect()
    const info = await client.getInfo()
    assert.equal(info.seed, 1994823)
    assert.equal(info.name, 'EXAMPLE · TRIO')
    client.close()
  })

  test('concurrent requests each get their own answer', async () => {
    const client = new RustPlusClient({
      host: '127.0.0.1', port: 28082,
      playerId: '76561198000000001', playerToken: -5,
      webSocketImpl: FakeSocket as unknown as typeof WebSocket,
      minRequestGapMs: 0,
    })
    await client.connect()
    const [a, b, c] = await Promise.all([client.getInfo(), client.getInfo(), client.getInfo()])
    assert.equal(a.seed, 1994823)
    assert.equal(b.seed, 1994823)
    assert.equal(c.seed, 1994823)
    client.close()
  })

  test('a pending request rejects when the socket closes', async () => {
    class DeadSocket extends FakeSocket {
      send() { setTimeout(() => this.close(), 1) }
    }
    const client = new RustPlusClient({
      host: '127.0.0.1', port: 28082,
      playerId: '1', playerToken: 1,
      webSocketImpl: DeadSocket as unknown as typeof WebSocket,
      minRequestGapMs: 0,
    })
    await client.connect()
    await assert.rejects(() => client.getInfo(), /socket closed/)
  })

  console.log('\nin-game time')

  test('formats time and detects night', () => {
    assert.equal(formatGameTime(12.5), '12:30')
    assert.equal(formatGameTime(21.25), '21:15')
    const t = { dayLengthMinutes: 60, timeScale: 1, sunrise: 7, sunset: 20, time: 21 }
    assert.equal(isNight(t), true)
    assert.equal(isNight({ ...t, time: 12 }), false)
    // 21:00 -> sunrise at 07:00 is 10 in-game hours = ~25 real minutes
    assert.ok(Math.abs(minutesUntil(t, t.sunrise) - 25) < 1)
  })

  console.log('\nrust+ sync')

  test('coordinates convert from Rust+ bottom-left origin', () => {
    // Rust+ reports 0..mapSize with y increasing north.
    const mid = rustPlusToNorm({ x: 2125, y: 2125 }, 4250)
    assert.equal(mid.x, 0.5)
    assert.equal(mid.y, 0.5)
    const topLeft = rustPlusToNorm({ x: 0, y: 4250 }, 4250)
    assert.equal(topLeft.x, 0)
    assert.equal(topLeft.y, 0, 'north should map to the top of the image')
  })

  test('server info updates the server and keeps the wipe', () => {
    const db = freshDb()
    const r = syncServerInfo(db, 'srv', {
      name: 'EXAMPLE · TRIO', map: 'Procedural Map', mapSize: 4250,
      wipeTime: Math.floor(Date.parse('2026-09-16T00:00:00Z') / 1000),
      players: 182, maxPlayers: 250, queuedPlayers: 0, seed: 1994823, salt: 0,
      url: '', headerImage: '',
    })
    assert.equal(r.wiped, false)
    const s = db.prepare(`SELECT seed, world_size, rustplus_paired FROM servers WHERE id='srv'`)
      .get() as { seed: number; world_size: number; rustplus_paired: number }
    assert.equal(s.seed, 1994823)
    assert.equal(s.world_size, 4250)
    assert.equal(s.rustplus_paired, 1)
  })

  test('a new seed from Rust+ triggers a rollover', () => {
    const db = freshDb()
    const before = currentWipe(db, 'srv')!.id
    const r = syncServerInfo(db, 'srv', {
      name: 'x', map: '', mapSize: 3500, wipeTime: Math.floor(Date.now() / 1000),
      players: 0, maxPlayers: 0, queuedPlayers: 0, seed: 777777, salt: 0,
      url: '', headerImage: '',
    })
    assert.equal(r.wiped, true)
    assert.match(r.reason!, /seed changed/)
    assert.notEqual(r.wipeId, before)
    const s = db.prepare(`SELECT seed, map_image_path FROM servers WHERE id='srv'`)
      .get() as { seed: number; map_image_path: string | null }
    assert.equal(s.seed, 777777)
    assert.equal(s.map_image_path, null, 'the old map must not survive a new seed')
  })

  test('the real map image is written and flips the source off placeholder', () => {
    const db = freshDb()
    const dir = mkdtempSync(join(tmpdir(), 'nab-'))
    const wipe = currentWipe(db, 'srv')!
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

    const r = syncMap(db, 'srv', {
      width: 2000, height: 2000, jpgImage: jpg, oceanMargin: 500, background: '#000',
      monuments: [
        { token: 'launchsite', x: 2125, y: 2125 },
        { token: 'bandit_camp', x: 1000, y: 3000 },
      ],
    }, { dataDir: dir, worldSize: 4250, wipeId: wipe.id })

    assert.equal(r.monuments, 2)
    assert.deepEqual(Uint8Array.from(readFileSync(r.imagePath)), jpg)

    const s = db.prepare(`SELECT map_source, map_image_path FROM servers WHERE id='srv'`)
      .get() as { map_source: string; map_image_path: string }
    assert.equal(s.map_source, 'rustplus')
    assert.ok(s.map_image_path.endsWith('.jpg'))

    const mons = db.prepare(`SELECT name, kind, x, y FROM monuments WHERE wipe_id = ?`)
      .all(wipe.id) as { name: string; kind: string; x: number; y: number }[]
    const bandit = mons.find((m) => m.name.toLowerCase().includes('bandit'))
    assert.equal(bandit?.kind, 'safezone', 'safe zones should be classified')
    const launch = mons.find((m) => m.name.toLowerCase().includes('launch'))
    assert.equal(launch?.x, 0.5)
  })

  test('team sync stores positions and detects a death without anyone reporting it', () => {
    const db = freshDb()
    const wipe = currentWipe(db, 'srv')!
    const member = (alive: boolean) => ({
      steamId: MATE, name: 'ridgeline', x: 1000, y: 500,
      isOnline: true, spawnTime: 0, isAlive: alive, deathTime: 0,
    })

    // first sample: alive
    let r = syncTeam(db, 'srv', wipe.id, {
      leaderSteamId: ME, members: [member(true)], mapNotes: [], leaderMapNotes: [],
    }, { worldSize: 4250 })
    assert.equal(r.positions, 1)
    assert.equal(r.deaths.length, 0)

    // second sample: dead -> transition detected
    r = syncTeam(db, 'srv', wipe.id, {
      leaderSteamId: ME, members: [member(false)], mapNotes: [], leaderMapNotes: [],
    }, { worldSize: 4250 })
    assert.equal(r.deaths.length, 1)
    assert.equal(r.deaths[0].name, 'ridgeline')

    // staying dead must not re-fire
    r = syncTeam(db, 'srv', wipe.id, {
      leaderSteamId: ME, members: [member(false)], mapNotes: [], leaderMapNotes: [],
    }, { worldSize: 4250 })
    assert.equal(r.deaths.length, 0, 'death should fire once, not every poll')
  })

  test('in-game map notes become base records with no typing', () => {
    const db = freshDb()
    const wipe = currentWipe(db, 'srv')!
    const n = syncMapNotes(db, wipe.id, [
      { type: 1, x: 2000, y: 2000, icon: 3, colourIndex: 1, label: 'RAT main' },
      { type: 1, x: 900, y: 1200, icon: 3, colourIndex: 2, label: 'farm base' },
      { type: 1, x: 10, y: 10, icon: 0, colourIndex: 0, label: '' }, // unlabelled, ignored
    ], 4250)
    assert.equal(n, 2)
    const bases = db.prepare(`SELECT grid, reported_by FROM bases`).all() as
      { grid: string; reported_by: string }[]
    assert.equal(bases.length, 2)
    assert.equal(bases[0].reported_by, 'map-note')
    const obs = db.prepare(`SELECT note FROM base_observations`).all() as { note: string }[]
    assert.ok(obs.some((o) => o.note === 'RAT main'))
  })

  console.log('\nin-game commands')

  test('only /nab messages are treated as commands', () => {
    assert.equal(isCommand('/nab who rat'), true)
    assert.equal(isCommand('hey where are you'), false)
  })

  test('who reports hours, renames and who they run with', () => {
    const db = freshDb()
    const A = '76561198000000042', B = '76561198000000043'
    observeName(db, A, 'tomato', 'battlemetrics', '2026-08-01T00:00:00Z')
    observeName(db, A, 'RATatouille', 'combatlog', '2026-09-17T00:00:00Z')
    observeName(db, B, 'slug_king', 'combatlog')
    db.prepare(`UPDATE players SET hours_played = 5840 WHERE steam_id = ?`).run(A)
    addEvidence(db, 'srv', A, B, sessionOverlapEvidence(1980, 2100, 2220, nowIso()))
    addEvidence(db, 'srv', A, B, onsetEvidence(1.2, nowIso()))

    const reply = handleCommand(
      { db, serverId: 'srv', senderId: ME, worldSize: 4250 },
      '/nab who RATat',
    )!
    assert.match(reply, /RATatouille/)
    assert.match(reply, /5,840h/)
    assert.match(reply, /aka tomato/)
    assert.match(reply, /slug_king/)
  })

  test('who is honest when nothing is known', () => {
    const db = freshDb()
    const reply = handleCommand(
      { db, serverId: 'srv', senderId: ME, worldSize: 4250 }, '/nab who nobody',
    )!
    assert.match(reply, /no player matching/)
  })

  test('time reports day or night with a countdown', () => {
    const db = freshDb()
    const reply = handleCommand({
      db, serverId: 'srv', senderId: ME, worldSize: 4250,
      time: { dayLengthMinutes: 60, timeScale: 1, sunrise: 7, sunset: 20, time: 21 },
    }, '/nab time')!
    assert.match(reply, /night/)
    assert.match(reply, /sunrise in/)
  })

  test('base marks at the sender position', () => {
    const db = freshDb()
    const reply = handleCommand({
      db, serverId: 'srv', senderId: ME, worldSize: 4250,
      senderPos: { x: 0.5, y: 0.5 },
    }, '/nab base rat main')!
    assert.match(reply, /base marked at/)
    const b = db.prepare(`SELECT status, grid FROM bases`).get() as { status: string; grid: string }
    assert.equal(b.status, 'confirmed')
  })

  test('unknown commands are answered, not ignored', () => {
    const db = freshDb()
    const reply = handleCommand({ db, serverId: 'srv', senderId: ME, worldSize: 4250 }, '/nab wat')!
    assert.match(reply, /unknown command/)
  })

  console.log('\nrust+ runtime (end to end)')

  test('runtime pulls the map, records positions and answers in chat', async () => {
    const db = freshDb()
    const dir = mkdtempSync(join(tmpdir(), 'nab-rt-'))
    const replies: string[] = []
    const alerts: string[] = []

    // A fake Rust+ server that answers each request type the way the game does.
    class FakeServer extends EventEmitter {
      readyState = 1
      binaryType = 'arraybuffer'
      url: string
      constructor(url: string) {
        super()
        this.url = url
        setTimeout(() => this.emit('open', {}), 0)
      }
      addEventListener(t: string, f: (ev: unknown) => void, o?: { once?: boolean }) {
        if (o?.once) this.once(t, f as never); else this.on(t, f as never)
      }
      close() { this.readyState = 3; this.emit('close', { code: 1000, reason: '' }) }
      send(data: Uint8Array) {
        let seq = 0
        const kinds: number[] = []
        new Reader(data).each((f) => {
          if (f.field === 1) seq = asNumber(f)
          if (f.field >= 8) kinds.push(f.field)
          if (f.field === 13) {
            new Reader(f.bytes!).each((g) => {
              if (g.field === 1) replies.push(Buffer.from(g.bytes!).toString('utf8'))
            })
          }
        })
        const k = kinds[0]
        const buf = new Writer().message(1, (r) => {
          r.uint32Always(1, seq)
          if (k === 8) {
            r.message(6, (i) => {
              i.string(1, 'FAKE RUST').string(4, 'Procedural Map').uint32(5, 4250)
                .uint32(6, Math.floor(Date.parse('2026-09-16T00:00:00Z') / 1000))
                .uint32(7, 150).uint32(8, 250).uint32(10, 1994823)
            })
          } else if (k === 9) {
            r.message(7, (t) => { t.float(1, 60).float(2, 1).float(3, 7).float(4, 20).float(5, 19.9) })
          } else if (k === 10) {
            r.message(8, (m) => {
              m.uint32(1, 2000).uint32(2, 2000)
                .bytes(3, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))
                .message(5, (mo) => mo.string(1, 'launchsite').float(2, 2125).float(3, 2125))
            })
          } else if (k === 11) {
            r.message(9, (t) => {
              t.uint64(1, BigInt(ME))
                .message(2, (m) => m.uint64(1, BigInt(ME)).string(2, 'nomad')
                  .float(3, 1000).float(4, 2000).bool(5, true).bool(7, true))
                .message(3, (n) => n.float(3, 3000).float(4, 1500).string(7, 'RAT main'))
            })
          } else {
            r.message(4, () => {})
          }
        }).finish()
        setTimeout(() => this.emit('message', {
          data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        }), 1)
      }
    }

    const handle = startRustPlus({
      db, serverId: 'srv', host: '127.0.0.1', port: 28082,
      playerId: ME, playerToken: -1717986918, dataDir: dir,
      webSocketImpl: FakeServer as unknown as typeof WebSocket,
      onAlert: (a) => alerts.push(a.kind),
      intervals: { time: 60_000, team: 60_000, info: 600_000 },
    })

    // Requests are deliberately spaced, so allow the opening sequence to run.
    await new Promise((r) => setTimeout(r, 1500))

    const srv = db.prepare(`SELECT map_source, map_image_path FROM servers WHERE id='srv'`)
      .get() as { map_source: string | null; map_image_path: string | null }
    assert.equal(srv.map_source, 'rustplus', 'the real map should replace the placeholder')
    assert.ok(srv.map_image_path, 'map image should be on disk')

    const pos = db.prepare(`SELECT COUNT(*) AS n FROM position_samples`).get() as { n: number }
    assert.ok(pos.n >= 1, 'our own positions feed the retracer')

    const base = db.prepare(`SELECT reported_by FROM bases`).get() as { reported_by: string } | undefined
    assert.equal(base?.reported_by, 'map-note', 'in-game notes become base records')

    assert.ok(alerts.includes('map'))
    assert.ok(alerts.includes('night'), 'nightfall should warn once')
    assert.ok(replies.some((r) => /Nightfall/i.test(r)), 'warning should reach team chat')

    handle.stop()
  })

  console.log('\nbattlemetrics')

  test('extracts rust details tolerantly and reports the keys it saw', () => {
    const info = extractServerInfo({
      data: {
        attributes: {
          name: 'EXAMPLE · TRIO', players: 182, maxPlayers: 250, status: 'online',
          details: {
            rust_world_seed: '1994823',
            rust_world_size: '4250',
            rust_last_wipe: '2026-09-16T19:00:00.000Z',
            official: true,
          },
        },
      },
    })
    assert.equal(info.seed, 1994823)
    assert.equal(info.worldSize, 4250)
    assert.equal(info.official, true)
    assert.ok(info.detailKeys.includes('rust_world_seed'))
  })

  test('a renamed upstream key yields null rather than a wrong number', () => {
    const info = extractServerInfo({
      data: { attributes: { name: 'x', details: { something_else: 5 } } },
    })
    assert.equal(info.seed, null)
    assert.equal(info.worldSize, null)
    assert.deepEqual(info.detailKeys, ['something_else'])
  })

  test('players without a steam id are kept under a bm: key, then reconciled', () => {
    const db = freshDb()
    recordSnapshot(db, 'srv', null, [
      { steamId: 'bm:12345', name: 'mystery', steamIdKnown: false },
    ], '2026-09-20T18:00:00Z')

    let sess = db.prepare(`SELECT steam_id FROM sessions`).get() as { steam_id: string }
    assert.equal(sess.steam_id, 'bm:12345')

    // The combat log later reveals the real id.
    const merged = reconcileBmIdentity(db, '12345', '76561198000000077')
    assert.equal(merged, true)

    sess = db.prepare(`SELECT steam_id FROM sessions`).get() as { steam_id: string }
    assert.equal(sess.steam_id, '76561198000000077', 'session history must follow the identity')
    const stale = db.prepare(`SELECT COUNT(*) AS n FROM players WHERE steam_id LIKE 'bm:%'`)
      .get() as { n: number }
    assert.equal(stale.n, 0, 'placeholder identity should be gone')
  })

  test('rate limiter and retries are exercised on 429', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      if (calls === 1) {
        return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      }
      return new Response(JSON.stringify({ data: { attributes: { name: 'ok', details: {} } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const { fetchServerInfo } = await import('../src/collectors/battlemetrics.ts')
    const info = await fetchServerInfo('1', { token: 't', baseUrl: 'https://x.test', fetchImpl })
    assert.equal(info.name, 'ok')
    assert.equal(calls, 2, 'should retry once after a 429')
  })
}
